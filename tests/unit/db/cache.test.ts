import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheKeyFor, contextHash, createTicketCache } from '../../../src/db/ticket-cache.js';
import { runPipeline, type TicketCache } from '../../../src/pipeline/run.js';
import { openPglite } from '../../../src/db/pglite.js';
import { migrate } from '../../../src/db/migrate.js';
import { Repository } from '../../../src/db/repository.js';
import type { Db } from '../../../src/db/types.js';
import { makeTicket, scriptedAI } from '../pipeline/support.js';

const identity = { promptVersion: 'v2', model: 'model-a', selfReview: true };
const updated = (value: string) => ({ key: 'SHP-1', updated: value });

describe('cacheKeyFor', () => {
  const base = cacheKeyFor(updated('2026-10-01T10:00:00.000+0100'), {}, identity);

  it('is the same for the same ticket, version, model and context', () => {
    expect(cacheKeyFor(updated('2026-10-01T10:00:00.000+0100'), {}, identity)).toBe(base);
  });

  it('changes when the ticket changed in Jira', () => {
    expect(cacheKeyFor(updated('2026-10-02T09:00:00.000+0100'), {}, identity)).not.toBe(base);
  });

  it('changes with the prompt version, the model and the review setting', () => {
    const time = '2026-10-01T10:00:00.000+0100';
    expect(cacheKeyFor(updated(time), {}, { ...identity, promptVersion: 'v3' })).not.toBe(base);
    expect(cacheKeyFor(updated(time), {}, { ...identity, model: 'model-b' })).not.toBe(base);
    expect(cacheKeyFor(updated(time), {}, { ...identity, selfReview: false })).not.toBe(base);
  });

  it('changes when the knowledge or the code context changes', () => {
    const time = '2026-10-01T10:00:00.000+0100';
    expect(cacheKeyFor(updated(time), { moduleNotes: 'new note' }, identity)).not.toBe(base);
    expect(cacheKeyFor(updated(time), { codeChanges: 'a diff' }, identity)).not.toBe(base);
  });

  it('is different for another ticket with the same update time', () => {
    const time = '2026-10-01T10:00:00.000+0100';
    expect(cacheKeyFor({ key: 'SHP-2', updated: time }, {}, identity)).not.toBe(base);
  });

  it('has no key for a ticket whose last change time is unknown', () => {
    expect(cacheKeyFor({ key: 'SHP-1' }, {}, identity)).toBeUndefined();
  });
});

describe('contextHash', () => {
  it('treats missing and empty context the same', () => {
    expect(contextHash({})).toBe(contextHash({ moduleNotes: '', pastCases: [], codeChanges: '' }));
  });

  it('does not depend on the order the fields were written in', () => {
    expect(contextHash({ moduleNotes: 'a', codeChanges: 'b' })).toBe(
      contextHash({ codeChanges: 'b', moduleNotes: 'a' }),
    );
  });

  it('changes when a past case changes', () => {
    expect(contextHash({ pastCases: ['one'] })).not.toBe(contextHash({ pastCases: ['two'] }));
  });
});

describe('the pipeline with a result cache', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openPglite();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  const setup = async () => {
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const repo = new Repository(db);
    return { repo, cache: createTicketCache(repo, identity) };
  };

  const ticket = (key: string, time = '2026-10-01T10:00:00.000+0100') =>
    makeTicket(key, { updated: time });

  it('does not call the AI again for a ticket that has not changed', async () => {
    const { cache } = await setup();
    const first = scriptedAI();
    await runPipeline(first, [ticket('SHP-1'), ticket('SHP-2')], { cache });

    const second = scriptedAI();
    const result = await runPipeline(second, [ticket('SHP-1'), ticket('SHP-2')], { cache });

    expect(second.requests).toHaveLength(1); // only the flow request
    expect(second.callsFor('SHP-1')).toBe(0);
    expect(result.tickets.every((t) => t.cached === true)).toBe(true);
    expect(result.cases).toHaveLength(4);
  });

  it('gives the same cases from the cache as from the AI', async () => {
    const { cache } = await setup();
    const fresh = await runPipeline(scriptedAI(), [ticket('SHP-1')], { cache });

    const cached = await runPipeline(scriptedAI(), [ticket('SHP-1')], { cache });

    const shape = (r: typeof fresh) => r.cases.map((c) => [c.id, c.title, c.expected, c.grounding]);
    expect(shape(cached)).toEqual(shape(fresh));
  });

  it('asks the AI again for a ticket that changed in Jira', async () => {
    const { cache } = await setup();
    await runPipeline(scriptedAI(), [ticket('SHP-1'), ticket('SHP-2')], { cache });

    const second = scriptedAI();
    const result = await runPipeline(
      second,
      [ticket('SHP-1'), ticket('SHP-2', '2026-10-05T08:00:00.000+0100')],
      { cache },
    );

    expect(second.callsFor('SHP-1')).toBe(0);
    expect(second.callsFor('SHP-2')).toBeGreaterThan(0);
    expect(result.tickets.map((t) => t.cached)).toEqual([true, undefined]);
  });

  it('asks the AI again when the prompt version changed', async () => {
    const { repo } = await setup();
    await runPipeline(scriptedAI(), [ticket('SHP-1')], {
      cache: createTicketCache(repo, identity),
    });

    const second = scriptedAI();
    await runPipeline(second, [ticket('SHP-1')], {
      cache: createTicketCache(repo, { ...identity, promptVersion: 'v3' }),
    });

    expect(second.callsFor('SHP-1')).toBeGreaterThan(0);
  });

  it('does not remember a ticket whose quality review did not finish', async () => {
    const { cache } = await setup();
    const { AIError } = await import('../../../src/ai/errors.js');
    const failing = scriptedAI({
      reviewThrowFor: { 'SHP-1': new AIError('rate_limited', 'quota reached') },
    });
    await runPipeline(failing, [ticket('SHP-1')], { cache });

    const second = scriptedAI();
    await runPipeline(second, [ticket('SHP-1')], { cache });

    expect(second.callsFor('SHP-1')).toBeGreaterThan(0);
  });

  it('remembers a ticket generated without review when review is switched off', async () => {
    const { repo } = await setup();
    const noReview = createTicketCache(repo, { ...identity, selfReview: false });
    await runPipeline(scriptedAI(), [ticket('SHP-1')], {
      cache: noReview,
      generate: { selfReview: false },
    });

    const second = scriptedAI();
    await runPipeline(second, [ticket('SHP-1')], {
      cache: noReview,
      generate: { selfReview: false },
    });

    expect(second.callsFor('SHP-1')).toBe(0);
  });

  it('never caches a ticket that has no update time', async () => {
    const { cache } = await setup();
    const withoutTime = makeTicket('SHP-1');
    await runPipeline(scriptedAI(), [withoutTime], { cache });

    const second = scriptedAI();
    await runPipeline(second, [withoutTime], { cache });

    expect(second.callsFor('SHP-1')).toBeGreaterThan(0);
  });

  it('keeps working when the cache itself fails', async () => {
    const broken: TicketCache = {
      get: async () => {
        throw new Error('database down');
      },
      put: async () => {
        throw new Error('database down');
      },
    };

    const result = await runPipeline(scriptedAI(), [ticket('SHP-1')], { cache: broken });

    expect(result.tickets[0]?.status).toBe('ok');
    expect(result.cases.length).toBeGreaterThan(0);
  });
});
