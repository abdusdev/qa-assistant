import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';
import { migrate } from '../../../src/db/migrate.js';
import { openPglite } from '../../../src/db/pglite.js';
import { Repository } from '../../../src/db/repository.js';
import type { Db } from '../../../src/db/types.js';
import { JiraError } from '../../../src/jira/errors.js';
import type { TicketSource } from '../../../src/jira/resolver.js';
import type { Ticket } from '../../../src/jira/ticket.js';
import type { Knowledge } from '../../../src/knowledge/loader.js';
import { JobManager } from '../../../src/jobs/manager.js';
import { checkCodeContext, createRunner } from '../../../src/jobs/runner.js';
import { RunError, type ProgressUpdate } from '../../../src/jobs/types.js';
import { fakeGitHub, pr, REPO, file } from '../github/support.js';
import { resetDatabase } from '../db/support.js';
import { makeTicket, scriptedAI } from '../pipeline/support.js';

const ticketsByKey = (keys: string[], overrides: Partial<Ticket> = {}) =>
  new Map(keys.map((key) => [key, makeTicket(key, overrides)]));

/** A ticket source over a fixed set of tickets. */
function source(tickets: Map<string, Ticket>): TicketSource {
  return {
    async getIssue(key) {
      const found = tickets.get(key.toUpperCase());
      if (!found) throw new JiraError('not_found', `Ticket ${key} was not found (404).`, 404);
      return found;
    },
    async searchIssues() {
      return { tickets: [...tickets.values()], truncated: false };
    },
  };
}

const noCode = { ...loadConfig({}) };

describe('createRunner', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openPglite();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  const freshRepo = async () => {
    await resetDatabase(db);
    await migrate(db);
    return new Repository(db);
  };

  const run = async (
    runner: ReturnType<typeof createRunner>,
    value: string,
    options: {
      mode?: 'ticket' | 'list' | 'epic';
      signal?: AbortSignal;
      report?: (u: ProgressUpdate) => void;
      code?: boolean;
    } = {},
  ) =>
    runner({
      input: {
        mode: options.mode ?? 'ticket',
        value,
        ...(options.code !== undefined && { useCodeContext: options.code }),
      },
      signal: options.signal ?? new AbortController().signal,
      report: options.report ?? (() => undefined),
    });

  it('resolves the tickets, runs the pipeline and returns the results', async () => {
    const ai = scriptedAI();
    const runner = createRunner({
      provider: ai,
      tickets: source(ticketsByKey(['SHP-1', 'SHP-2'])),
      config: noCode,
    });

    const outcome = await run(runner, 'SHP-1 SHP-2', { mode: 'list', code: false });

    expect(outcome.cancelled).toBe(false);
    expect(outcome.result.cases).toHaveLength(4);
    expect(outcome.result.tickets.map((t) => t.status)).toEqual(['ok', 'ok']);
    expect(outcome.result.flow.steps.length).toBeGreaterThan(0);
    expect(outcome.runId).toBeUndefined();
  });

  it('reports the stages and each ticket as it goes', async () => {
    const updates: ProgressUpdate[] = [];
    const runner = createRunner({
      provider: scriptedAI(),
      tickets: source(ticketsByKey(['SHP-1', 'SHP-2'])),
      config: noCode,
      ticketConcurrency: 1,
    });

    await run(runner, 'SHP-1 SHP-2', {
      mode: 'list',
      code: false,
      report: (update) => updates.push(update),
    });

    const stages = updates.flatMap((u) => (u.type === 'stage' ? [u.stage] : []));
    expect(stages).toEqual(['resolving', 'generating', 'ordering']);
    expect(updates.find((u) => u.type === 'tickets')).toEqual({
      type: 'tickets',
      tickets: ['SHP-1', 'SHP-2'],
    });
    const statuses = updates.flatMap((u) =>
      u.type === 'ticket' ? [`${u.ticket}:${u.status}`] : [],
    );
    expect(statuses).toEqual(['SHP-1:running', 'SHP-1:ok', 'SHP-2:running', 'SHP-2:ok']);
  });

  it('reports the full text of every ticket as soon as it is fetched, before any AI call', async () => {
    const updates: ProgressUpdate[] = [];
    const calls: string[] = [];
    const ai = scriptedAI();
    const runner = createRunner({
      provider: {
        name: ai.name,
        generate: (request) => {
          calls.push('ai');
          return ai.generate(request);
        },
      },
      tickets: source(
        ticketsByKey(['SHP-1', 'SHP-2'], {
          description: 'The full description with the rule that matters.',
          acceptanceCriteria: 'It works',
        }),
      ),
      config: noCode,
    });

    await run(runner, 'SHP-1 SHP-2', {
      mode: 'list',
      code: false,
      report: (update) => {
        updates.push(update);
        if (update.type === 'ticket_details') calls.push('details');
      },
    });

    const details = updates.find((u) => u.type === 'ticket_details');
    expect(details).toMatchObject({
      type: 'ticket_details',
      details: [
        {
          key: 'SHP-1',
          description: 'The full description with the rule that matters.',
          acceptanceCriteria: 'It works',
        },
        { key: 'SHP-2' },
      ],
    });
    expect(calls[0]).toBe('details');
  });

  it('still reports the tickets when the run then cannot start', async () => {
    const updates: ProgressUpdate[] = [];
    const runner = createRunner({
      provider: scriptedAI(),
      tickets: source(ticketsByKey(['SHP-1'])),
      // Code context asked for, but no GitHub settings: the run stops with a clear reason.
      config: noCode,
    });

    await expect(
      run(runner, 'SHP-1', { code: true, report: (update) => updates.push(update) }),
    ).rejects.toBeInstanceOf(RunError);

    expect(updates.some((u) => u.type === 'ticket_details')).toBe(true);
  });

  it('keeps the ticket text with the saved run', async () => {
    const repo = await freshRepo();
    const runner = createRunner({
      provider: scriptedAI(),
      tickets: source(ticketsByKey(['SHP-1'], { description: 'Saved with the run.' })),
      config: noCode,
      repository: repo,
    });

    const outcome = await run(runner, 'SHP-1', { code: false });

    const stored = await repo.getRun(outcome.runId!);
    expect(stored?.tickets[0]?.snapshot).toMatchObject({
      key: 'SHP-1',
      description: 'Saved with the run.',
    });
  });

  it('refreshes the kept ticket text when one ticket is written again', async () => {
    const repo = await freshRepo();
    const first = createRunner({
      provider: scriptedAI(),
      tickets: source(ticketsByKey(['SHP-1'], { description: 'Old wording.' })),
      config: noCode,
      repository: repo,
    });
    const outcome = await run(first, 'SHP-1', { code: false });

    const again = createRunner({
      provider: scriptedAI(),
      tickets: source(ticketsByKey(['SHP-1'], { description: 'New wording after an edit.' })),
      config: noCode,
      repository: repo,
    });
    await again({
      input: {
        mode: 'ticket',
        value: 'SHP-1',
        regenerateRunId: outcome.runId!,
        useCodeContext: false,
      },
      signal: new AbortController().signal,
      report: () => undefined,
    });

    const stored = await repo.getRun(outcome.runId!);
    expect(stored?.tickets[0]?.snapshot?.description).toBe('New wording after an edit.');
  });

  it('saves the run and the cases when a database is set up', async () => {
    const repo = await freshRepo();
    const runner = createRunner({
      provider: scriptedAI(),
      tickets: source(ticketsByKey(['SHP-1'])),
      config: noCode,
      repository: repo,
    });

    const outcome = await run(runner, 'SHP-1', { code: false });

    expect(outcome.runId).toBeDefined();
    const saved = await repo.getRun(outcome.runId as string);
    expect(saved?.status).toBe('completed');
    expect(saved?.inputValue).toBe('SHP-1');
    expect(saved?.cases).toHaveLength(outcome.result.cases.length);
  });

  it('marks a saved run as failed when the pipeline cannot continue', async () => {
    const repo = await freshRepo();
    const { AIError } = await import('../../../src/ai/errors.js');
    const runner = createRunner({
      provider: scriptedAI({
        throwFor: { 'SHP-1': new AIError('unauthorized', 'The key was rejected') },
      }),
      tickets: source(ticketsByKey(['SHP-1'])),
      config: noCode,
      repository: repo,
    });

    await expect(run(runner, 'SHP-1', { code: false })).rejects.toThrow(/rejected/);

    const [only] = await repo.listRuns();
    expect(only?.status).toBe('failed');
  });

  it('fails clearly when no ticket matches', async () => {
    const runner = createRunner({
      provider: scriptedAI(),
      tickets: source(new Map()),
      config: noCode,
    });

    const error = await run(runner, 'SHP-404', { code: false }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunError);
    expect((error as Error).message).toContain('No tickets matched');
    expect((error as Error).message).toContain('SHP-404');
  });

  describe('cancel', () => {
    it('stops starting tickets once the signal is aborted, so no more AI calls are made', async () => {
      const ai = scriptedAI();
      const controller = new AbortController();
      const runner = createRunner({
        provider: ai,
        tickets: source(ticketsByKey(['SHP-1', 'SHP-2', 'SHP-3', 'SHP-4'])),
        config: noCode,
        ticketConcurrency: 1,
      });

      const outcome = await run(runner, 'SHP-1 SHP-2 SHP-3 SHP-4', {
        mode: 'list',
        code: false,
        signal: controller.signal,
        report: (update) => {
          if (update.type === 'ticket' && update.status === 'ok') controller.abort();
        },
      });

      expect(outcome.cancelled).toBe(true);
      expect(outcome.result.tickets.map((t) => t.status)).toEqual([
        'ok',
        'skipped',
        'skipped',
        'skipped',
      ]);
      expect(ai.callsFor('SHP-2') + ai.callsFor('SHP-3') + ai.callsFor('SHP-4')).toBe(0);
    });

    it('is saved as a cancelled run, and the job ends as cancelled', async () => {
      const repo = await freshRepo();
      const runner = createRunner({
        provider: scriptedAI({ delayMs: { 'SHP-1': 20 } }),
        tickets: source(ticketsByKey(['SHP-1', 'SHP-2', 'SHP-3'])),
        config: noCode,
        repository: repo,
        ticketConcurrency: 1,
      });
      const manager = new JobManager(runner);

      const job = manager.submit({
        mode: 'list',
        value: 'SHP-1 SHP-2 SHP-3',
        useCodeContext: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      manager.cancel(job.id);
      await manager.whenIdle();

      const finished = manager.get(job.id);
      expect(finished?.status).toBe('cancelled');
      expect(finished?.runId).toBeDefined();
      expect((await repo.getRun(finished?.runId as string))?.status).toBe('cancelled');
    });
  });

  describe('writing one ticket again', () => {
    // A ticket with an "updated" time can be cached, so a regenerate that wrongly used the
    // cache would be caught.
    const cacheable = () =>
      source(ticketsByKey(['SHP-1', 'SHP-2'], { updated: '2026-10-01T10:00:00.000+0100' }));

    /** A saved run of two tickets, written by the first scripted AI. */
    async function savedRun(repo: Repository) {
      const first = createRunner({
        provider: scriptedAI(),
        tickets: cacheable(),
        config: noCode,
        repository: repo,
      });
      const outcome = await run(first, 'SHP-1 SHP-2', { mode: 'list', code: false });
      return outcome.runId as string;
    }

    const again = (
      repo: Repository | undefined,
      ai: ReturnType<typeof scriptedAI>,
      runId: string,
      overrides: Partial<{ signal: AbortSignal }> = {},
    ) =>
      createRunner({
        provider: ai,
        tickets: cacheable(),
        config: noCode,
        ...(repo && { repository: repo }),
      })({
        input: { mode: 'ticket', value: 'SHP-1', useCodeContext: false, regenerateRunId: runId },
        signal: overrides.signal ?? new AbortController().signal,
        report: () => undefined,
      });

    it('swaps in new cases for that ticket and leaves the other ticket alone', async () => {
      const repo = await freshRepo();
      const runId = await savedRun(repo);
      const before = await repo.getRun(runId);
      const other = before?.cases.filter((c) => c.ticket === 'SHP-2').map((c) => c.title);
      const ai = scriptedAI({
        casesFor: () => [
          { title: 'Brand new omega scenario', expected: 'Zeta holds again' },
          { title: 'Another fresh sigma scenario', expected: 'Theta holds again' },
          { title: 'A third kappa scenario', expected: 'Lambda holds again' },
        ],
      });

      const outcome = await again(repo, ai, runId);

      expect(outcome.runId).toBe(runId);
      const after = await repo.getRun(runId);
      const live = after?.cases.filter((c) => c.state !== 'deleted') ?? [];
      expect(live.filter((c) => c.ticket === 'SHP-1').map((c) => c.title)).toEqual([
        'Brand new omega scenario',
        'Another fresh sigma scenario',
        'A third kappa scenario',
      ]);
      expect(live.filter((c) => c.ticket === 'SHP-2').map((c) => c.title)).toEqual(other);
    });

    it('does not use the result cache, because the same cases again are not what was asked for', async () => {
      const repo = await freshRepo();
      const runId = await savedRun(repo);
      const ai = scriptedAI();

      await again(repo, ai, runId);

      expect(ai.callsFor('SHP-1')).toBeGreaterThan(0);
    });

    it('leaves the run as it was when the ticket cannot be written', async () => {
      const repo = await freshRepo();
      const runId = await savedRun(repo);
      const before = (await repo.getRun(runId))?.cases.map((c) => [c.id, c.state, c.title]);
      const { AIError } = await import('../../../src/ai/errors.js');
      const ai = scriptedAI({
        throwFor: { 'SHP-1': new AIError('server_error', 'The AI is down') },
      });

      const error = await again(repo, ai, runId).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RunError);
      expect((error as Error).message).toContain('left as it was');
      expect((await repo.getRun(runId))?.cases.map((c) => [c.id, c.state, c.title])).toEqual(
        before,
      );
    });

    it('leaves the run as it was when it is cancelled first', async () => {
      const repo = await freshRepo();
      const runId = await savedRun(repo);
      const before = (await repo.getRun(runId))?.cases.map((c) => [c.id, c.state]);
      const controller = new AbortController();
      controller.abort();

      const error = await again(repo, scriptedAI(), runId, { signal: controller.signal }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(RunError);
      expect((await repo.getRun(runId))?.cases.map((c) => [c.id, c.state])).toEqual(before);
    });

    it('does not create another run', async () => {
      const repo = await freshRepo();
      const runId = await savedRun(repo);

      await again(repo, scriptedAI(), runId);

      expect(await repo.listRuns()).toHaveLength(1);
    });

    it('needs the database, and a run that exists', async () => {
      const repo = await freshRepo();
      const runId = await savedRun(repo);

      const noDatabase = await again(undefined, scriptedAI(), runId).catch((e: unknown) => e);
      const noRun = await again(repo, scriptedAI(), '7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11').catch(
        (e: unknown) => e,
      );

      expect(noDatabase).toBeInstanceOf(RunError);
      expect((noDatabase as Error).message).toContain('DATABASE_URL');
      expect(noRun).toBeInstanceOf(RunError);
      expect((noRun as Error).message).toContain('does not exist');
    });
  });

  describe('code context', () => {
    const withGithub = (env: Record<string, string> = {}) =>
      loadConfig({ GITHUB_TOKEN: 'gh-token', GITHUB_REPOS: REPO, ...env });

    it('is refused with an explanation when sending code has not been approved', async () => {
      const runner = createRunner({
        provider: scriptedAI(),
        tickets: source(ticketsByKey(['SHP-1'])),
        config: withGithub(),
        github: fakeGitHub(),
      });

      const error = await run(runner, 'SHP-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RunError);
      expect((error as Error).message).toContain('ALLOW_CODE_TO_AI=true');
    });

    it('adds the pull request changes to the prompt when approved', async () => {
      const ai = scriptedAI();
      const github = fakeGitHub({
        recent: [pr(10, { title: 'Change (SHP-1)' })],
        files: { 10: [file('src/a.ts', { patch: '@@ -1 +1 @@\n-a\n+const FROM_THE_PR = 1' })] },
      });
      const runner = createRunner({
        provider: ai,
        tickets: source(ticketsByKey(['SHP-1'])),
        config: withGithub({ ALLOW_CODE_TO_AI: 'true' }),
        github,
      });

      const outcome = await run(runner, 'SHP-1');

      expect(ai.requests[0]?.prompt).toContain('+const FROM_THE_PR = 1');
      expect(outcome.result.tickets[0]?.context).toMatchObject({ code: { status: 'found' } });
    });

    it('leaves the code out when the request turns it off', async () => {
      const ai = scriptedAI();
      const github = fakeGitHub({ recent: [pr(10, { title: 'Change (SHP-1)' })] });
      const runner = createRunner({
        provider: ai,
        tickets: source(ticketsByKey(['SHP-1'])),
        config: withGithub(),
        github,
      });

      await run(runner, 'SHP-1', { code: false });

      expect(ai.requests[0]?.prompt).not.toContain('<code_changes>');
      expect(github.calls.recent).toEqual([]);
    });

    it('is checked before a run starts', () => {
      const input = { mode: 'ticket' as const, value: 'SHP-1' };

      expect(checkCodeContext(withGithub(), input)).toContain('ALLOW_CODE_TO_AI=true');
      expect(checkCodeContext(withGithub({ ALLOW_CODE_TO_AI: 'true' }), input)).toBeUndefined();
      expect(checkCodeContext(withGithub(), { ...input, useCodeContext: false })).toBeUndefined();
      expect(checkCodeContext(noCode, input)).toBeUndefined();
    });
  });

  describe('knowledge', () => {
    it('is looked up for each run and reaches the prompt', async () => {
      const ai = scriptedAI();
      const knowledge: Knowledge = {
        overview: 'ShipNest connects online stores with couriers so sellers can ship orders.',
        modules: [],
        pastCases: [],
        warnings: [],
        files: [],
      };
      const runner = createRunner({
        provider: ai,
        tickets: source(ticketsByKey(['SHP-1'])),
        config: noCode,
        knowledge: async () => knowledge,
      });

      await run(runner, 'SHP-1', { code: false });

      expect(ai.requests[0]?.system).toContain('ShipNest connects online stores');
    });
  });
});
