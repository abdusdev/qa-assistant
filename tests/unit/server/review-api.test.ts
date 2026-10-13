import type { AddressInfo } from 'node:net';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { openPglite } from '../../../src/db/pglite.js';
import { Repository } from '../../../src/db/repository.js';
import type { Db } from '../../../src/db/types.js';
import { JobManager } from '../../../src/jobs/manager.js';
import type { GenerateInput, JobRunner } from '../../../src/jobs/types.js';
import { createApp } from '../../../src/server/app.js';
import { resetDatabase, sampleResult } from '../db/support.js';

const UNKNOWN = '7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11';

describe('reviewing through the API', () => {
  let db: Db;
  let close: (() => Promise<void>) | undefined;
  const submitted: GenerateInput[] = [];

  beforeAll(async () => {
    db = await openPglite();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });
  afterEach(async () => {
    await close?.();
    close = undefined;
    submitted.length = 0;
  });

  async function start(options: { withRepository?: boolean; precheck?: string } = {}) {
    await resetDatabase(db);
    await migrate(db);
    const repository = new Repository(db);

    const result = await sampleResult({
      keys: ['SHP-1', 'SHP-2'],
      casesFor: (key) =>
        [0, 1].map((i) => ({
          title: `Check alpha${key.slice(-1)}k${i} beta${key.slice(-1)}k${i} scenario`,
          expected: `Gamma${key.slice(-1)}k${i} delta${key.slice(-1)}k${i} holds`,
          flow_step: 'Happy path',
        })),
    });
    const runId = await repository.createRun({
      mode: 'list',
      value: 'SHP-1 SHP-2',
      promptVersion: result.promptVersion,
    });
    await repository.saveResult(runId, result);
    const run = await repository.getRun(runId);
    const cases = run?.cases ?? [];

    const runner: JobRunner = async ({ input }) => {
      submitted.push(input);
      return {
        result: {
          cases: [],
          flow: { steps: [] },
          flowSource: 'none',
          tickets: [],
          warnings: [],
          grounding: { grounded: 0, partly: 0, assumed: 0 },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          calls: 0,
          durationMs: 1,
          promptVersion: 'test',
        },
        cancelled: false,
      };
    };
    const jobs = new JobManager(runner);
    const app = createApp({
      jobs,
      ...(options.withRepository !== false && { repository }),
      ...(options.precheck && { precheck: () => options.precheck }),
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    close = async () => {
      await jobs.whenIdle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const call = async (
      path: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers: {
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const text = buffer.toString('utf8');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return {
        status: response.status,
        headers: response.headers,
        json: json as never,
        text,
        buffer,
      };
    };
    const uid = (code: string) => cases.find((c) => c.id === code)!.uid;
    return { call, runId, uid, repository };
  }

  describe('editing a case', () => {
    it('changes the fields named and nothing else', async () => {
      const { call, uid } = await start();

      const { status, json } = await call(`/api/cases/${uid('TC-1')}`, {
        method: 'PATCH',
        body: { title: 'A better title for it', priority: 'low' },
        headers: { 'x-user': 'qa-lead' },
      });

      expect(status).toBe(200);
      expect(json).toMatchObject({
        title: 'A better title for it',
        priority: 'low',
        state: 'edited',
      });
      expect((json as { steps: string[] }).steps).toHaveLength(2);
    });

    it('records who made the change', async () => {
      const { call, uid, repository } = await start();

      await call(`/api/cases/${uid('TC-1')}`, {
        method: 'PATCH',
        body: { expected: 'A new expected result' },
        headers: { 'x-user': 'qa-lead' },
      });

      const revisions = await repository.revisions(uid('TC-1'));
      expect(revisions.at(-1)).toMatchObject({ type: 'edited', by: 'qa-lead' });
    });

    it.each([
      ['a title that is too short', { title: 'abc' }, 'title'],
      ['a type that does not exist', { type: 'e2e' }, 'type'],
      ['a field that cannot be changed', { ticket: 'SHP-9' }, ''],
      ['steps that are not a list', { steps: 'one' }, 'steps'],
    ])('rejects %s with a 400', async (_name, body, field) => {
      const { call, uid } = await start();

      const { status, json } = await call(`/api/cases/${uid('TC-1')}`, { method: 'PATCH', body });

      expect(status).toBe(400);
      const error = (json as { error: { code: string; details?: { field: string }[] } }).error;
      expect(error.code).toBe('invalid_request');
      if (field) expect(error.details?.map((d) => d.field)).toContain(field);
    });

    it('rejects a change that names nothing', async () => {
      const { call, uid } = await start();

      const { status } = await call(`/api/cases/${uid('TC-1')}`, { method: 'PATCH', body: {} });

      expect(status).toBe(400);
    });

    it('answers 404 for an unknown case and 400 for an id that is not a UUID', async () => {
      const { call } = await start();

      expect(
        (await call(`/api/cases/${UNKNOWN}`, { method: 'PATCH', body: { title: 'A new title' } }))
          .status,
      ).toBe(404);
      expect(
        (await call('/api/cases/not-a-uuid', { method: 'PATCH', body: { title: 'A new title' } }))
          .status,
      ).toBe(400);
    });
  });

  describe('deleting, restoring, approving and moving', () => {
    it('deletes a case and brings it back', async () => {
      const { call, uid } = await start();

      const deleted = await call(`/api/cases/${uid('TC-2')}`, { method: 'DELETE' });
      const restored = await call(`/api/cases/${uid('TC-2')}/restore`, { method: 'POST' });

      expect(deleted.status).toBe(200);
      expect(deleted.json).toEqual({ deleted: true });
      expect(restored.json).toMatchObject({ id: 'TC-2', state: 'generated' });
    });

    it('answers 404 when deleting or restoring an unknown case', async () => {
      const { call } = await start();

      expect((await call(`/api/cases/${UNKNOWN}`, { method: 'DELETE' })).status).toBe(404);
      expect((await call(`/api/cases/${UNKNOWN}/restore`, { method: 'POST' })).status).toBe(404);
    });

    it('approves a case, and un-approves it', async () => {
      const { call, uid } = await start();

      const on = await call(`/api/cases/${uid('TC-1')}/approve`, { method: 'POST', body: {} });
      const off = await call(`/api/cases/${uid('TC-1')}/approve`, {
        method: 'POST',
        body: { approved: false },
      });

      expect(on.json).toMatchObject({ approved: true });
      expect(off.json).toMatchObject({ approved: false });
    });

    it('does not approve a deleted case, and says why', async () => {
      const { call, uid } = await start();
      await call(`/api/cases/${uid('TC-1')}`, { method: 'DELETE' });

      const { status, json } = await call(`/api/cases/${uid('TC-1')}/approve`, {
        method: 'POST',
        body: {},
      });

      expect(status).toBe(400);
      expect((json as { error: { code: string; message: string } }).error).toMatchObject({
        code: 'not_allowed',
      });
    });

    it('answers 404 when approving an unknown case and 400 for a value that is not true or false', async () => {
      const { call, uid } = await start();

      expect(
        (await call(`/api/cases/${UNKNOWN}/approve`, { method: 'POST', body: {} })).status,
      ).toBe(404);
      expect(
        (
          await call(`/api/cases/${uid('TC-1')}/approve`, {
            method: 'POST',
            body: { approved: 'yes' },
          })
        ).status,
      ).toBe(400);
    });

    it('moves a case up and down, and reports when it could not move', async () => {
      const { call, uid } = await start();

      const moved = await call(`/api/cases/${uid('TC-2')}/move`, {
        method: 'POST',
        body: { direction: 'up' },
      });
      const top = await call(`/api/cases/${uid('TC-2')}/move`, {
        method: 'POST',
        body: { direction: 'up' },
      });

      expect(moved.json).toMatchObject({ moved: true });
      expect(top.json).toMatchObject({ moved: false });
    });

    it('rejects a direction that is not up or down', async () => {
      const { call, uid } = await start();

      const { status } = await call(`/api/cases/${uid('TC-1')}/move`, {
        method: 'POST',
        body: { direction: 'sideways' },
      });

      expect(status).toBe(400);
    });

    it('approves every case of a run at once', async () => {
      const { call, runId } = await start();

      const { status, json } = await call(`/api/runs/${runId}/approve-all`, { method: 'POST' });
      const run = await call(`/api/runs/${runId}`);

      expect(status).toBe(200);
      expect(json).toEqual({ approved: 4 });
      expect((run.json as { stats: { approved: number } }).stats.approved).toBe(4);
    });
  });

  describe('adding a case', () => {
    const body = {
      ticket: 'SHP-1',
      flow_step: 'Happy path',
      title: 'A case QA wrote by hand',
      type: 'ui',
      priority: 'medium',
      steps: ['Open the page', 'Do the thing'],
      expected: 'The thing happens',
    };

    it('adds it to the run with the next TC number', async () => {
      const { call, runId } = await start();

      const { status, json } = await call(`/api/runs/${runId}/cases`, { body });

      expect(status).toBe(201);
      expect(json).toMatchObject({ id: 'TC-5', state: 'added', ticket: 'SHP-1', approved: false });
    });

    it('rejects a case that is missing something, naming it', async () => {
      const { call, runId } = await start();
      const incomplete: Record<string, unknown> = { ...body };
      delete incomplete.expected;

      const { status, json } = await call(`/api/runs/${runId}/cases`, { body: incomplete });

      expect(status).toBe(400);
      expect(
        (json as { error: { details: { field: string }[] } }).error.details.map((d) => d.field),
      ).toContain('expected');
    });

    it('answers 404 for an unknown run', async () => {
      const { call } = await start();

      expect((await call(`/api/runs/${UNKNOWN}/cases`, { body })).status).toBe(404);
    });
  });

  describe('the run', () => {
    it('comes with the review numbers', async () => {
      const { call, runId, uid } = await start();
      await call(`/api/cases/${uid('TC-1')}`, {
        method: 'PATCH',
        body: { title: 'Reworded by QA' },
      });
      await call(`/api/cases/${uid('TC-2')}`, { method: 'DELETE' });
      await call(`/api/cases/${uid('TC-3')}/approve`, { method: 'POST', body: {} });

      const { json } = await call(`/api/runs/${runId}`);

      expect((json as { stats: unknown }).stats).toEqual({
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

    it('says the database is needed when there is none', async () => {
      const { call } = await start({ withRepository: false });

      for (const request of [
        call(`/api/cases/${UNKNOWN}`, { method: 'PATCH', body: { title: 'A new title' } }),
        call(`/api/cases/${UNKNOWN}`, { method: 'DELETE' }),
        call(`/api/runs/${UNKNOWN}/approve-all`, { method: 'POST' }),
        call(`/api/runs/${UNKNOWN}/export`),
      ]) {
        const { status, json } = await request;
        expect(status).toBe(503);
        expect((json as { error: { code: string } }).error.code).toBe('database_not_configured');
      }
    });
  });

  describe('writing one ticket again', () => {
    it('starts a job for that ticket of the saved run', async () => {
      const { call, runId } = await start();

      const { status, json, headers } = await call(`/api/runs/${runId}/regenerate`, {
        body: { ticket: 'shp-2', selfReview: false },
      });

      expect(status).toBe(202);
      const jobId = (json as { jobId: string }).jobId;
      expect(headers.get('location')).toBe(`/api/jobs/${jobId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(submitted).toEqual([
        { mode: 'ticket', value: 'SHP-2', regenerateRunId: runId, selfReview: false },
      ]);
    });

    it('refuses a ticket that is not part of the run', async () => {
      const { call, runId } = await start();

      const { status, json } = await call(`/api/runs/${runId}/regenerate`, {
        body: { ticket: 'SHP-99' },
      });

      expect(status).toBe(400);
      expect(
        (json as { error: { details: { field: string }[] } }).error.details.map((d) => d.field),
      ).toContain('ticket');
      expect(submitted).toHaveLength(0);
    });

    it('answers 404 for an unknown run and 400 for a request with no ticket', async () => {
      const { call, runId } = await start();

      expect(
        (await call(`/api/runs/${UNKNOWN}/regenerate`, { body: { ticket: 'SHP-1' } })).status,
      ).toBe(404);
      expect((await call(`/api/runs/${runId}/regenerate`, { body: {} })).status).toBe(400);
    });

    it('is refused up front when code cannot be sent', async () => {
      const { call, runId } = await start({ precheck: 'Sending code has not been approved.' });

      const { status, json } = await call(`/api/runs/${runId}/regenerate`, {
        body: { ticket: 'SHP-1' },
      });

      expect(status).toBe(400);
      expect((json as { error: { code: string } }).error.code).toBe('not_allowed');
      expect(submitted).toHaveLength(0);
    });
  });

  describe('exporting', () => {
    it('downloads Markdown by default, with the notice and the cases', async () => {
      const { call, runId } = await start();

      const { status, headers, text } = await call(`/api/runs/${runId}/export`);

      expect(status).toBe(200);
      expect(headers.get('content-type')).toContain('text/markdown');
      expect(headers.get('content-disposition')).toBe(
        'attachment; filename="test-cases-SHP-1-SHP-2.md"',
      );
      expect(text).toContain('AI draft: needs QA review');
      expect(text).toContain('Check alpha1k0 beta1k0 scenario');
    });

    it('downloads CSV with a column for the review status', async () => {
      const { call, runId } = await start();

      const { headers, text } = await call(`/api/runs/${runId}/export?format=csv`);

      expect(headers.get('content-type')).toContain('text/csv');
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text).toContain('Review status,ID,Ticket');
      expect(text.split('\r\n').filter((row) => row.startsWith('AI draft'))).toHaveLength(4);
    });

    it('downloads a Word file that contains the cases', async () => {
      const { call, runId } = await start();

      const { headers, buffer } = await call(`/api/runs/${runId}/export?format=docx`);

      expect(headers.get('content-type')).toContain('wordprocessingml');
      const zip = await JSZip.loadAsync(buffer);
      const xml = await zip.file('word/document.xml')!.async('string');
      expect(xml).toContain('AI draft: needs QA review');
      expect(xml).toContain('Check alpha1k0 beta1k0 scenario');
    });

    it('exports the edited version and leaves out deleted cases', async () => {
      const { call, runId, uid } = await start();
      await call(`/api/cases/${uid('TC-1')}`, {
        method: 'PATCH',
        body: { title: 'Reworded by the reviewer' },
      });
      await call(`/api/cases/${uid('TC-2')}`, { method: 'DELETE' });

      const { text } = await call(`/api/runs/${runId}/export`);

      expect(text).toContain('Reworded by the reviewer');
      expect(text).toContain('Edited by QA');
      expect(text).not.toContain('Check alpha1k1 beta1k1 scenario');
    });

    it('can export only the approved cases', async () => {
      const { call, runId, uid } = await start();
      await call(`/api/cases/${uid('TC-1')}/approve`, { method: 'POST', body: {} });

      const { text } = await call(`/api/runs/${runId}/export?approved=true`);

      expect(text).toContain('(approved cases)');
      expect(text).toContain('### TC-1:');
      expect(text).not.toContain('### TC-2:');
    });

    it('takes the author from the person using it', async () => {
      const { call, runId } = await start();

      const { text } = await call(`/api/runs/${runId}/export`, { headers: { 'x-user': 'Tech' } });

      expect(text).toContain('Author: Tech');
    });

    it('rejects a format it does not know, and an unknown run', async () => {
      const { call, runId } = await start();

      expect((await call(`/api/runs/${runId}/export?format=pdf`)).status).toBe(400);
      expect((await call(`/api/runs/${UNKNOWN}/export`)).status).toBe(404);
      expect((await call('/api/runs/not-a-uuid/export')).status).toBe(400);
    });
  });
});
