import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import type { Repository } from '../db/index.js';
import type { JobManager } from '../jobs/manager.js';
import { isFinished } from '../jobs/manager.js';
import type { GenerateInput, Job } from '../jobs/types.js';

export interface ApiDeps {
  jobs: JobManager;
  /** Needed for the run history endpoints. Without it they answer 503. */
  repository?: Repository;
  /** When set, every request must send it as a bearer token. */
  apiToken?: string;
  /** Release (fix version) input is off until the team confirms it is used. */
  enableRelease?: boolean;
  /** Returns the reason a request cannot run, so it is refused at once instead of failing later. */
  precheck?: (input: GenerateInput) => string | undefined;
  /** Called for an unexpected error, so it can be logged. Never shown to the caller. */
  onError?: (error: unknown) => void;
}

export type ErrorCode =
  | 'invalid_request'
  | 'invalid_json'
  | 'payload_too_large'
  | 'unauthorized'
  | 'not_found'
  | 'already_finished'
  | 'not_allowed'
  | 'database_not_configured'
  | 'internal_error';

/** Every error answer has this one shape. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: { field: string; problem: string }[] };
}

const STATUS_OF: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_json: 400,
  payload_too_large: 413,
  unauthorized: 401,
  not_found: 404,
  already_finished: 409,
  not_allowed: 400,
  database_not_configured: 503,
  internal_error: 500,
};

function fail(
  res: express.Response,
  code: ErrorCode,
  message: string,
  details?: ErrorBody['error']['details'],
): void {
  const body: ErrorBody = { error: { code, message, ...(details && { details }) } };
  res.status(STATUS_OF[code]).json(body);
}

const names = z.array(z.string().trim().min(1).max(60)).max(20);

export const generateSchema = z
  .object({
    mode: z.enum(['ticket', 'list', 'sprint', 'epic', 'release']),
    value: z
      .string()
      .trim()
      .min(1, 'Give a ticket key, a list, a sprint, an epic or a release.')
      .max(2000),
    filters: z.object({ types: names.optional(), statuses: names.optional() }).strict().optional(),
    max: z.number().int().min(1).max(200).optional(),
    useCodeContext: z.boolean().optional(),
    selfReview: z.boolean().optional(),
  })
  .strict();

const idSchema = z.uuid();
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const issuesOf = (error: z.ZodError) =>
  error.issues.map((issue) => ({
    field: issue.path.join('.') || 'body',
    problem: issue.message,
  }));

/** A job without its heavy result, for lists. */
const summaryOf = (job: Job) => ({
  id: job.id,
  status: job.status,
  input: job.input,
  createdAt: job.createdAt,
  ...(job.startedAt && { startedAt: job.startedAt }),
  ...(job.finishedAt && { finishedAt: job.finishedAt }),
  progress: { stage: job.progress.stage, total: job.progress.total, done: job.progress.done },
  ...(job.runId && { runId: job.runId }),
  ...(job.error && { error: job.error }),
});

function checkToken(expected: string, header: string | undefined): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The HTTP API. Starting a run returns at once with a job id; the job is then read while it runs.
 *
 *   POST /api/generate          start a run
 *   GET  /api/jobs              recent jobs
 *   GET  /api/jobs/:id          one job: status, progress and, when done, the results
 *   POST /api/jobs/:id/cancel   stop a job
 *   GET  /api/runs              saved runs (needs the database)
 *   GET  /api/runs/:id          one saved run with its cases and flow
 */
export function createApiRouter(deps: ApiDeps): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));

  router.use((req, res, next) => {
    if (deps.apiToken && !checkToken(deps.apiToken, req.header('authorization'))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      fail(res, 'unauthorized', 'A valid bearer token is required.');
      return;
    }
    next();
  });

  router.post('/generate', (req, res) => {
    const parsed = generateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      fail(res, 'invalid_request', 'The request is not valid.', issuesOf(parsed.error));
      return;
    }

    const input: GenerateInput = parsed.data;
    if (input.mode === 'release' && !deps.enableRelease) {
      fail(res, 'invalid_request', 'Release input is not enabled on this server.', [
        { field: 'mode', problem: 'Use ticket, list, sprint or epic.' },
      ]);
      return;
    }
    const reason = deps.precheck?.(input);
    if (reason) {
      fail(res, 'not_allowed', reason);
      return;
    }

    const job = deps.jobs.submit(input);
    res
      .status(202)
      .location(`/api/jobs/${job.id}`)
      .json({ jobId: job.id, status: job.status, statusUrl: `/api/jobs/${job.id}` });
  });

  router.get('/jobs', (_req, res) => {
    res.json({ jobs: deps.jobs.list().map(summaryOf) });
  });

  router.get('/jobs/:id', (req, res) => {
    const job = deps.jobs.get(String(req.params.id));
    if (!job) {
      fail(res, 'not_found', 'There is no job with that id. Jobs are kept in memory only.');
      return;
    }
    res.json(job);
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    const id = String(req.params.id);
    const existing = deps.jobs.get(id);
    if (!existing) {
      fail(res, 'not_found', 'There is no job with that id.');
      return;
    }
    if (isFinished(existing.status)) {
      fail(res, 'already_finished', `The job has already ${existing.status}.`);
      return;
    }
    res.status(202).json(summaryOf(deps.jobs.cancel(id) as Job));
  });

  router.get('/runs', async (req, res, next) => {
    try {
      if (!deps.repository) {
        fail(res, 'database_not_configured', 'Run history needs DATABASE_URL to be set.');
        return;
      }
      const page = pageSchema.safeParse(req.query);
      if (!page.success) {
        fail(res, 'invalid_request', 'The paging values are not valid.', issuesOf(page.error));
        return;
      }
      res.json({ runs: await deps.repository.listRuns(page.data.limit, page.data.offset) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs/:id', async (req, res, next) => {
    try {
      if (!deps.repository) {
        fail(res, 'database_not_configured', 'Run history needs DATABASE_URL to be set.');
        return;
      }
      const id = idSchema.safeParse(req.params.id);
      if (!id.success) {
        fail(res, 'invalid_request', 'The run id is not valid.', [
          { field: 'id', problem: 'It must be a UUID.' },
        ]);
        return;
      }
      const run = await deps.repository.getRun(id.data);
      if (!run) {
        fail(res, 'not_found', 'There is no run with that id.');
        return;
      }
      res.json(run);
    } catch (error) {
      next(error);
    }
  });

  router.use((_req, res) => {
    fail(res, 'not_found', 'There is no such endpoint.');
  });

  router.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const type = (error as { type?: string } | null)?.type;
      if (type === 'entity.parse.failed') {
        fail(res, 'invalid_json', 'The body is not valid JSON.');
      } else if (type === 'entity.too.large') {
        fail(res, 'payload_too_large', 'The body is too large.');
      } else {
        deps.onError?.(error);
        fail(res, 'internal_error', 'Something went wrong. See the server log.');
      }
    },
  );

  return router;
}
