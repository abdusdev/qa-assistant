import { z } from 'zod';

export const CASE_TYPES = ['unit', 'api', 'ui'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;

/** The flow steps the AI is asked to use. QA reads the cases grouped under these. */
export const DEFAULT_FLOW_STEPS = [
  'Selection',
  'Happy path',
  'Limits',
  'Failures',
  'Regression',
] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

/** Models sometimes answer "UI" or " High ". Accept that instead of retrying. */
const lowercased = (value: unknown) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Where a case's content comes from. "inferred" means it is not stated anywhere we gave. */
export const SOURCE_KINDS = [
  'ticket',
  'acceptance_criteria',
  'comment',
  'module_notes',
  'past_cases',
  'code_changes',
  'inferred',
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

const SOURCE_ALIASES: Record<string, SourceKind> = {
  description: 'ticket',
  summary: 'ticket',
  ticket_description: 'ticket',
  acceptance_criterion: 'acceptance_criteria',
  comments: 'comment',
  module_note: 'module_notes',
  past_case: 'past_cases',
  code_change: 'code_changes',
  code: 'code_changes',
  assumption: 'inferred',
  assumed: 'inferred',
};

/** Reads "Acceptance criteria", "description" and the like. Anything unknown counts as inferred. */
const sourceKind = (value: unknown): unknown => {
  if (typeof value !== 'string') return 'inferred';
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return SOURCE_ALIASES[key] ?? key;
};

export const sourceSchema = z.object({
  from: z.preprocess(sourceKind, z.enum(SOURCE_KINDS).catch('inferred')),
  /** A short excerpt copied from that part. Checked against the real text afterwards. */
  quote: z.string().trim().max(400).default(''),
});

export const testCaseSchema = z.object({
  id: text(40),
  ticket: text(40),
  flow_step: text(80),
  title: z.string().trim().min(5).max(200),
  type: z.preprocess(lowercased, z.enum(CASE_TYPES)),
  priority: z.preprocess(lowercased, z.enum(PRIORITIES)),
  steps: z.array(text(500)).min(1).max(30),
  expected: text(1000),
  /** What this case is based on. Verified after the answer, not trusted. */
  sources: z.array(sourceSchema).max(6).default([]),
  /** Everything the author had to assume. QA confirms these. */
  assumptions: z.array(text(400)).max(10).default([]),
  /** Setup and test data needed before the steps, such as "101 orders with a selected rate". */
  preconditions: z.array(text(300)).max(10).default([]),
  /** Ids of cases that must run before this one. */
  depends_on: z.array(text(40)).max(10).default([]),
  /** Ids of the plan items (B1, B2...) this case tests. */
  covers: z.array(text(20)).max(10).optional(),
  /**
   * Set by us after checking the sources: grounded (a verified source and nothing assumed),
   * partly (a verified source, but some details are assumed) or assumed (no verified source).
   */
  grounding: z.enum(['grounded', 'partly', 'assumed']).default('assumed'),
});

/** The model's own view of whether the ticket says enough to write reliable cases. */
export const ticketDetailSchema = z.object({
  sufficient: z.boolean().default(true),
  missing: z.array(text(300)).max(10).default([]),
});

/** One behaviour the model found in the ticket and the context, before writing any case. */
export const planItemSchema = z.object({
  id: text(20),
  behaviour: text(300),
});

export const generatedCasesSchema = z.object({
  detail: ticketDetailSchema.optional(),
  /** Every behaviour worth testing. Each should be covered by at least one case. */
  plan: z.array(planItemSchema).max(40).default([]),
  cases: z.array(testCaseSchema).min(1).max(40),
});

export type PlanItem = z.infer<typeof planItemSchema>;

export type TestCase = z.infer<typeof testCaseSchema>;
export type CaseSource = z.infer<typeof sourceSchema>;
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export const flowStepSchema = z.object({
  order: z.number().int().min(1),
  name: text(80),
  description: z.string().trim().max(300).default(''),
  caseIds: z.array(text(40)),
});

/** The ordered flow QA follows. Every case belongs to exactly one step. */
export const flowSchema = z.object({
  steps: z.array(flowStepSchema).min(1).max(15),
});

export type Flow = z.infer<typeof flowSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;

/**
 * Checks a flow against the cases it should organise.
 * Returns a list of problems, empty when the flow is sound.
 */
export function checkFlow(flow: Flow, cases: Pick<TestCase, 'id'>[]): string[] {
  const problems: string[] = [];
  const known = new Set(cases.map((c) => c.id));
  const placed = new Map<string, number>();
  const orders = new Set<number>();

  for (const step of flow.steps) {
    if (orders.has(step.order)) problems.push(`Two flow steps have the order ${step.order}.`);
    orders.add(step.order);

    for (const id of step.caseIds) {
      if (!known.has(id)) {
        problems.push(`Flow step "${step.name}" lists ${id}, which is not a known case.`);
      }
      placed.set(id, (placed.get(id) ?? 0) + 1);
    }
  }

  for (const [id, count] of placed) {
    if (count > 1)
      problems.push(`${id} appears in ${count} flow steps. It must be in exactly one.`);
  }
  for (const id of known) {
    if (!placed.has(id)) problems.push(`${id} is not in any flow step.`);
  }

  return problems;
}
