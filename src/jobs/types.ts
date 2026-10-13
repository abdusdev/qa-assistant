import type { Flow, TestCase } from '../ai/schemas.js';
import type { AIUsage } from '../ai/types.js';
import type { InputMode } from '../jira/resolver.js';
import type { TicketOutcome } from '../pipeline/run.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** What a person asks for when they start a run. */
export interface GenerateInput {
  mode: InputMode;
  /** A ticket key, pasted keys, a sprint name, an epic key or a version, depending on the mode. */
  value: string;
  filters?: { types?: string[]; statuses?: string[] };
  /** Most tickets used in one run. */
  max?: number;
  /** Include each ticket's pull request changes. Default: the server setting. */
  useCodeContext?: boolean;
  /** Let the model review its own draft. Default true. */
  selfReview?: boolean;
  /**
   * Write the cases of this one ticket again and swap them into a saved run, leaving every other
   * ticket and every case QA added alone. `mode` is `ticket` and `value` is the ticket key.
   */
  regenerateRunId?: string;
}

export type JobStage = 'queued' | 'resolving' | 'generating' | 'ordering' | 'saving' | 'finished';

export interface JobTicketProgress {
  ticket: string;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  cases?: number;
  error?: string;
}

export interface JobProgress {
  stage: JobStage;
  total: number;
  done: number;
  tickets: JobTicketProgress[];
}

/** What a finished run returns. The same data is saved as a run when a database is set up. */
export interface JobResult {
  cases: TestCase[];
  flow: Flow;
  flowSource: 'ai' | 'fallback' | 'none';
  tickets: TicketOutcome[];
  warnings: string[];
  grounding: { grounded: number; partly: number; assumed: number };
  usage: AIUsage;
  calls: number;
  durationMs: number;
  promptVersion: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  input: GenerateInput;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** True once a cancel was asked for, until the run has actually stopped. */
  cancelRequested: boolean;
  progress: JobProgress;
  /** Set when the run was saved to the database. */
  runId?: string;
  result?: JobResult;
  /** Why the run failed, in words that are safe to show. */
  error?: string;
}

/** What a runner reports while it works. */
export type ProgressUpdate =
  | { type: 'stage'; stage: JobStage }
  | { type: 'tickets'; tickets: string[] }
  | {
      type: 'ticket';
      ticket: string;
      status: JobTicketProgress['status'];
      cases?: number;
      error?: string;
    };

export interface RunnerContext {
  input: GenerateInput;
  /** Aborted when the run is cancelled: no new AI calls should start after that. */
  signal: AbortSignal;
  report: (update: ProgressUpdate) => void;
}

export interface RunnerOutcome {
  result: JobResult;
  /** The id of the saved run, when it was saved. */
  runId?: string;
  /** True when the run stopped early because it was cancelled. */
  cancelled: boolean;
}

/** Does the work of one run. The real one resolves tickets, builds context and calls the pipeline. */
export type JobRunner = (context: RunnerContext) => Promise<RunnerOutcome>;

/** An error whose message is meant for the person who started the run. */
export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunError';
  }
}
