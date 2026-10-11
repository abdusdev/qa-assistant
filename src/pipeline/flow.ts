import { DEFAULT_FLOW_STEPS, type Flow, type TestCase } from '../ai/schemas.js';

const canonicalName = (name: string): string => {
  const match = DEFAULT_FLOW_STEPS.find((step) => step.toLowerCase() === name.trim().toLowerCase());
  return match ?? name.trim();
};

/**
 * A flow built without the AI: cases grouped by the step each one already carries,
 * the usual steps first in their usual order, any other step after them.
 * Used when the AI cannot produce a sound flow, so a run never ends without one.
 */
export function fallbackFlow(cases: Pick<TestCase, 'id' | 'flow_step'>[]): Flow {
  const groups = new Map<string, string[]>();
  for (const testCase of cases) {
    const name = canonicalName(testCase.flow_step) || 'Other';
    groups.set(name, [...(groups.get(name) ?? []), testCase.id]);
  }

  const known = DEFAULT_FLOW_STEPS.filter((step) => groups.has(step));
  const extra = [...groups.keys()].filter((name) => !known.some((step) => step === name));

  const steps = [...known, ...extra].map((name, index) => ({
    order: index + 1,
    name,
    description: '',
    caseIds: groups.get(name) ?? [],
  }));
  return { steps };
}

/**
 * Tags every case with its flow step and orders the cases by the flow.
 * Cases the flow does not mention (it should not happen) are kept at the end.
 */
export function applyFlow(cases: TestCase[], flow: Flow): TestCase[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const placed = new Set<string>();
  const ordered: TestCase[] = [];

  for (const step of [...flow.steps].sort((a, b) => a.order - b.order)) {
    for (const id of step.caseIds) {
      const testCase = byId.get(id);
      if (!testCase || placed.has(id)) continue;
      placed.add(id);
      ordered.push({ ...testCase, flow_step: step.name });
    }
  }

  for (const testCase of cases) {
    if (!placed.has(testCase.id)) ordered.push(testCase);
  }
  return ordered;
}
