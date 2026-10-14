/**
 * What the interface needs to know about the API. Kept small on purpose: only the fields it
 * shows. The end-to-end tests run the real server against these shapes.
 */

export type Mode = 'ticket' | 'list' | 'sprint' | 'epic' | 'release';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type Grounding = 'grounded' | 'partly' | 'assumed';

export interface GenerateRequest {
  mode: Mode;
  value: string;
  filters?: { types?: string[]; statuses?: string[] };
  max?: number;
  useCodeContext?: boolean;
  selfReview?: boolean;
}

export interface CaseSource {
  from: string;
  quote: string;
}

export interface ApiCase {
  /** Only on a saved run: the database id used to edit the case. */
  uid?: string;
  /** Only on a saved run: a person has read this case and accepted it. */
  approved?: boolean;
  id: string;
  ticket: string;
  flow_step: string;
  title: string;
  type: string;
  priority: string;
  preconditions: string[];
  steps: string[];
  expected: string;
  sources: CaseSource[];
  assumptions: string[];
  depends_on: string[];
  covers?: string[];
  grounding: Grounding;
  /** Only on a saved run: what QA did with the case. */
  state?: 'generated' | 'edited' | 'added' | 'deleted';
}

export interface ApiFlowStep {
  order: number;
  name: string;
  description: string;
  caseIds: string[];
}

export interface TicketProgress {
  ticket: string;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  cases?: number;
  error?: string;
}

export interface TicketOutcome {
  ticket: string;
  status: 'ok' | 'failed' | 'skipped';
  cases: number;
  model?: string;
  cached?: boolean;
  detail?: { sufficient: boolean; missing: string[] };
  error?: string;
}

export interface JobResult {
  cases: ApiCase[];
  flow: { steps: ApiFlowStep[] };
  flowSource: string;
  tickets: TicketOutcome[];
  warnings: string[];
  grounding: { grounded: number; partly: number; assumed: number };
  usage: { totalTokens: number };
  calls: number;
  durationMs: number;
}

/** A ticket as fetched from Jira, with its text, so the page can show what the cases come from. */
export interface TicketDetail {
  key: string;
  url: string;
  summary: string;
  type: string;
  status: string;
  description: string;
  acceptanceCriteria?: string;
  labels: string[];
  components?: string[];
  parentKey?: string;
  updated?: string;
  commentCount: number;
  comments: { author: string; created: string; body: string }[];
  truncated: boolean;
}

export interface ApiJob {
  id: string;
  status: JobStatus;
  input: GenerateRequest;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequested: boolean;
  progress: { stage: string; total: number; done: number; tickets: TicketProgress[] };
  /** True once the ticket text has been fetched and can be read from the tickets route. */
  hasTicketDetails?: boolean;
  runId?: string;
  result?: JobResult;
  error?: string;
}

export interface ApiRunSummary {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  inputMode: string;
  inputValue: string;
  model: string | null;
  totalTokens: number;
  caseCount: number;
  error: string | null;
}

export interface RunStats {
  generated: number;
  kept: number;
  edited: number;
  deleted: number;
  added: number;
  approved: number;
  total: number;
  keptShare: number;
}

export interface ApiRun extends ApiRunSummary {
  stats?: RunStats;
  warnings: string[];
  flow: { position: number; name: string; description: string; caseCodes: string[] }[];
  cases: ApiCase[];
  tickets: {
    ticket: string;
    status: 'ok' | 'failed' | 'skipped';
    cases: number;
    model: string | null;
    cached: boolean;
    error: string | null;
    detail: { sufficient: boolean; missing: string[] } | null;
    /** The ticket text the cases were written against. Null for runs saved before it was kept. */
    snapshot?: TicketDetail | null;
  }[];
  calls: number;
  durationMs: number | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: { field: string; problem: string }[] };
}
