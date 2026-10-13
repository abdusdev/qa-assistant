import { expect, test, type APIRequestContext } from '@playwright/test';

interface JobBody {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: { stage: string; total: number; done: number };
  runId?: string;
  error?: string;
  result?: {
    cases: { id: string; ticket: string }[];
    flow: { steps: { caseIds: string[] }[] };
    calls: number;
  };
}

/** Polls a job until it is no longer queued or running. */
async function finished(request: APIRequestContext, jobId: string): Promise<JobBody> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request.get(`/api/jobs/${jobId}`);
    const job = (await response.json()) as JobBody;
    if (job.status !== 'queued' && job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} did not finish`);
}

test.describe('the generate API, offline with the demo AI and fixture tickets', () => {
  test('a full run, from request to results and history', async ({ request }) => {
    const start = await request.post('/api/generate', {
      data: { mode: 'list', value: 'EVAL-1 EVAL-2', useCodeContext: false },
    });

    expect(start.status()).toBe(202);
    const { jobId, statusUrl } = (await start.json()) as { jobId: string; statusUrl: string };
    expect(statusUrl).toBe(`/api/jobs/${jobId}`);

    const job = await finished(request, jobId);

    expect(job.status).toBe('done');
    expect(job.progress).toMatchObject({ stage: 'finished', total: 2, done: 2 });
    expect(job.result?.cases).toHaveLength(4);
    expect(new Set(job.result?.cases.map((c) => c.ticket))).toEqual(new Set(['EVAL-1', 'EVAL-2']));
    const ordered = job.result?.flow.steps.flatMap((s) => s.caseIds) ?? [];
    expect(ordered.sort()).toEqual(['TC-1', 'TC-2', 'TC-3', 'TC-4']);

    // The same run is in the history.
    expect(job.runId).toBeTruthy();
    const run = await request.get(`/api/runs/${job.runId}`);
    expect(run.status()).toBe(200);
    expect(await run.json()).toMatchObject({ status: 'completed', inputValue: 'EVAL-1 EVAL-2' });

    const list = (await (await request.get('/api/runs')).json()) as { runs: { id: string }[] };
    expect(list.runs.map((r) => r.id)).toContain(job.runId);
  });

  test('invalid input is a 400 that names the problem', async ({ request }) => {
    const response = await request.post('/api/generate', { data: { mode: 'ticket', value: '' } });

    expect(response.status()).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details: { field: string }[] };
    };
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.details.map((d) => d.field)).toContain('value');
  });

  test('a ticket that does not exist ends as a failed job with a clear message', async ({
    request,
  }) => {
    const start = await request.post('/api/generate', {
      data: { mode: 'ticket', value: 'EVAL-404', useCodeContext: false },
    });
    const { jobId } = (await start.json()) as { jobId: string };

    const job = await finished(request, jobId);

    expect(job.status).toBe('failed');
    expect(job.error).toContain('EVAL-404');
  });

  test('a queued job can be cancelled, and cancelling a finished job is a 409', async ({
    request,
  }) => {
    const done = await request.post('/api/generate', {
      data: { mode: 'ticket', value: 'EVAL-1', useCodeContext: false },
    });
    const { jobId } = (await done.json()) as { jobId: string };
    await finished(request, jobId);

    const again = await request.post(`/api/jobs/${jobId}/cancel`);

    expect(again.status()).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      'already_finished',
    );
  });

  test('an unknown job is a 404', async ({ request }) => {
    const response = await request.get('/api/jobs/not-a-real-job');

    expect(response.status()).toBe(404);
  });
});
