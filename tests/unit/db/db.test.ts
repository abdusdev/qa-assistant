import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, migrationStatus, rollback } from '../../../src/db/migrate.js';
import type { Migration } from '../../../src/db/migrations.js';
import { migrations } from '../../../src/db/migrations.js';
import type { Db } from '../../../src/db/types.js';
import { backends, openRepository, resetDatabase, sampleResult } from './support.js';

const tablesOf = async (db: Db): Promise<string[]> => {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
};

describe.each(backends())('database on $name', (backend) => {
  let shared: Db;
  beforeAll(async () => {
    shared = await backend.open();
  }, 120_000);
  afterAll(async () => {
    await shared.close();
  });

  const fresh = async () => {
    await resetDatabase(shared);
    return shared;
  };
  const repository = () => openRepository(shared);

  describe('migrations', () => {
    it('creates every table and records the version', async () => {
      const db = await fresh();

      const result = await migrate(db);

      expect(result.applied).toEqual([1]);
      expect(await tablesOf(db)).toEqual(
        [
          'case_revisions',
          'flow_steps',
          'run_tickets',
          'runs',
          'schema_migrations',
          'test_cases',
          'ticket_cache',
        ].sort(),
      );
      expect(await migrationStatus(db)).toEqual({ applied: [1], pending: [] });
    });

    it('does nothing when run again', async () => {
      const db = await fresh();
      await migrate(db);

      expect(await migrate(db)).toEqual({ applied: [] });
    });

    it('undoes migrations, and can apply them again', async () => {
      const db = await fresh();
      await migrate(db);

      expect(await rollback(db)).toEqual({ reverted: [1] });
      expect(await tablesOf(db)).toEqual(['schema_migrations']);
      expect(await migrate(db)).toEqual({ applied: [1] });
      expect((await tablesOf(db)).length).toBeGreaterThan(5);
    });

    it('reports a migration that is waiting', async () => {
      const db = await fresh();
      await migrate(db);
      const withNew: Migration[] = [
        ...migrations,
        { version: 2, name: 'extra', up: 'CREATE TABLE extra (id int)', down: 'DROP TABLE extra' },
      ];

      expect(await migrationStatus(db, withNew)).toEqual({ applied: [1], pending: [2] });
      expect(await migrate(db, withNew)).toEqual({ applied: [2] });
      expect(await tablesOf(db)).toContain('extra');
    });

    it('leaves nothing behind when a migration fails', async () => {
      const db = await fresh();
      await migrate(db);
      const broken: Migration[] = [
        ...migrations,
        {
          version: 2,
          name: 'broken',
          up: 'CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;',
          down: 'DROP TABLE half_done',
        },
      ];

      await expect(migrate(db, broken)).rejects.toThrow();

      expect(await tablesOf(db)).not.toContain('half_done');
      expect((await migrationStatus(db)).applied).toEqual([1]);
    });

    it('rejects a list with a gap in the numbering', async () => {
      const db = await fresh();
      const gap: Migration[] = [{ version: 2, name: 'x', up: 'SELECT 1', down: 'SELECT 1' }];

      await expect(migrate(db, gap)).rejects.toThrow(/without gaps/);
    });

    it('refuses to undo a migration this version of the app does not know', async () => {
      const db = await fresh();
      await migrate(db);
      await db.query("INSERT INTO schema_migrations (version, name) VALUES (2, 'from_the_future')");

      await expect(rollback(db)).rejects.toThrow(/unknown to this version/);
    });
  });

  describe('saving and reading runs', () => {
    it('stores a finished run and reads all of it back', async () => {
      const { repo } = await repository();
      const result = await sampleResult({ casesPerTicket: 2 });

      const runId = await repo.createRun({
        mode: 'epic',
        value: 'SHP-4110',
        filters: { types: ['Story'] },
        promptVersion: result.promptVersion,
      });
      await repo.saveResult(runId, result);
      const run = await repo.getRun(runId);

      expect(run).toMatchObject({
        id: runId,
        status: 'completed',
        inputMode: 'epic',
        inputValue: 'SHP-4110',
        filters: { types: ['Story'] },
        flowSource: 'ai',
        caseCount: 4,
        calls: result.calls,
        totalTokens: result.usage.totalTokens,
        warnings: [],
      });
      expect(run?.estimatedCostUsd).toBeCloseTo(result.estimatedCostUsd ?? 0, 6);
      expect(run?.finishedAt).toBeInstanceOf(Date);
      expect(run?.tickets.map((t) => [t.ticket, t.status, t.cases])).toEqual([
        ['SHP-1', 'ok', 2],
        ['SHP-2', 'ok', 2],
      ]);
      expect(run?.flow.map((step) => step.name)).toEqual(result.flow.steps.map((s) => s.name));
    });

    it('keeps the lists inside a case as real lists', async () => {
      const { repo } = await repository();
      const result = await sampleResult({
        casesFor: () => [
          {
            title: 'Create a saved filter with a name',
            expected: 'The filter is saved',
            preconditions: ['A logged-in user', '5 orders exist'],
            assumptions: ['Names must be unique'],
            sources: [{ from: 'ticket', quote: 'Orders without a rate are skipped' }],
          },
        ],
        keys: ['SHP-1'],
      });
      const runId = await repo.createRun({ mode: 'ticket', value: 'SHP-1', promptVersion: 'v2' });
      await repo.saveResult(runId, result);

      const stored = (await repo.getRun(runId))?.cases[0];

      expect(stored?.steps).toEqual(['Do the first thing', 'Do the second thing']);
      expect(stored?.preconditions).toEqual(['A logged-in user', '5 orders exist']);
      expect(stored?.assumptions).toEqual(expect.arrayContaining(['Names must be unique']));
      expect(stored?.sources).toEqual([
        { from: 'ticket', quote: 'Orders without a rate are skipped' },
      ]);
      expect(stored?.depends_on).toEqual([]);
      expect(stored?.state).toBe('generated');
    });

    it('stores the cases in flow order, with the human codes', async () => {
      const { repo } = await repository();
      const result = await sampleResult({ casesPerTicket: 3 });
      const runId = await repo.createRun({ mode: 'list', value: 'x', promptVersion: 'v2' });
      await repo.saveResult(runId, result);

      const run = await repo.getRun(runId);

      expect(run?.cases.map((c) => c.id)).toEqual(result.cases.map((c) => c.id));
      expect(run?.cases.map((c) => c.position)).toEqual(result.cases.map((_, i) => i));
    });

    it('records failed and skipped tickets with their reasons', async () => {
      const { repo } = await repository();
      const result = await sampleResult({ garbageFor: ['SHP-2'] });
      const runId = await repo.createRun({ mode: 'list', value: 'x', promptVersion: 'v2' });
      await repo.saveResult(runId, result);

      const run = await repo.getRun(runId);

      const failed = run?.tickets.find((t) => t.ticket === 'SHP-2');
      expect(failed).toMatchObject({ status: 'failed', cases: 0 });
      expect(failed?.error).toContain('SHP-2');
      expect(run?.warnings.join(' ')).toContain('1 of 2 tickets failed');
    });

    it('saves everything or nothing', async () => {
      const { repo, db } = await repository();
      const result = await sampleResult();
      const runId = await repo.createRun({ mode: 'list', value: 'x', promptVersion: 'v2' });
      const duplicate = {
        ...result,
        tickets: [...result.tickets, result.tickets[0] as (typeof result.tickets)[number]],
      };

      await expect(repo.saveResult(runId, duplicate)).rejects.toThrow();

      const counts = await db.query<{ cases: number; tickets: number }>(
        `SELECT (SELECT count(*)::int FROM test_cases) AS cases,
                (SELECT count(*)::int FROM run_tickets) AS tickets`,
      );
      expect(counts.rows[0]).toEqual({ cases: 0, tickets: 0 });
      expect((await repo.getRun(runId))?.status).toBe('running');
    });

    it('refuses to save into a run that does not exist', async () => {
      const { repo } = await repository();

      await expect(
        repo.saveResult('00000000-0000-0000-0000-000000000000', await sampleResult()),
      ).rejects.toThrow(/does not exist/);
    });

    it('marks a run as failed with its reason', async () => {
      const { repo } = await repository();
      const runId = await repo.createRun({ mode: 'sprint', value: 'S', promptVersion: 'v2' });

      await repo.failRun(runId, 'Gemini rejected the API key (400).');

      expect(await repo.getRun(runId)).toMatchObject({
        status: 'failed',
        error: 'Gemini rejected the API key (400).',
      });
    });

    it('marks a cancelled run as cancelled', async () => {
      const { repo } = await repository();
      const controller = new AbortController();
      controller.abort();
      const { runPipeline } = await import('../../../src/pipeline/run.js');
      const { makeTicket, scriptedAI } = await import('../pipeline/support.js');
      const result = await runPipeline(scriptedAI(), [makeTicket('SHP-1')], {
        signal: controller.signal,
      });
      const runId = await repo.createRun({ mode: 'list', value: 'x', promptVersion: 'v2' });

      await repo.saveResult(runId, result);

      expect((await repo.getRun(runId))?.status).toBe('cancelled');
    });

    it('returns undefined for a run that does not exist', async () => {
      const { repo } = await repository();

      expect(await repo.getRun('00000000-0000-0000-0000-000000000000')).toBeUndefined();
    });

    it('lists runs newest first, with paging', async () => {
      const { repo } = await repository();
      const ids: string[] = [];
      for (const value of ['one', 'two', 'three']) {
        ids.push(await repo.createRun({ mode: 'list', value, promptVersion: 'v2' }));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const all = await repo.listRuns();
      const page = await repo.listRuns(1, 1);

      expect(all.map((r) => r.inputValue)).toEqual(['three', 'two', 'one']);
      expect(page.map((r) => r.inputValue)).toEqual(['two']);
    });

    it('counts only cases that are not deleted in the list', async () => {
      const { repo } = await repository();
      const result = await sampleResult({ casesPerTicket: 2 });
      const runId = await repo.createRun({ mode: 'list', value: 'x', promptVersion: 'v2' });
      await repo.saveResult(runId, result);
      const run = await repo.getRun(runId);
      await repo.deleteCase(run!.cases[0]!.uid);

      expect((await repo.listRuns())[0]?.caseCount).toBe(3);
    });
  });

  describe("QA's edits", () => {
    const savedRun = async () => {
      const opened = await repository();
      const result = await sampleResult({ casesPerTicket: 2 });
      const runId = await opened.repo.createRun({ mode: 'list', value: 'x', promptVersion: 'v2' });
      await opened.repo.saveResult(runId, result);
      const run = await opened.repo.getRun(runId);
      return { ...opened, runId, cases: run!.cases };
    };

    it('changes a case, marks it edited and keeps what it was before', async () => {
      const { repo, cases } = await savedRun();
      const target = cases[0]!;

      const updated = await repo.updateCase(
        target.uid,
        { title: 'A better title for this case' },
        'abdus',
      );

      expect(updated).toMatchObject({ title: 'A better title for this case', state: 'edited' });
      const revisions = await repo.revisions(target.uid);
      expect(revisions.map((r) => [r.revision, r.type, r.by])).toEqual([
        [1, 'created', 'system'],
        [2, 'edited', 'abdus'],
      ]);
      expect(revisions[1]?.before).toMatchObject({ title: target.title });
      expect(revisions[1]?.after).toMatchObject({ title: 'A better title for this case' });
    });

    it('changes only the fields it names and leaves the rest untouched', async () => {
      const opened = await repository();
      const result = await sampleResult({
        keys: ['SHP-1'],
        casesFor: () => [
          {
            title: 'Create a saved filter with a name',
            expected: 'The filter is saved',
            preconditions: ['A logged-in user'],
            assumptions: ['Names must be unique'],
            sources: [{ from: 'ticket', quote: 'Orders without a rate are skipped' }],
          },
        ],
      });
      const runId = await opened.repo.createRun({
        mode: 'ticket',
        value: 'SHP-1',
        promptVersion: 'v2',
      });
      await opened.repo.saveResult(runId, result);
      const before = (await opened.repo.getRun(runId))!.cases[0]!;

      const after = (await opened.repo.updateCase(before.uid, {
        title: 'Only the title changes here',
      }))!;

      expect(after.title).toBe('Only the title changes here');
      expect(after.preconditions).toEqual(before.preconditions);
      expect(after.assumptions).toEqual(before.assumptions);
      expect(after.steps).toEqual(before.steps);
      expect(after.expected).toBe(before.expected);
      expect(after.priority).toBe(before.priority);
      expect(after.flow_step).toBe(before.flow_step);
    });

    it('keeps the edit after reading the run again', async () => {
      const { repo, runId, cases } = await savedRun();
      await repo.updateCase(cases[1]!.uid, { steps: ['Only one step now'], priority: 'low' });

      const reloaded = (await repo.getRun(runId))!.cases[1]!;

      expect(reloaded).toMatchObject({
        steps: ['Only one step now'],
        priority: 'low',
        state: 'edited',
      });
    });

    it('rejects a field QA may not change and an invalid value', async () => {
      const { repo, cases } = await savedRun();

      await expect(
        repo.updateCase(cases[0]!.uid, { grounding: 'grounded' } as never),
      ).rejects.toThrow();
      await expect(
        repo.updateCase(cases[0]!.uid, { priority: 'urgent' } as never),
      ).rejects.toThrow();
      await expect(repo.updateCase(cases[0]!.uid, { title: 'x' })).rejects.toThrow();
      expect(await repo.revisions(cases[0]!.uid)).toHaveLength(1);
    });

    it('records nothing for an empty change', async () => {
      const { repo, cases } = await savedRun();

      const result = await repo.updateCase(cases[0]!.uid, {});

      expect(result?.state).toBe('generated');
      expect(await repo.revisions(cases[0]!.uid)).toHaveLength(1);
    });

    it('returns undefined for a case that does not exist', async () => {
      const { repo } = await savedRun();

      expect(
        await repo.updateCase('00000000-0000-0000-0000-000000000000', { title: 'Nothing here' }),
      ).toBeUndefined();
      expect(await repo.deleteCase('00000000-0000-0000-0000-000000000000')).toBe(false);
    });

    it('deletes and restores a case without losing it', async () => {
      const { repo, runId, cases } = await savedRun();
      const target = cases[2]!;

      expect(await repo.deleteCase(target.uid, 'abdus')).toBe(true);
      expect((await repo.getRun(runId))!.cases[2]).toMatchObject({ state: 'deleted' });

      expect(await repo.restoreCase(target.uid, 'abdus')).toBe(true);
      expect((await repo.getRun(runId))!.cases[2]).toMatchObject({ state: 'generated' });

      expect((await repo.revisions(target.uid)).map((r) => r.type)).toEqual([
        'created',
        'deleted',
        'restored',
      ]);
    });

    it('does not record a second deletion', async () => {
      const { repo, cases } = await savedRun();

      await repo.deleteCase(cases[0]!.uid);
      await repo.deleteCase(cases[0]!.uid);

      expect(await repo.revisions(cases[0]!.uid)).toHaveLength(2);
    });

    it('adds a case by hand with the next free number, at the end', async () => {
      const { repo, runId, cases } = await savedRun();

      const added = await repo.addCase(
        runId,
        {
          ticket: 'SHP-1',
          flow_step: 'Failures',
          title: 'A case QA thought of themselves',
          type: 'ui',
          priority: 'high',
          steps: ['Do something'],
          expected: 'Something happens',
          preconditions: [],
          assumptions: [],
        },
        'abdus',
      );

      expect(added).toMatchObject({
        id: `TC-${cases.length + 1}`,
        state: 'added',
        position: cases.length,
      });
      expect((await repo.revisions(added.uid))[0]).toMatchObject({ type: 'created', by: 'abdus' });
    });

    it('measures how much of the draft survived review', async () => {
      const { repo, runId, cases } = await savedRun();
      await repo.updateCase(cases[0]!.uid, { title: 'Reworded by the reviewer' });
      await repo.deleteCase(cases[1]!.uid);
      await repo.addCase(runId, {
        ticket: 'SHP-1',
        flow_step: 'Happy path',
        title: 'Added by the reviewer',
        type: 'ui',
        priority: 'medium',
        steps: ['A step'],
        expected: 'An outcome',
        preconditions: [],
        assumptions: [],
      });

      const stats = await repo.runStats(runId);

      expect(stats).toEqual({
        generated: 4,
        kept: 2,
        edited: 1,
        deleted: 1,
        added: 1,
        keptShare: 0.75,
      });
    });

    it('reports zero for a run with no generated cases', async () => {
      const { repo } = await repository();
      const runId = await repo.createRun({ mode: 'list', value: 'x', promptVersion: 'v2' });

      expect(await repo.runStats(runId)).toMatchObject({ generated: 0, keptShare: 0 });
    });
  });

  describe('the result cache', () => {
    const entry = (overrides = {}) => ({
      cacheKey: 'key-1',
      ticketKey: 'SHP-1',
      ticketUpdated: '2026-10-01T10:00:00.000+0100',
      promptVersion: 'v2',
      model: 'model-a',
      payload: { cases: [{ id: 'TC-1' }], detail: { sufficient: true, missing: [] } },
      ...overrides,
    });

    it('returns what was stored, and nothing for an unknown key', async () => {
      const { repo } = await repository();
      await repo.cachePut(entry());

      expect(await repo.cacheGet('key-1')).toEqual(entry().payload);
      expect(await repo.cacheGet('other-key')).toBeUndefined();
    });

    it('counts how often an entry was used', async () => {
      const { repo, db } = await repository();
      await repo.cachePut(entry());

      await repo.cacheGet('key-1');
      await repo.cacheGet('key-1');

      const { rows } = await db.query<{ hits: number }>(
        "SELECT hits FROM ticket_cache WHERE cache_key = 'key-1'",
      );
      expect(rows[0]?.hits).toBe(2);
    });

    it('replaces an entry stored again under the same key', async () => {
      const { repo } = await repository();
      await repo.cachePut(entry());
      await repo.cachePut(
        entry({ payload: { cases: [], detail: { sufficient: false, missing: ['x'] } } }),
      );

      expect(await repo.cacheGet('key-1')).toEqual({
        cases: [],
        detail: { sufficient: false, missing: ['x'] },
      });
    });
  });

  describe('retention', () => {
    it('removes old runs with their cases and old cache entries, and keeps recent ones', async () => {
      const { repo, db } = await repository();
      const result = await sampleResult();
      const oldRun = await repo.createRun({ mode: 'list', value: 'old', promptVersion: 'v2' });
      await repo.saveResult(oldRun, result);
      const newRun = await repo.createRun({ mode: 'list', value: 'new', promptVersion: 'v2' });
      await repo.saveResult(newRun, result);
      await db.query("UPDATE runs SET created_at = now() - interval '200 days' WHERE id = $1", [
        oldRun,
      ]);
      await repo.cachePut({
        cacheKey: 'old',
        ticketKey: 'SHP-1',
        ticketUpdated: 'x',
        promptVersion: 'v2',
        model: 'm',
        payload: {},
      });
      await db.query("UPDATE ticket_cache SET created_at = now() - interval '200 days'");
      await repo.cachePut({
        cacheKey: 'recent',
        ticketKey: 'SHP-2',
        ticketUpdated: 'x',
        promptVersion: 'v2',
        model: 'm',
        payload: {},
      });

      const purged = await repo.purgeOlderThan(90);

      expect(purged).toEqual({ runs: 1, cacheEntries: 1 });
      expect(await repo.getRun(oldRun)).toBeUndefined();
      expect(await repo.getRun(newRun)).toBeDefined();
      const left = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM test_cases WHERE run_id = $1',
        [oldRun],
      );
      expect(left.rows[0]?.n).toBe(0);
      expect(await repo.cacheGet('recent')).toEqual({});
      expect(await repo.cacheGet('old')).toBeUndefined();
    });
  });

  describe('transactions', () => {
    it('undoes everything when the function throws', async () => {
      const db = await fresh();
      await db.exec('CREATE TABLE t (n int)');

      await expect(
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO t (n) VALUES (1)');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM t');
      expect(rows[0]?.n).toBe(0);
    });

    it('keeps everything when it succeeds', async () => {
      const db = await fresh();
      await db.exec('CREATE TABLE t (n int)');

      const value = await db.transaction(async (tx) => {
        await tx.query('INSERT INTO t (n) VALUES (1), (2)');
        return 'done';
      });

      expect(value).toBe('done');
      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM t');
      expect(rows[0]?.n).toBe(2);
    });
  });
});
