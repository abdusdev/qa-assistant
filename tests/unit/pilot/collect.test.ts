import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { openPglite } from '../../../src/db/pglite.js';
import { Repository } from '../../../src/db/repository.js';
import type { Db } from '../../../src/db/types.js';
import { collectPilot } from '../../../src/pilot/collect.js';
import { buildReport } from '../../../src/pilot/report.js';
import { resetDatabase, sampleResult } from '../db/support.js';

describe('collecting a pilot from the database', () => {
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

  async function savedRun(repo: Repository, keys = ['SHP-1', 'SHP-2']) {
    const result = await sampleResult({
      keys,
      casesFor: (key) =>
        [0, 1].map((i) => ({
          title: `Check alpha${key.slice(-1)}k${i} beta${key.slice(-1)}k${i} scenario`,
          expected: `Gamma${key.slice(-1)}k${i} delta${key.slice(-1)}k${i} holds`,
          flow_step: 'Happy path',
        })),
    });
    const runId = await repo.createRun({
      mode: 'list',
      value: keys.join(' '),
      promptVersion: result.promptVersion,
    });
    await repo.saveResult(runId, result);
    return runId;
  }

  it('reports the review window, the people and the fields QA edited', async () => {
    const repo = await setup();
    const runId = await savedRun(repo);
    const cases = (await repo.getRun(runId))!.cases;
    const [a, b, c] = cases;

    await repo.updateCase(a!.uid, { title: 'A clearer title for this case' }, 'asha');
    await repo.updateCase(a!.uid, { expected: 'A different outcome', priority: 'high' }, 'asha');
    await repo.deleteCase(b!.uid, 'qa');
    await repo.setApproved(c!.uid, true, 'qa');

    const activity = await repo.reviewActivity(runId);

    expect(activity.people).toEqual(['asha', 'qa']);
    expect(activity.editedFields).toEqual({ title: 1, expected: 1, priority: 1 });
    expect(activity.firstChangeAt).toBeInstanceOf(Date);
    expect(activity.lastChangeAt!.getTime()).toBeGreaterThanOrEqual(
      activity.firstChangeAt!.getTime(),
    );
  });

  it('has no window for a run nobody has touched', async () => {
    const repo = await setup();
    const runId = await savedRun(repo);

    expect(await repo.reviewActivity(runId)).toEqual({
      firstChangeAt: null,
      lastChangeAt: null,
      people: [],
      editedFields: {},
      replaced: [],
    });
  });

  it('builds a report whose numbers match the run statistics', async () => {
    const repo = await setup();
    const runId = await savedRun(repo);
    const cases = (await repo.getRun(runId))!.cases;
    await repo.updateCase(cases[0]!.uid, { title: 'A clearer title for this case' }, 'asha');
    await repo.deleteCase(cases[1]!.uid, 'asha');
    const added = await repo.addCase(
      runId,
      {
        ticket: 'SHP-1',
        flow_step: 'Happy path',
        title: 'A case QA wrote by hand',
        type: 'ui',
        priority: 'medium',
        steps: ['A step'],
        expected: 'An outcome',
        preconditions: [],
        assumptions: [],
        covers: [],
      },
      'asha',
    );
    // A case added by hand and then removed is not one of the AI's.
    await repo.deleteCase(added.uid, 'asha');
    await repo.addCase(
      runId,
      {
        ticket: 'SHP-2',
        flow_step: 'Happy path',
        title: 'Another case QA wrote',
        type: 'ui',
        priority: 'medium',
        steps: ['A step'],
        expected: 'An outcome',
        preconditions: [],
        assumptions: [],
        covers: [],
      },
      'asha',
    );

    const stats = await repo.runStats(runId);
    const report = buildReport(await collectPilot(repo, { runIds: [runId] }));

    expect(report.totals).toMatchObject({
      generated: stats.generated,
      kept: stats.kept,
      edited: stats.edited,
      deleted: stats.deleted,
      added: stats.added,
    });
    expect(stats).toMatchObject({ generated: 4, kept: 2, edited: 1, deleted: 1, added: 1 });
  });

  it('does not count a regeneration as QA deleting the old cases', async () => {
    const repo = await setup();
    const runId = await savedRun(repo);
    const before = (await repo.getRun(runId))!.cases;
    await repo.deleteCase(before[3]!.uid, 'asha'); // QA's own deletion in SHP-2 stays one

    await regenerate(repo, runId, 'asha');

    const activity = await repo.reviewActivity(runId);
    const report = buildReport(await collectPilot(repo, { runIds: [runId] }));

    expect(activity.replaced).toHaveLength(2);
    // 2 untouched SHP-1 cases were replaced by 2 new ones; SHP-2 has 2 cases, 1 deleted by QA.
    expect(report.totals).toMatchObject({ generated: 4, kept: 3, deleted: 1 });
    // Regenerating is not review: it leaves no window of its own.
    expect(activity.people).toEqual(['asha']);
  });

  /** Regenerates SHP-1 of a saved run, as the person named. */
  async function regenerate(repo: Repository, runId: string, by: string) {
    return repo.replaceTicketCases(
      runId,
      'SHP-1',
      [0, 1].map((i) => ({
        id: `N${i}`,
        ticket: 'SHP-1',
        flow_step: 'Happy path',
        title: `Regenerated gamma${i} delta${i} scenario`,
        type: 'ui' as const,
        priority: 'medium' as const,
        steps: ['A step'],
        expected: `Regenerated epsilon${i} zeta${i} holds`,
        preconditions: [],
        assumptions: [],
        sources: [],
        depends_on: [],
        covers: [],
        grounding: 'grounded' as const,
      })),
      by,
    );
  }

  it('does not treat regenerating as reviewing: it adds no person and no window', async () => {
    const repo = await setup();
    const runId = await savedRun(repo);

    await regenerate(repo, runId, 'someone-who-only-regenerated');

    const activity = await repo.reviewActivity(runId);
    expect(activity.people).toEqual([]);
    expect(activity.firstChangeAt).toBeNull();
    expect(activity.replaced).toHaveLength(2);
  });

  it('counts a replaced case that QA restored, because it is live again', async () => {
    const repo = await setup();
    const runId = await savedRun(repo);
    await regenerate(repo, runId, 'asha');
    const replaced = (await repo.reviewActivity(runId)).replaced;

    await repo.restoreCase(replaced[0]!, 'asha');

    const activity = await repo.reviewActivity(runId);
    const report = buildReport(await collectPilot(repo, { runIds: [runId] }));
    expect(activity.replaced).toEqual([replaced[1]]);
    // 2 regenerated + 1 restored in SHP-1, 2 in SHP-2.
    expect(report.totals.generated).toBe(5);
  });

  it('includes a run created exactly at the since moment', async () => {
    const repo = await setup();
    const runId = await savedRun(repo);
    await db.query(`UPDATE runs SET created_at = '2026-10-14T09:00:00Z' WHERE id = $1`, [runId]);

    const inputs = await collectPilot(repo, { since: new Date('2026-10-14T09:00:00Z') });

    expect(inputs.map((i) => i.run.id)).toEqual([runId]);
  });

  it('selects runs since a date and skips runs that did not complete', async () => {
    const repo = await setup();
    const old = await savedRun(repo, ['SHP-1']);
    await db.query(`UPDATE runs SET created_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [old]);
    const recent = await savedRun(repo, ['SHP-2']);
    const failed = await repo.createRun({ mode: 'list', value: 'SHP-3', promptVersion: 'v3' });
    await repo.failRun(failed, 'boom');

    const inputs = await collectPilot(repo, { since: new Date('2026-06-01T00:00:00Z') });

    expect(inputs.map((i) => i.run.id)).toEqual([recent]);
  });

  it('applies the until date as exclusive', async () => {
    const repo = await setup();
    const run = await savedRun(repo);
    await db.query(`UPDATE runs SET created_at = '2026-10-14T09:00:00Z' WHERE id = $1`, [run]);

    const before = collectPilot(repo, {
      since: new Date('2026-10-01T00:00:00Z'),
      until: new Date('2026-10-14T09:00:00Z'),
    });
    await expect(before).rejects.toThrow('No completed runs match.');

    const after = await collectPilot(repo, {
      since: new Date('2026-10-01T00:00:00Z'),
      until: new Date('2026-10-14T09:00:01Z'),
    });
    expect(after).toHaveLength(1);
  });

  it('refuses a run that is missing or did not complete, and a request with no selection', async () => {
    const repo = await setup();
    const failed = await repo.createRun({ mode: 'list', value: 'SHP-3', promptVersion: 'v3' });
    await repo.failRun(failed, 'boom');

    await expect(
      collectPilot(repo, { runIds: ['7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11'] }),
    ).rejects.toThrow('There is no run with the id 7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11.');
    await expect(collectPilot(repo, { runIds: [failed] })).rejects.toThrow(
      'is failed, not completed',
    );
    await expect(collectPilot(repo, {})).rejects.toThrow('Say which runs to report on');
  });
});
