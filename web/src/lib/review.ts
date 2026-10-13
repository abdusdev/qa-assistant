import type { ApiCase, RunStats } from './types.js';

/** What the edit form holds while a person types: text, with lists as one item per line. */
export interface CaseDraft {
  title: string;
  type: string;
  priority: string;
  flow_step: string;
  preconditions: string;
  steps: string;
  expected: string;
  assumptions: string;
}

export const CASE_TYPES = ['ui', 'api', 'unit'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;

export const emptyDraft = (flowStep = ''): CaseDraft => ({
  title: '',
  type: 'ui',
  priority: 'medium',
  flow_step: flowStep,
  preconditions: '',
  steps: '',
  expected: '',
  assumptions: '',
});

/** One item per non-empty line. */
export const linesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function draftOf(c: ApiCase): CaseDraft {
  return {
    title: c.title,
    type: c.type,
    priority: c.priority,
    flow_step: c.flow_step,
    preconditions: c.preconditions.join('\n'),
    steps: c.steps.join('\n'),
    expected: c.expected,
    assumptions: c.assumptions.join('\n'),
  };
}

/** What is wrong with a draft in words, or nothing. The server checks again. */
export function draftProblem(draft: CaseDraft): string | undefined {
  if (draft.title.trim().length < 5) return 'The title needs at least 5 characters.';
  if (draft.title.trim().length > 200) return 'The title can have at most 200 characters.';
  if (linesOf(draft.steps).length === 0) return 'Add at least one step, one per line.';
  if (draft.expected.trim() === '') return 'Write the expected result.';
  if (draft.flow_step.trim() === '') return 'Choose or write the flow step.';
  return undefined;
}

export interface CasePatch {
  title?: string;
  type?: string;
  priority?: string;
  flow_step?: string;
  preconditions?: string[];
  steps?: string[];
  expected?: string;
  assumptions?: string[];
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Only the fields that differ from the case, so an edit touches nothing else. */
export function patchOf(original: ApiCase, draft: CaseDraft): CasePatch {
  const patch: CasePatch = {};
  if (draft.title.trim() !== original.title) patch.title = draft.title.trim();
  if (draft.type !== original.type) patch.type = draft.type;
  if (draft.priority !== original.priority) patch.priority = draft.priority;
  if (draft.flow_step.trim() !== original.flow_step) patch.flow_step = draft.flow_step.trim();
  if (draft.expected.trim() !== original.expected) patch.expected = draft.expected.trim();

  const preconditions = linesOf(draft.preconditions);
  if (!same(preconditions, original.preconditions)) patch.preconditions = preconditions;
  const steps = linesOf(draft.steps);
  if (!same(steps, original.steps)) patch.steps = steps;
  const assumptions = linesOf(draft.assumptions);
  if (!same(assumptions, original.assumptions)) patch.assumptions = assumptions;
  return patch;
}

export interface NewCaseBody {
  ticket: string;
  flow_step: string;
  title: string;
  type: string;
  priority: string;
  steps: string[];
  expected: string;
  preconditions: string[];
  assumptions: string[];
}

export function newCaseOf(ticket: string, draft: CaseDraft): NewCaseBody {
  return {
    ticket,
    flow_step: draft.flow_step.trim(),
    title: draft.title.trim(),
    type: draft.type,
    priority: draft.priority,
    steps: linesOf(draft.steps),
    expected: draft.expected.trim(),
    preconditions: linesOf(draft.preconditions),
    assumptions: linesOf(draft.assumptions),
  };
}

export type ExportFormat = 'docx' | 'md' | 'csv';

export const EXPORT_LABEL: Record<ExportFormat, string> = {
  docx: 'Word',
  md: 'Markdown',
  csv: 'CSV (Excel)',
};

export function exportUrl(runId: string, format: ExportFormat, approvedOnly: boolean): string {
  const query = new URLSearchParams({ format });
  if (approvedOnly) query.set('approved', 'true');
  return `/api/runs/${encodeURIComponent(runId)}/export?${query.toString()}`;
}

/** "3 kept, 1 edited, 1 deleted, 2 added" for the review bar. */
export function reviewText(stats: RunStats): string {
  return [
    `${stats.kept} kept`,
    `${stats.edited} edited`,
    `${stats.deleted} deleted`,
    `${stats.added} added`,
  ].join(', ');
}

/** The share of the AI's cases that survived review, as "75%". Dash when none were generated. */
export function keptShareText(stats: RunStats): string {
  return stats.generated === 0 ? '-' : `${Math.round(stats.keptShare * 100)}%`;
}
