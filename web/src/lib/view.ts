import type {
  ApiCase,
  ApiJob,
  ApiRun,
  GenerateRequest,
  Grounding,
  JobStatus,
  Mode,
  TicketOutcome,
} from './types.js';

// ---- the form ----------------------------------------------------------------------------------

export interface FormState {
  mode: Mode;
  value: string;
  types: string;
  statuses: string;
  max: string;
  useCodeContext: boolean;
  selfReview: boolean;
}

export const emptyForm: FormState = {
  mode: 'ticket',
  value: '',
  types: '',
  statuses: '',
  max: '',
  useCodeContext: true,
  selfReview: true,
};

export const MODES: { mode: Mode; label: string; hint: string; placeholder: string }[] = [
  { mode: 'ticket', label: 'Ticket', hint: 'One ticket key.', placeholder: 'SHP-4103' },
  {
    mode: 'list',
    label: 'List',
    hint: 'Several keys, or paste any text that contains keys.',
    placeholder: 'SHP-4103, SHP-4104 SHP-4105',
  },
  { mode: 'sprint', label: 'Sprint', hint: 'The name of a sprint.', placeholder: 'SN - Sprint 45' },
  { mode: 'epic', label: 'Epic', hint: 'The key of an epic.', placeholder: 'SHP-4110' },
];

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** Returns what is wrong with the form in words, or undefined when it can be sent. */
export function formProblem(form: FormState): string | undefined {
  if (form.value.trim() === '') {
    return form.mode === 'sprint'
      ? 'Enter the name of a sprint.'
      : form.mode === 'epic'
        ? 'Enter the key of an epic.'
        : 'Enter a ticket key.';
  }
  if (form.max.trim() !== '') {
    const max = Number(form.max);
    if (!Number.isInteger(max) || max < 1 || max > 200) {
      return 'The most tickets must be a whole number from 1 to 200.';
    }
  }
  return undefined;
}

/** The request the API expects. Empty filters and an empty limit are left out. */
export function buildRequest(form: FormState): GenerateRequest {
  const types = splitList(form.types);
  const statuses = splitList(form.statuses);
  return {
    mode: form.mode,
    value: form.value.trim(),
    ...((types.length > 0 || statuses.length > 0) && {
      filters: { ...(types.length > 0 && { types }), ...(statuses.length > 0 && { statuses }) },
    }),
    ...(form.max.trim() !== '' && { max: Number(form.max) }),
    // Left out when checked: the server then uses the code when it is set up for it. Only an
    // explicit true would insist on it and fail where GitHub is not available.
    ...(!form.useCodeContext && { useCodeContext: false }),
    ...(!form.selfReview && { selfReview: false }),
  };
}

// ---- progress ----------------------------------------------------------------------------------

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Waiting in the queue',
  running: 'Running',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STAGE_LABEL: Record<string, string> = {
  queued: 'Waiting to start',
  resolving: 'Finding the tickets',
  generating: 'Writing test cases',
  ordering: 'Putting the cases in order',
  saving: 'Saving the run',
  finished: 'Done',
};

export const stageLabel = (stage: string): string => STAGE_LABEL[stage] ?? stage;

/** "2 of 5 tickets" once the tickets are known, otherwise just the stage. */
export function progressText(job: Pick<ApiJob, 'status' | 'progress'>): string {
  const { stage, total, done } = job.progress;
  if (job.status === 'queued') return STATUS_LABEL.queued;
  if (total === 0) return stageLabel(stage);
  return `${stageLabel(stage)}: ${done} of ${total} ticket${total === 1 ? '' : 's'}`;
}

export const isFinished = (status: JobStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled';

/** 3 seconds as "3 s", 95 seconds as "1 min 35 s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// ---- results -----------------------------------------------------------------------------------

export interface CaseGroup {
  name: string;
  description: string;
  order: number;
  cases: ApiCase[];
}

export interface ResultView {
  groups: CaseGroup[];
  cases: ApiCase[];
  warnings: string[];
  tickets: TicketOutcome[];
  grounding: Record<Grounding, number>;
  /** Tickets that did not produce cases, so they are never hidden behind the ones that did. */
  problems: { ticket: string; message: string }[];
}

/**
 * Groups cases by flow step in flow order. Deleted cases are not shown. A case that no step
 * lists goes into a final "Other" group, so it can never silently disappear.
 */
export function groupCases(
  cases: ApiCase[],
  steps: { order: number; name: string; description: string; caseIds: string[] }[],
): CaseGroup[] {
  const live = cases.filter((c) => c.state !== 'deleted');
  const byId = new Map(live.map((c) => [c.id, c]));
  const placed = new Set<string>();
  const groups: CaseGroup[] = [];

  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    const members = step.caseIds.flatMap((id) => {
      const found = byId.get(id);
      if (!found || placed.has(id)) return [];
      placed.add(id);
      return [found];
    });
    if (members.length > 0) {
      groups.push({
        name: step.name,
        description: step.description,
        order: step.order,
        cases: members,
      });
    }
  }

  const rest = live.filter((c) => !placed.has(c.id));
  if (rest.length > 0) {
    groups.push({ name: 'Other', description: '', order: groups.length + 1, cases: rest });
  }
  return groups;
}

function countGrounding(cases: ApiCase[]): Record<Grounding, number> {
  const counts: Record<Grounding, number> = { grounded: 0, partly: 0, assumed: 0 };
  for (const c of cases) counts[c.grounding] += 1;
  return counts;
}

function problemsOf(tickets: TicketOutcome[]): ResultView['problems'] {
  return tickets
    .filter((t) => t.status !== 'ok')
    .map((t) => ({
      ticket: t.ticket,
      message: t.error ?? (t.status === 'skipped' ? 'It was skipped.' : 'It failed.'),
    }));
}

/** What a finished job shows. Undefined until the job has a result. */
export function viewOfJob(job: ApiJob): ResultView | undefined {
  const result = job.result;
  if (!result) return undefined;
  return {
    groups: groupCases(result.cases, result.flow.steps),
    cases: result.cases,
    warnings: result.warnings,
    tickets: result.tickets,
    grounding: countGrounding(result.cases),
    problems: problemsOf(result.tickets),
  };
}

/** What a saved run shows, in the same shape as a job. */
export function viewOfRun(run: ApiRun): ResultView {
  const tickets: TicketOutcome[] = run.tickets.map((t) => ({
    ticket: t.ticket,
    status: t.status,
    cases: t.cases,
    ...(t.model && { model: t.model }),
    cached: t.cached,
    ...(t.detail && { detail: t.detail }),
    ...(t.error && { error: t.error }),
  }));
  const steps = run.flow.map((s) => ({
    order: s.position + 1,
    name: s.name,
    description: s.description,
    caseIds: s.caseCodes,
  }));
  return {
    groups: groupCases(run.cases, steps),
    cases: run.cases,
    warnings: run.warnings,
    tickets,
    grounding: countGrounding(run.cases.filter((c) => c.state !== 'deleted')),
    problems: problemsOf(tickets),
  };
}

export const GROUNDING_LABEL: Record<Grounding, string> = {
  grounded: 'Backed by the ticket',
  partly: 'Partly backed',
  assumed: 'Assumed',
};

export const SOURCE_LABEL: Record<string, string> = {
  ticket: 'Ticket description',
  acceptance_criteria: 'Acceptance criteria',
  comment: 'Ticket comment',
  module_notes: 'Product notes',
  past_cases: 'Earlier approved case',
  code_changes: 'Code change',
  inferred: 'General QA practice',
};

/** Filters the cases of a view by ticket and by what the person typed. */
export function filterCases(
  cases: ApiCase[],
  options: { ticket?: string; text?: string },
): ApiCase[] {
  const needle = options.text?.trim().toLowerCase() ?? '';
  return cases.filter((c) => {
    if (options.ticket && c.ticket !== options.ticket) return false;
    if (needle === '') return true;
    return [c.id, c.title, c.expected, ...c.steps].some((part) =>
      part.toLowerCase().includes(needle),
    );
  });
}
