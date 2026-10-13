import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { openPglite } from '../../../src/db/pglite.js';
import { Repository } from '../../../src/db/repository.js';
import type { Db } from '../../../src/db/types.js';
import { resetDatabase, sampleResult } from './support.js';

describe('reviewing a saved run', () => {
  let db: Db;
  beforeAll(async () => {
    db = await openPglite();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  /** A run of two tickets with two cases each: TC-1 and TC-2 for SHP-1, TC-3 and TC-4 for SHP-2. */
  async function savedRun() {
    await resetDatabase(db);
    await migrate(db);
    const repo = new Repository(db);
    const result = await sampleResult({
      keys: ['SHP-1', 'SHP-2'],
      // Different words per ticket, or the pipeline would treat them as duplicates.
      casesFor: (key) =>
        [0, 1].map((i) => ({
          title:
            'Check alpha' +
            key.slice(-1) +
            'k' +
            i +
            ' beta' +
            key.slice(-1) +
            'k' +
            i +
            ' scenario',
          expected:
            'Gamma' + key.slice(-1) + 'k' + i + ' delta' + key.slice(-1) + 'k' + i + ' holds',
          flow_step: 'Happy path',
        })),
    });
    const runId = await repo.createRun({
      mode: 'list',
      value: 'SHP-1 SHP-2',
      promptVersion: result.promptVersion,
    });
    await repo.saveResult(runId, result);
    const run = await repo.getRun(runId);
    return { repo, runId, cases: run?.cases ?? [] };
  }

  const byCode = (cases: { id: string; uid: string }[], code: string) =>
    cases.find((c) => c.id === code)!.uid;

  describe('approving', () => {
    it('approves a case and takes the approval back', async () => {
      const { repo, cases } = await savedRun();
      const uid = byCode(cases, 'TC-1');

      expect(cases[0]?.approved).toBe(false);
      expect(await repo.setApproved(uid, true, 'qa-lead')).toBe(true);
      expect((await repo.getCase(uid))?.approved).toBe(true);
      expect(await repo.setApproved(uid, false)).toBe(true);
      expect((await repo.getCase(uid))?.approved).toBe(false);
    });

    it('records who approved and when it changed', async () => {
      const { repo, cases } = await savedRun();
      const uid = byCode(cases, 'TC-1');

      await repo.setApproved(uid, true, 'qa-lead');
      await repo.setApproved(uid, true, 'qa-lead');
      await repo.setApproved(uid, false, 'qa-lead');

      const types = (await repo.revisions(uid)).map((r) => [r.type, r.by]);
      expect(types).toEqual([
        ['created', 'system'],
        ['approved', 'qa-lead'],
        ['unapproved', 'qa-lead'],
      ]);
    });

    it('does not approve a deleted or an unknown case', async () => {
      const { repo, cases } = await savedRun();
      const uid = byCode(cases, 'TC-1');
      await repo.deleteCase(uid);

      expect(await repo.setApproved(uid, true)).toBe(false);
      expect(await repo.setApproved('7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11', true)).toBe(false);
    });

    it('takes the approval back when the case is edited, so changed text is read again', async () => {
      const { repo, cases } = await savedRun();
      const uid = byCode(cases, 'TC-1');
      await repo.setApproved(uid, true);

      const edited = await repo.updateCase(uid, { expected: 'A different outcome' });

      expect(edited?.approved).toBe(false);
      expect(edited?.state).toBe('edited');
    });

    it('approves all the cases that are not deleted and not approved yet', async () => {
      const { repo, runId, cases } = await savedRun();
      await repo.setApproved(byCode(cases, 'TC-1'), true);
      await repo.deleteCase(byCode(cases, 'TC-2'));

      const count = await repo.approveAll(runId, 'qa-lead');

      expect(count).toBe(2);
      const stats = await repo.runStats(runId);
      expect(stats).toMatchObject({ approved: 3, total: 3, deleted: 1 });
      expect(await repo.approveAll(runId)).toBe(0);
    });

    it('does not count a deleted case as approved', async () => {
      const { repo, runId, cases } = await savedRun();
      const uid = byCode(cases, 'TC-1');
      await repo.setApproved(uid, true);
      await repo.deleteCase(uid);

      expect((await repo.runStats(runId)).approved).toBe(0);
    });
  });

  describe('moving', () => {
    const order = async (repo: Repository, runId: string) =>
      (await repo.getRun(runId))?.cases.filter((c) => c.state !== 'deleted').map((c) => c.id);

    it('swaps a case with its neighbour inside the flow step', async () => {
      const { repo, runId, cases } = await savedRun();

      expect(await repo.moveCase(byCode(cases, 'TC-2'), 'up', 'qa')).toBe(true);

      expect(await order(repo, runId)).toEqual(['TC-2', 'TC-1', 'TC-3', 'TC-4']);
    });

    it('moves down too, and records the move', async () => {
      const { repo, runId, cases } = await savedRun();
      const uid = byCode(cases, 'TC-1');

      await repo.moveCase(uid, 'down');

      expect(await order(repo, runId)).toEqual(['TC-2', 'TC-1', 'TC-3', 'TC-4']);
      expect((await repo.revisions(uid)).map((r) => r.type)).toContain('moved');
    });

    it('does nothing at the top or the bottom of the step', async () => {
      const { repo, runId, cases } = await savedRun();

      expect(await repo.moveCase(byCode(cases, 'TC-1'), 'up')).toBe(false);
      expect(await repo.moveCase(byCode(cases, 'TC-4'), 'down')).toBe(false);
      expect(await order(repo, runId)).toEqual(['TC-1', 'TC-2', 'TC-3', 'TC-4']);
    });

    it('skips a deleted neighbour', async () => {
      const { repo, runId, cases } = await savedRun();
      // The flow put TC-3 in "Failures"; bring it into the first step, next to TC-1 and TC-2.
      await repo.updateCase(byCode(cases, 'TC-3'), { flow_step: 'Happy path' });
      await repo.deleteCase(byCode(cases, 'TC-2'));

      await repo.moveCase(byCode(cases, 'TC-3'), 'up');

      expect(await order(repo, runId)).toEqual(['TC-3', 'TC-1', 'TC-4']);
    });

    it('never swaps with a case of another flow step', async () => {
      const { repo, runId, cases } = await savedRun();

      // TC-3 is the first case of "Failures"; TC-2 above it belongs to "Happy path".
      expect(await repo.moveCase(byCode(cases, 'TC-3'), 'up')).toBe(false);
      expect(await order(repo, runId)).toEqual(['TC-1', 'TC-2', 'TC-3', 'TC-4']);
    });

    it('does not move a deleted or an unknown case', async () => {
      const { repo, cases } = await savedRun();
      const uid = byCode(cases, 'TC-2');
      await repo.deleteCase(uid);

      expect(await repo.moveCase(uid, 'up')).toBe(false);
      expect(await repo.moveCase('7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11', 'up')).toBe(false);
    });
  });

  describe('writing one ticket again', () => {
    const fresh = (title: string, step = 'Happy path') => ({
      id: 'TC-1',
      ticket: 'SHP-1',
      flow_step: step,
      title,
      type: 'ui' as const,
      priority: 'high' as const,
      steps: ['A new step'],
      expected: 'A new outcome',
      sources: [],
      assumptions: [],
      preconditions: [],
      depends_on: [],
      grounding: 'grounded' as const,
    });

    it('replaces the AI cases of that ticket and leaves every other ticket alone', async () => {
      const { repo, runId, cases } = await savedRun();
      await repo.updateCase(byCode(cases, 'TC-3'), { priority: 'low' });

      const outcome = await repo.replaceTicketCases(runId, 'SHP-1', [
        fresh('Brand new case one'),
        fresh('Brand new case two'),
        fresh('Brand new case three'),
      ]);

      expect(outcome).toEqual({ removed: 2, added: 3 });
      const run = await repo.getRun(runId);
      const live = run?.cases.filter((c) => c.state !== 'deleted') ?? [];
      expect(live.map((c) => [c.id, c.ticket])).toEqual([
        ['TC-3', 'SHP-2'],
        ['TC-4', 'SHP-2'],
        ['TC-5', 'SHP-1'],
        ['TC-6', 'SHP-1'],
        ['TC-7', 'SHP-1'],
      ]);
      // The edit on the other ticket is still there.
      expect(live.find((c) => c.id === 'TC-3')).toMatchObject({ state: 'edited', priority: 'low' });
    });

    it('keeps the old cases in the history, marked as replaced', async () => {
      const { repo, runId, cases } = await savedRun();
      const old = byCode(cases, 'TC-1');

      await repo.replaceTicketCases(runId, 'SHP-1', [fresh('Brand new case one')]);

      expect((await repo.getCase(old))?.state).toBe('deleted');
      expect((await repo.revisions(old)).map((r) => r.type)).toEqual(['created', 'replaced']);
    });

    it('keeps cases QA added by hand for that ticket', async () => {
      const { repo, runId } = await savedRun();
      await repo.addCase(runId, {
        ticket: 'SHP-1',
        flow_step: 'Happy path',
        title: 'A case QA wrote',
        type: 'ui',
        priority: 'medium',
        steps: ['A step'],
        expected: 'An outcome',
        preconditions: [],
        assumptions: [],
      });

      const outcome = await repo.replaceTicketCases(runId, 'SHP-1', [fresh('Brand new case one')]);

      expect(outcome.removed).toBe(2);
      const live = (await repo.getRun(runId))?.cases.filter((c) => c.state !== 'deleted') ?? [];
      expect(live.map((c) => c.title)).toContain('A case QA wrote');
    });

    it('takes the approval off the replaced cases', async () => {
      const { repo, runId, cases } = await savedRun();
      await repo.setApproved(byCode(cases, 'TC-1'), true);

      await repo.replaceTicketCases(runId, 'SHP-1', [fresh('Brand new case one')]);

      expect((await repo.runStats(runId)).approved).toBe(0);
    });

    it('adds a flow step the run did not have, so the new cases are not lost in "Other"', async () => {
      const { repo, runId } = await savedRun();

      await repo.replaceTicketCases(runId, 'SHP-1', [fresh('A regression case', 'Regression')]);

      const run = await repo.getRun(runId);
      const step = run?.flow.find((s) => s.name === 'Regression');
      expect(step?.caseCodes).toEqual(['TC-5']);
    });

    it('can write a ticket that had no cases, and leaves nothing behind for none', async () => {
      const { repo, runId } = await savedRun();

      const none = await repo.replaceTicketCases(runId, 'SHP-9', []);
      const some = await repo.replaceTicketCases(runId, 'SHP-9', [fresh('For another ticket')]);

      expect(none).toEqual({ removed: 0, added: 0 });
      expect(some).toEqual({ removed: 0, added: 1 });
    });
  });

  describe('reading', () => {
    it('reads one case, or nothing', async () => {
      const { repo, cases } = await savedRun();

      expect((await repo.getCase(byCode(cases, 'TC-1')))?.id).toBe('TC-1');
      expect(await repo.getCase('7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11')).toBeUndefined();
    });

    it('counts the review of a run', async () => {
      const { repo, runId, cases } = await savedRun();
      await repo.updateCase(byCode(cases, 'TC-1'), { title: 'Reworded by the reviewer' });
      await repo.deleteCase(byCode(cases, 'TC-2'));
      await repo.setApproved(byCode(cases, 'TC-3'), true);

      expect(await repo.runStats(runId)).toEqual({
        generated: 4,
        kept: 2,
        edited: 1,
        deleted: 1,
        added: 0,
        approved: 1,
        total: 3,
        keptShare: 0.75,
      });
    });
  });
});
