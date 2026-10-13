import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { openPglite } from '../../../src/db/pglite.js';
import { Repository } from '../../../src/db/repository.js';
import type { Db } from '../../../src/db/types.js';
import { JobManager } from '../../../src/jobs/manager.js';
import {
  RunError,
  type JobResult,
  type JobRunner,
  type RunnerContext,
} from '../../../src/jobs/types.js';
import type { ApiDeps } from '../../../src/server/api.js';
import { createApp } from '../../../src/server/app.js';
import { resetDatabase, sampleResult } from '../db/support.js';

const emptyResult: JobResult = {
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
};

/** A runner that finishes at once, or waits to be cancelled. */
const runnerFor =
  (behaviour: 'finish' | 'wait' | 'fail' = 'finish'): JobRunner =>
  ({ signal, report }: RunnerContext) => {
    report({ type: 'tickets', tickets: ['SHP-1'] });
    if (behaviour === 'fail') return Promise.reject(new RunError('No tickets matched the input.'));
    if (behaviour === 'wait') {
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ result: emptyResult, cancelled: true })),
      );
    }
    report({ type: 'ticket', ticket: 'SHP-1', status: 'ok', cases: 3 });
    return Promise.resolve({
      result: { ...emptyResult, calls: 1 },
      runId: 'run-1',
      cancelled: false,
    });
  };

describe('the generate API', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(
    behaviour: 'finish' | 'wait' | 'fail' = 'finish',
    extra: Partial<ApiDeps> = {},
  ) {
    const jobs = new JobManager(runnerFor(behaviour));
    const app = createApp({ jobs, ...extra });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    close = () =>
      new Promise((resolve) => {
        jobs.cancelAll();
        server.close(() => resolve());
      });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const call = async (
      path: string,
      init: { method?: string; body?: unknown; raw?: string; token?: string } = {},
    ) => {
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? (init.body !== undefined || init.raw ? 'POST' : 'GET'),
        headers: {
          ...(init.body !== undefined || init.raw ? { 'content-type': 'application/json' } : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        ...(init.raw !== undefined
          ? { body: init.raw }
          : init.body !== undefined
            ? { body: JSON.stringify(init.body) }
            : {}),
      });
      return {
        status: response.status,
        headers: response.headers,
        body: (await response.json()) as never,
      };
    };
    return { call, jobs };
  }

  describe('starting a run', () => {
    it('answers at once with 202 and a job id to read', async () => {
      const { call } = await start('wait');

      const { status, body, headers } = await call('/api/generate', {
        body: { mode: 'ticket', value: 'SHP-4103' },
      });

      expect(status).toBe(202);
      expect(body).toMatchObject({ status: expect.stringMatching(/queued|running/) });
      const jobId = (body as { jobId: string }).jobId;
      expect(headers.get('location')).toBe(`/api/jobs/${jobId}`);
      expect((body as { statusUrl: string }).statusUrl).toBe(`/api/jobs/${jobId}`);
    });

    it('accepts filters, a ticket limit and the code and review switches', async () => {
      const { call } = await start();

      const { status } = await call('/api/generate', {
        body: {
          mode: 'sprint',
          value: 'SN - Sprint 45',
          filters: { types: ['Bug'], statuses: ['Review'] },
          max: 10,
          useCodeContext: false,
          selfReview: false,
        },
      });

      expect(status).toBe(202);
    });

    it.each([
      ['no body', undefined, 'value'],
      ['an unknown mode', { mode: 'everything', value: 'SHP-1' }, 'mode'],
      ['an empty value', { mode: 'ticket', value: '   ' }, 'value'],
      ['a value that is not text', { mode: 'ticket', value: 12 }, 'value'],
      ['a limit of zero', { mode: 'list', value: 'SHP-1', max: 0 }, 'max'],
      ['a limit that is too large', { mode: 'list', value: 'SHP-1', max: 5000 }, 'max'],
      [
        'a switch that is not true or false',
        { mode: 'ticket', value: 'SHP-1', useCodeContext: 'yes' },
        'useCodeContext',
      ],
      ['a field that does not exist', { mode: 'ticket', value: 'SHP-1', surprise: true }, ''],
      [
        'filters that are not a list',
        { mode: 'list', value: 'SHP-1', filters: { types: 'Bug' } },
        'filters.types',
      ],
    ])('rejects %s with a 400 that names the problem', async (_name, body, field) => {
      const { call } = await start();

      const response = await call('/api/generate', {
        method: 'POST',
        ...(body !== undefined ? { body } : { raw: '{}' }),
      });

      expect(response.status).toBe(400);
      const error = (
        response.body as { error: { code: string; message: string; details?: { field: string }[] } }
      ).error;
      expect(error.code).toBe('invalid_request');
      expect(error.message).toBeTruthy();
      if (field) expect(error.details?.map((d) => d.field)).toContain(field);
    });

    it('rejects a body that is not JSON', async () => {
      const { call } = await start();

      const { status, body } = await call('/api/generate', { raw: '{ not json' });

      expect(status).toBe(400);
      expect((body as { error: { code: string } }).error.code).toBe('invalid_json');
    });

    it('rejects a body that is too large', async () => {
      const { call } = await start();

      const { status, body } = await call('/api/generate', {
        raw: JSON.stringify({ mode: 'ticket', value: 'x'.repeat(200_000) }),
      });

      expect(status).toBe(413);
      expect((body as { error: { code: string } }).error.code).toBe('payload_too_large');
    });

    it('refuses release input unless it is enabled', async () => {
      const off = await start();
      const refused = await off.call('/api/generate', {
        body: { mode: 'release', value: '2.14.0' },
      });
      await close?.();

      const on = await start('finish', { enableRelease: true });
      const accepted = await on.call('/api/generate', {
        body: { mode: 'release', value: '2.14.0' },
      });

      expect(refused.status).toBe(400);
      expect(accepted.status).toBe(202);
    });

    it('refuses a run that cannot be allowed, with the reason, before queueing it', async () => {
      const { call, jobs } = await start('finish', {
        precheck: () => 'Sending code has not been approved.',
      });

      const { status, body } = await call('/api/generate', {
        body: { mode: 'ticket', value: 'SHP-1' },
      });

      expect(status).toBe(400);
      expect((body as { error: { code: string; message: string } }).error).toMatchObject({
        code: 'not_allowed',
        message: 'Sending code has not been approved.',
      });
      expect(jobs.list()).toHaveLength(0);
    });
  });

  describe('reading a job', () => {
    it('shows the progress and, when done, the results', async () => {
      const { call, jobs } = await start('finish');
      const { body } = await call('/api/generate', { body: { mode: 'ticket', value: 'SHP-1' } });
      await jobs.whenIdle();

      const job = await call(`/api/jobs/${(body as { jobId: string }).jobId}`);

      expect(job.status).toBe(200);
      expect(job.body).toMatchObject({
        status: 'done',
        runId: 'run-1',
        progress: { stage: 'finished', total: 1, done: 1 },
        result: { calls: 1 },
      });
    });

    it('shows a failure with a message that is safe to read', async () => {
      const { call, jobs } = await start('fail');
      const { body } = await call('/api/generate', { body: { mode: 'ticket', value: 'SHP-1' } });
      await jobs.whenIdle();

      const job = await call(`/api/jobs/${(body as { jobId: string }).jobId}`);

      expect(job.body).toMatchObject({ status: 'failed', error: 'No tickets matched the input.' });
    });

    it('answers 404 for an unknown job', async () => {
      const { call } = await start();

      const { status, body } = await call('/api/jobs/does-not-exist');

      expect(status).toBe(404);
      expect((body as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('lists recent jobs without their results', async () => {
      const { call, jobs } = await start('finish');
      await call('/api/generate', { body: { mode: 'ticket', value: 'SHP-1' } });
      await call('/api/generate', { body: { mode: 'ticket', value: 'SHP-2' } });
      await jobs.whenIdle();

      const { body } = await call('/api/jobs');

      const list = (body as { jobs: Record<string, unknown>[] }).jobs;
      expect(list).toHaveLength(2);
      expect(list[0]).not.toHaveProperty('result');
      expect(list[0]).toMatchObject({ status: 'done', progress: { done: 1, total: 1 } });
    });
  });

  describe('cancelling', () => {
    it('stops a running job', async () => {
      const { call, jobs } = await start('wait');
      const { body } = await call('/api/generate', { body: { mode: 'ticket', value: 'SHP-1' } });
      const id = (body as { jobId: string }).jobId;
      await new Promise((resolve) => setTimeout(resolve, 5));

      const cancel = await call(`/api/jobs/${id}/cancel`, { method: 'POST' });
      await jobs.whenIdle();
      const after = await call(`/api/jobs/${id}`);

      expect(cancel.status).toBe(202);
      expect(after.body).toMatchObject({ status: 'cancelled' });
    });

    it('answers 409 for a job that has already finished and 404 for an unknown one', async () => {
      const { call, jobs } = await start('finish');
      const { body } = await call('/api/generate', { body: { mode: 'ticket', value: 'SHP-1' } });
      await jobs.whenIdle();

      const finished = await call(`/api/jobs/${(body as { jobId: string }).jobId}/cancel`, {
        method: 'POST',
      });
      const unknown = await call('/api/jobs/nope/cancel', { method: 'POST' });

      expect(finished.status).toBe(409);
      expect((finished.body as { error: { code: string } }).error.code).toBe('already_finished');
      expect(unknown.status).toBe(404);
    });
  });

  describe('access', () => {
    it('lets a request through only with the bearer token, when one is set', async () => {
      const { call } = await start('finish', { apiToken: 'a-long-enough-token' });
      const request = { body: { mode: 'ticket', value: 'SHP-1' } };

      const none = await call('/api/generate', request);
      const wrong = await call('/api/generate', { ...request, token: 'a-different-token!!' });
      const right = await call('/api/generate', { ...request, token: 'a-long-enough-token' });

      expect(none.status).toBe(401);
      expect(none.headers.get('www-authenticate')).toBe('Bearer');
      expect((none.body as { error: { code: string } }).error.code).toBe('unauthorized');
      expect(wrong.status).toBe(401);
      expect(right.status).toBe(202);
    });

    it('leaves the health check open', async () => {
      const { call } = await start('finish', { apiToken: 'a-long-enough-token' });

      expect((await call('/health')).status).toBe(200);
    });
  });

  describe('other', () => {
    it('answers an unknown endpoint under /api with the same error shape', async () => {
      const { call } = await start();

      const { status, body } = await call('/api/nothing-here');

      expect(status).toBe(404);
      expect((body as { error: { code: string } }).error.code).toBe('not_found');
    });

    it('keeps the plain app free of the API when no dependencies are given', async () => {
      const server = createApp().listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;

      const response = await fetch(`http://127.0.0.1:${port}/api/jobs`);
      await new Promise<void>((resolve) => server.close(() => resolve()));

      expect(response.status).toBe(404);
    });
  });
});

describe('run history', () => {
  let db: Db;
  let repository: Repository;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    db = await openPglite();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(withRepository: boolean) {
    await resetDatabase(db);
    await migrate(db);
    repository = new Repository(db);
    const app = createApp({
      jobs: new JobManager(runnerFor()),
      ...(withRepository && { repository }),
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (path: string) => {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, body: (await response.json()) as never };
    };
  }

  const saveOne = async () => {
    const result = await sampleResult({ keys: ['SHP-1'], casesPerTicket: 2 });
    const runId = await repository.createRun({
      mode: 'ticket',
      value: 'SHP-1',
      promptVersion: result.promptVersion,
    });
    await repository.saveResult(runId, result);
    return runId;
  };

  it('lists saved runs and reads one with its cases', async () => {
    const get = await start(true);
    const runId = await saveOne();

    const list = await get('/api/runs');
    const one = await get(`/api/runs/${runId}`);

    expect(list.status).toBe(200);
    expect((list.body as { runs: { id: string; caseCount: number }[] }).runs[0]).toMatchObject({
      id: runId,
      caseCount: 2,
    });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: runId, status: 'completed' });
    expect((one.body as { cases: unknown[] }).cases).toHaveLength(2);
  });

  it('pages the list', async () => {
    const get = await start(true);
    await saveOne();
    await saveOne();
    await saveOne();

    const first = await get('/api/runs?limit=2');
    const rest = await get('/api/runs?limit=2&offset=2');

    expect((first.body as { runs: unknown[] }).runs).toHaveLength(2);
    expect((rest.body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('rejects paging values that are not valid', async () => {
    const get = await start(true);

    expect((await get('/api/runs?limit=0')).status).toBe(400);
    expect((await get('/api/runs?limit=abc')).status).toBe(400);
    expect((await get('/api/runs?offset=-1')).status).toBe(400);
  });

  it('answers 400 for an id that is not a UUID and 404 for one that does not exist', async () => {
    const get = await start(true);

    expect((await get('/api/runs/not-a-uuid')).status).toBe(400);
    const missing = await get('/api/runs/7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11');
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('says the database is not set up when there is none', async () => {
    const get = await start(false);

    const list = await get('/api/runs');
    const one = await get('/api/runs/7b0c6f0a-3c1e-4b43-9d7e-0a2f3f2d9b11');

    expect(list.status).toBe(503);
    expect((list.body as { error: { code: string } }).error.code).toBe('database_not_configured');
    expect(one.status).toBe(503);
  });
});
