import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager } from '../../../src/jobs/manager.js';
import type { JobResult, JobRunner } from '../../../src/jobs/types.js';
import { createApp } from '../../../src/server/app.js';

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

const DESCRIPTION = 'The full description. '.repeat(40);

interface ApiBody {
  tickets?: { key: string; summary: string; description: string }[];
  hasTicketDetails?: boolean;
  status?: string;
  error?: { code: string };
  ticketDetails?: unknown;
}

const runner: JobRunner = ({ report }) => {
  report({
    type: 'ticket_details',
    details: [
      {
        key: 'SHP-1',
        url: 'https://example.atlassian.net/browse/SHP-1',
        summary: 'Summary of SHP-1',
        type: 'Story',
        status: 'Done',
        description: DESCRIPTION,
        labels: [],
        commentCount: 0,
        comments: [],
        truncated: false,
      },
    ],
  });
  report({ type: 'tickets', tickets: ['SHP-1'] });
  return Promise.resolve({ result: emptyResult, cancelled: false });
};

describe('the ticket text of a job', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start() {
    const jobs = new JobManager(runner);
    const server = createApp({ jobs }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    close = () =>
      new Promise((resolve) => {
        jobs.cancelAll();
        server.close(() => resolve());
      });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (path: string) => {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, body: (await response.json()) as ApiBody };
    };
    const submit = async () => {
      const response = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'ticket', value: 'SHP-1' }),
      });
      const { jobId } = (await response.json()) as { jobId: string };
      await jobs.whenIdle();
      return jobId;
    };
    return { get, submit };
  }

  it('is served by its own route, with the whole text', async () => {
    const { get, submit } = await start();
    const id = await submit();

    const { status, body } = await get(`/api/jobs/${id}/tickets`);

    expect(status).toBe(200);
    expect(body.tickets).toHaveLength(1);
    expect(body.tickets?.[0]).toMatchObject({
      key: 'SHP-1',
      summary: 'Summary of SHP-1',
      description: DESCRIPTION,
    });
  });

  it('is not sent again with every progress read, which says it is there', async () => {
    const { get, submit } = await start();
    const id = await submit();

    const { body } = await get(`/api/jobs/${id}`);

    expect(body).not.toHaveProperty('ticketDetails');
    expect(JSON.stringify(body)).not.toContain('The full description');
    expect(body.hasTicketDetails).toBe(true);
    expect(body.status).toBe('done');
  });

  it('answers 404 for a job that does not exist', async () => {
    const { get } = await start();

    const { status, body } = await get('/api/jobs/not-a-job/tickets');

    expect(status).toBe(404);
    expect(body.error?.code).toBe('not_found');
  });

  it('is not in the list of jobs', async () => {
    const { get, submit } = await start();
    await submit();

    const { body } = await get('/api/jobs');

    expect(JSON.stringify(body)).not.toContain('The full description');
  });
});
