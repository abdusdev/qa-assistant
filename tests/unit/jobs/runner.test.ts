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
