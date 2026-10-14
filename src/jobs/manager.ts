import { randomUUID } from 'node:crypto';
import {
  type GenerateInput,
  type Job,
  type JobRunner,
  type JobStatus,
  type ProgressUpdate,
} from './types.js';

export interface JobManagerOptions {
  /** Runs allowed at the same time. Others wait in the queue. Default 1. */
  maxConcurrent?: number;
  /** Finished jobs kept in memory, newest first. Default 100. */
  maxStored?: number;
  /** Told about an unexpected failure, so it can be logged. The caller never sees its details. */
  onError?: (error: unknown, job: Job) => void;
  /** Replaceable in tests. */
  now?: () => Date;
  newId?: () => string;
}

const FINISHED: JobStatus[] = ['done', 'failed', 'cancelled'];
export const isFinished = (status: JobStatus) => FINISHED.includes(status);

/**
 * Runs generation jobs in the background of this process, a limited number at a time.
 * Starting one returns at once; the state of a job can be read while it runs.
 * Jobs live in memory only: a run that finished is also saved by the runner when a database is set.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private running = 0;
  private idleWaiters: (() => void)[] = [];

  private readonly maxConcurrent: number;
  private readonly maxStored: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly runner: JobRunner,
    private readonly options: JobManagerOptions = {},
  ) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
    this.maxStored = Math.max(1, options.maxStored ?? 100);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** Queues a run and returns the job straight away. */
  submit(input: GenerateInput): Job {
    const job: Job = {
      id: this.newId(),
      status: 'queued',
      input,
      createdAt: this.now().toISOString(),
      cancelRequested: false,
      progress: { stage: 'queued', total: 0, done: 0, tickets: [] },
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.trim();
    this.pump();
    return this.snapshot(job);
  }

  get(id: string): Job | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : undefined;
  }

  /** Newest first. */
  list(): Job[] {
    return [...this.jobs.values()].reverse().map((job) => this.snapshot(job));
  }

  /**
   * Stops a job. A queued job is cancelled at once. A running job is told to stop starting new
   * work and ends as cancelled when the runner returns. Returns undefined for an unknown job.
   */
  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (isFinished(job.status)) return this.snapshot(job);

    job.cancelRequested = true;
    if (job.status === 'queued') {
      const at = this.queue.indexOf(id);
      if (at >= 0) this.queue.splice(at, 1);
      job.status = 'cancelled';
      job.finishedAt = this.now().toISOString();
      job.progress.stage = 'finished';
      this.notifyIdle();
    } else {
      this.controllers.get(id)?.abort();
    }
    return this.snapshot(job);
  }

  /** Cancels everything, for a server that is shutting down. */
  cancelAll(): void {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }

  /** Resolves when nothing is queued or running. Used by tests and by shutdown. */
  whenIdle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  get counts(): { queued: number; running: number } {
    return { queued: this.queue.length, running: this.running };
  }

  // ---- internals ---------------------------------------------------------------------------

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.running++;
      void this.execute(job).finally(() => {
        this.running--;
        this.controllers.delete(job.id);
        this.pump();
        this.notifyIdle();
      });
    }
  }

  private async execute(job: Job): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = 'running';
    job.startedAt = this.now().toISOString();

    try {
      const outcome = await this.runner({
        input: job.input,
        signal: controller.signal,
        report: (update) => this.apply(job, update),
      });
      job.result = outcome.result;
      if (outcome.runId !== undefined) job.runId = outcome.runId;
      job.status = outcome.cancelled || job.cancelRequested ? 'cancelled' : 'done';
    } catch (error) {
      if (job.cancelRequested && controller.signal.aborted) {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = messageFor(error);
        if (!isKnown(error)) this.options.onError?.(error, job);
      }
    } finally {
      job.finishedAt = this.now().toISOString();
      job.progress.stage = 'finished';
    }
  }

  private apply(job: Job, update: ProgressUpdate): void {
    if (isFinished(job.status)) return;
    switch (update.type) {
      case 'stage':
        job.progress.stage = update.stage;
        break;
      case 'ticket_details':
        job.ticketDetails = update.details;
        break;
      case 'tickets':
        job.progress.tickets = update.tickets.map((ticket) => ({ ticket, status: 'pending' }));
        job.progress.total = update.tickets.length;
        job.progress.done = 0;
        break;
      case 'ticket': {
        const entry = job.progress.tickets.find((t) => t.ticket === update.ticket);
        if (!entry) break;
        entry.status = update.status;
        if (update.cases !== undefined) entry.cases = update.cases;
        if (update.error !== undefined) entry.error = update.error;
        job.progress.done = job.progress.tickets.filter(
          (t) => t.status === 'ok' || t.status === 'failed' || t.status === 'skipped',
        ).length;
        break;
      }
    }
  }

  /** Keeps memory bounded: the oldest finished jobs go first. */
  private trim(): void {
    if (this.jobs.size <= this.maxStored) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.maxStored) break;
      if (isFinished(job.status)) this.jobs.delete(id);
    }
  }

  private snapshot(job: Job): Job {
    return structuredClone(job);
  }

  private notifyIdle(): void {
    if (this.running === 0 && this.queue.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

const KNOWN_ERRORS = [
  'RunError',
  'JiraError',
  'AIError',
  'GitHubError',
  'GenerationError',
  'ConfigError',
];

/** Errors from our own code and clients are written for people. Anything else is not shown. */
const isKnown = (error: unknown): boolean =>
  error instanceof Error && KNOWN_ERRORS.includes(error.name);

const messageFor = (error: unknown): string =>
  isKnown(error) ? (error as Error).message : 'The run failed unexpectedly. See the server log.';
