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

export const testCaseSchema = z.object({
  id: text(40),
  ticket: text(40),
  flow_step: text(80),
  title: z.string().trim().min(5).max(200),
  type: z.preprocess(lowercased, z.enum(CASE_TYPES)),
  priority: z.preprocess(lowercased, z.enum(PRIORITIES)),
  steps: z.array(text(500)).min(1).max(30),
  expected: text(1000),
});

export const generatedCasesSchema = z.object({
  cases: z.array(testCaseSchema).min(1).max(40),
});

export type TestCase = z.infer<typeof testCaseSchema>;

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
