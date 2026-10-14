import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { CASE_TYPES, PRIORITIES } from '../ai/schemas.js';
import { caseEditSchema, type Repository } from '../db/index.js';
import { fromStoredRun, toCsv, toDocx, toMarkdown } from '../export/index.js';
import type { JobManager } from '../jobs/manager.js';
import { isFinished } from '../jobs/manager.js';
import type { GenerateInput, Job } from '../jobs/types.js';
import { rateLimit } from './rate-limit.js';

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
  /** Answers when what the server needs is available (the database). Used by /ready. */
  ready?: () => Promise<unknown>;
  /** Requests per minute for one client, and runs started per minute. Off when not set. */
  limits?: { perMinute: number; generatePerMinute: number };
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
  | 'rate_limited'
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
  rate_limited: 429,
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
 *   GET  /api/jobs/:id/tickets  the tickets as fetched from Jira, for showing on the page
 *   POST /api/jobs/:id/cancel   stop a job
 *   GET  /api/runs              saved runs (needs the database)
 *   GET  /api/runs/:id          one saved run with its cases and flow
 */
export function createApiRouter(deps: ApiDeps): express.Router {
  const router = express.Router();
  // Answers hold case text and run data, so they are never kept by a browser or a proxy.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  if (deps.limits) {
    router.use(rateLimit({ windowMs: 60_000, max: deps.limits.perMinute }));
  }
  router.use(express.json({ limit: '100kb' }));

  router.use((req, res, next) => {
    if (deps.apiToken && !checkToken(deps.apiToken, req.header('authorization'))) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      fail(res, 'unauthorized', 'A valid bearer token is required.');
      return;
    }
    next();
  });

  // Starting a run costs AI requests, so it has a tighter limit than reading does.
  if (deps.limits) {
    const startLimit = rateLimit({
      windowMs: 60_000,
      max: deps.limits.generatePerMinute,
      message: 'Too many runs were started. Wait a moment before starting another.',
    });
    router.post('/generate', startLimit);
    router.post('/runs/:id/regenerate', startLimit);
  }

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
    // The ticket text has its own route, so it is not sent again with every progress read.
    // (An undefined field is left out of the JSON.)
    res.json({
      ...job,
      ticketDetails: undefined,
      hasTicketDetails: job.ticketDetails !== undefined,
    });
  });

  router.get('/jobs/:id/tickets', (req, res) => {
    const job = deps.jobs.get(String(req.params.id));
    if (!job) {
      fail(res, 'not_found', 'There is no job with that id. Jobs are kept in memory only.');
      return;
    }
    res.json({ tickets: job.ticketDetails ?? [] });
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
      res.json({ ...run, stats: await deps.repository.runStats(run.id) });
    } catch (error) {
      next(error);
    }
  });

  // ---- reviewing a saved run ----------------------------------------------------------------

  const who = (req: express.Request) => (req.header('x-user') ?? '').trim().slice(0, 60) || 'qa';
  // The page asks this first: it answers 401 when a token is needed and was not (or wrongly) sent.
  router.get('/session', (req, res) => {
    res.json({ authRequired: Boolean(deps.apiToken), user: who(req) });
  });

  const needRepository = (res: express.Response): Repository | undefined => {
    if (!deps.repository) {
      fail(res, 'database_not_configured', 'Reviewing cases needs DATABASE_URL to be set.');
      return undefined;
    }
    return deps.repository;
  };
  const idOf = (req: express.Request, res: express.Response, name: string) => {
    const parsed = idSchema.safeParse(req.params[name]);
    if (!parsed.success) {
      fail(res, 'invalid_request', 'The id is not valid.', [
        { field: name, problem: 'It must be a UUID.' },
      ]);
      return undefined;
    }
    return parsed.data;
  };
  const line = (max: number) => z.string().trim().min(1).max(max);
  const newCaseSchema = z
    .object({
      ticket: line(40),
      flow_step: line(80),
      title: z.string().trim().min(5).max(200),
      type: z.enum(CASE_TYPES),
      priority: z.enum(PRIORITIES),
      steps: z.array(line(500)).min(1).max(30),
      expected: line(1000),
      preconditions: z.array(line(300)).max(10).default([]),
      assumptions: z.array(line(400)).max(10).default([]),
    })
    .strict();

  router.patch('/cases/:uid', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const uid = repository && idOf(req, res, 'uid');
      if (!repository || !uid) return;
      const edit = caseEditSchema.safeParse(req.body ?? {});
      if (!edit.success) {
        fail(res, 'invalid_request', 'The change is not valid.', issuesOf(edit.error));
        return;
      }
      if (Object.keys(edit.data).length === 0) {
        fail(res, 'invalid_request', 'Name at least one field to change.');
        return;
      }
      const updated = await repository.updateCase(uid, edit.data, who(req));
      if (!updated) {
        fail(res, 'not_found', 'There is no case with that id.');
        return;
      }
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/cases/:uid', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const uid = repository && idOf(req, res, 'uid');
      if (!repository || !uid) return;
      if (!(await repository.deleteCase(uid, who(req)))) {
        fail(res, 'not_found', 'There is no case with that id.');
        return;
      }
      res.json({ deleted: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/cases/:uid/restore', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const uid = repository && idOf(req, res, 'uid');
      if (!repository || !uid) return;
      if (!(await repository.restoreCase(uid, who(req)))) {
        fail(res, 'not_found', 'There is no case with that id.');
        return;
      }
      res.json(await repository.getCase(uid));
    } catch (error) {
      next(error);
    }
  });

  router.post('/cases/:uid/approve', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const uid = repository && idOf(req, res, 'uid');
      if (!repository || !uid) return;
      const body = z
        .object({ approved: z.boolean().default(true) })
        .strict()
        .safeParse(req.body ?? {});
      if (!body.success) {
        fail(res, 'invalid_request', 'The request is not valid.', issuesOf(body.error));
        return;
      }
      const existing = await repository.getCase(uid);
      if (!existing) {
        fail(res, 'not_found', 'There is no case with that id.');
        return;
      }
      if (existing.state === 'deleted') {
        fail(res, 'not_allowed', 'A deleted case cannot be approved. Restore it first.');
        return;
      }
      await repository.setApproved(uid, body.data.approved, who(req));
      res.json(await repository.getCase(uid));
    } catch (error) {
      next(error);
    }
  });

  router.post('/cases/:uid/move', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const uid = repository && idOf(req, res, 'uid');
      if (!repository || !uid) return;
      const body = z
        .object({ direction: z.enum(['up', 'down']) })
        .strict()
        .safeParse(req.body ?? {});
      if (!body.success) {
        fail(res, 'invalid_request', 'The request is not valid.', issuesOf(body.error));
        return;
      }
      if (!(await repository.getCase(uid))) {
        fail(res, 'not_found', 'There is no case with that id.');
        return;
      }
      const moved = await repository.moveCase(uid, body.data.direction, who(req));
      res.json({ moved, case: await repository.getCase(uid) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:id/cases', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const runId = repository && idOf(req, res, 'id');
      if (!repository || !runId) return;
      const body = newCaseSchema.safeParse(req.body ?? {});
      if (!body.success) {
        fail(res, 'invalid_request', 'The case is not valid.', issuesOf(body.error));
        return;
      }
      if (!(await repository.getRun(runId))) {
        fail(res, 'not_found', 'There is no run with that id.');
        return;
      }
      res.status(201).json(await repository.addCase(runId, body.data, who(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:id/approve-all', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const runId = repository && idOf(req, res, 'id');
      if (!repository || !runId) return;
      if (!(await repository.getRun(runId))) {
        fail(res, 'not_found', 'There is no run with that id.');
        return;
      }
      res.json({ approved: await repository.approveAll(runId, who(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/runs/:id/regenerate', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const runId = repository && idOf(req, res, 'id');
      if (!repository || !runId) return;
      const body = z
        .object({
          ticket: line(40),
          useCodeContext: z.boolean().optional(),
          selfReview: z.boolean().optional(),
        })
        .strict()
        .safeParse(req.body ?? {});
      if (!body.success) {
        fail(res, 'invalid_request', 'The request is not valid.', issuesOf(body.error));
        return;
      }
      const run = await repository.getRun(runId);
      if (!run) {
        fail(res, 'not_found', 'There is no run with that id.');
        return;
      }
      const ticket = body.data.ticket.toUpperCase();
      if (!run.tickets.some((t) => t.ticket.toUpperCase() === ticket)) {
        fail(res, 'invalid_request', 'That ticket is not part of this run.', [
          { field: 'ticket', problem: 'Use one of the tickets of the run.' },
        ]);
        return;
      }

      const input: GenerateInput = {
        mode: 'ticket',
        value: ticket,
        regenerateRunId: runId,
        ...(body.data.useCodeContext !== undefined && { useCodeContext: body.data.useCodeContext }),
        ...(body.data.selfReview !== undefined && { selfReview: body.data.selfReview }),
      };
      const reason = deps.precheck?.(input);
      if (reason) {
        fail(res, 'not_allowed', reason);
        return;
      }
      const job = deps.jobs.submit(input);
      res
        .status(202)
        .location('/api/jobs/' + job.id)
        .json({ jobId: job.id, status: job.status, statusUrl: '/api/jobs/' + job.id });
    } catch (error) {
      next(error);
    }
  });

  router.get('/runs/:id/export', async (req, res, next) => {
    try {
      const repository = needRepository(res);
      const runId = repository && idOf(req, res, 'id');
      if (!repository || !runId) return;
      const query = z
        .object({
          format: z.enum(['md', 'csv', 'docx']).default('md'),
          approved: z.enum(['true', 'false']).default('false'),
        })
        .safeParse(req.query);
      if (!query.success) {
        fail(res, 'invalid_request', 'The export options are not valid.', issuesOf(query.error));
        return;
      }
      const run = await repository.getRun(runId);
      if (!run) {
        fail(res, 'not_found', 'There is no run with that id.');
        return;
      }

      const onlyApproved = query.data.approved === 'true';
      const exported = fromStoredRun(
        onlyApproved ? { ...run, cases: run.cases.filter((c) => c.approved) } : run,
        {
          title: 'Test cases for ' + run.inputValue + (onlyApproved ? ' (approved cases)' : ''),
          author: who(req),
        },
      );
      const name = 'test-cases-' + run.inputValue.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40);
      const send = (type: string, extension: string, body: string | Buffer) => {
        res.setHeader('Content-Type', type);
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="' + name + '.' + extension + '"',
        );
        res.send(body);
      };

      if (query.data.format === 'csv') {
        send('text/csv; charset=utf-8', 'csv', toCsv(exported));
      } else if (query.data.format === 'docx') {
        send(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'docx',
          await toDocx(exported),
        );
      } else {
        send('text/markdown; charset=utf-8', 'md', toMarkdown(exported));
      }
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
