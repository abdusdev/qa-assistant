import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, rollback } from '../../../src/db/migrate.js';
import { openPglite } from '../../../src/db/pglite.js';
import { Repository } from '../../../src/db/repository.js';
import type { Db } from '../../../src/db/types.js';
import type { TicketSnapshot } from '../../../src/jira/snapshot.js';
import { resetDatabase, sampleResult } from './support.js';

const snapshot = (key: string, description = `Text of ${key}`): TicketSnapshot => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  summary: `Summary of ${key}`,
  type: 'Story',
  status: 'Done',
  description,
  labels: ['rates'],
  commentCount: 1,
  comments: [{ author: 'Asha', created: '2026-10-01T10:00:00Z', body: 'A comment' }],
  truncated: false,
});

describe('the ticket text kept with a run', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openPglite();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  async function setup() {
    await resetDatabase(db);
    await migrate(db);
    return new Repository(db);
  }

  async function save(repo: Repository, snapshots?: TicketSnapshot[]) {
    const result = await sampleResult({ keys: ['SHP-1', 'SHP-2'] });
    const runId = await repo.createRun({
      mode: 'list',
      value: 'SHP-1 SHP-2',
      promptVersion: result.promptVersion,
    });
    await repo.saveResult(runId, result, snapshots);
    return runId;
  }

  it('is saved for each ticket and read back whole', async () => {
    const repo = await setup();

    const runId = await save(repo, [snapshot('SHP-1'), snapshot('SHP-2')]);

    const run = await repo.getRun(runId);
    expect(run?.tickets.map((t) => t.snapshot)).toEqual([snapshot('SHP-1'), snapshot('SHP-2')]);
  });

  it('is null for a ticket that has none, so older runs still open', async () => {
    const repo = await setup();

    const runId = await save(repo, [snapshot('SHP-2')]);

    const run = await repo.getRun(runId);
    expect(run?.tickets.map((t) => t.snapshot?.key ?? null)).toEqual([null, 'SHP-2']);
  });

  it('is null for every ticket when none were given', async () => {
    const repo = await setup();

    const runId = await save(repo);

    expect((await repo.getRun(runId))?.tickets.map((t) => t.snapshot)).toEqual([null, null]);
  });

  it('can be replaced for one ticket without touching the others', async () => {
    const repo = await setup();
    const runId = await save(repo, [snapshot('SHP-1'), snapshot('SHP-2')]);

    await repo.updateTicketSnapshot(runId, 'SHP-1', snapshot('SHP-1', 'Reworded'));

    const run = await repo.getRun(runId);
    expect(run?.tickets[0]?.snapshot?.description).toBe('Reworded');
    expect(run?.tickets[1]?.snapshot?.description).toBe('Text of SHP-2');
  });

  it('goes away with the run when it is purged', async () => {
    const repo = await setup();
    const runId = await save(repo, [snapshot('SHP-1')]);
    await db.query(`UPDATE runs SET created_at = now() - interval '200 days' WHERE id = $1`, [
      runId,
    ]);

    await repo.purgeOlderThan(90);

    const left = await db.query('SELECT count(*)::int AS n FROM run_tickets');
    expect((left.rows[0] as { n: number }).n).toBe(0);
  });

  it('is a migration that can be undone and applied again', async () => {
    const repo = await setup();
    const runId = await save(repo, [snapshot('SHP-1')]);

    const { reverted } = await rollback(db, 1);
    expect(reverted).toEqual([4]);
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'run_tickets' AND column_name = 'snapshot'`,
    );
    expect(columns.rows).toHaveLength(0);

    await migrate(db);
    expect((await repo.getRun(runId))?.tickets[0]?.snapshot).toBeNull();
  });
});
