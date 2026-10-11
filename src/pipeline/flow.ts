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

/**
 * Makes sure no case comes before a case it depends on.
 * A case that is too early is moved into the step of its dependency, right after it,
 * so "apply a saved filter" never sits before "save a filter".
 * Returns the ids that were moved, and gives up (leaving the flow as it is) on a cycle.
 */
export function enforceDependencyOrder(
  cases: TestCase[],
  flow: Flow,
): { flow: Flow; moved: string[]; cyclic: boolean } {
  const steps = [...flow.steps]
    .sort((a, b) => a.order - b.order)
    .map((step) => ({ ...step, caseIds: [...step.caseIds] }));
  const known = new Set(cases.map((c) => c.id));
  const dependencies = new Map(
    cases.map((c) => [c.id, c.depends_on.filter((dep) => known.has(dep) && dep !== c.id)]),
  );

  const locate = (id: string) => {
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
      const index = steps[stepIndex]?.caseIds.indexOf(id) ?? -1;
      if (index !== -1) return { stepIndex, index };
    }
    return undefined;
  };

  const moved = new Set<string>();
  const limit = cases.length * cases.length + 1;
  let cyclic = false;

  for (let pass = 0; ; pass++) {
    let changed = false;

    outer: for (const [id, deps] of dependencies) {
      for (const dep of deps) {
        const at = locate(id);
        const depAt = locate(dep);
        if (!at || !depAt) continue;

        const tooEarly =
          at.stepIndex < depAt.stepIndex ||
          (at.stepIndex === depAt.stepIndex && at.index < depAt.index);
        if (!tooEarly) continue;

        (steps[at.stepIndex] as (typeof steps)[number]).caseIds.splice(at.index, 1);
        const target = steps[depAt.stepIndex] as (typeof steps)[number];
        const after = target.caseIds.indexOf(dep);
        target.caseIds.splice(after + 1, 0, id);
        moved.add(id);
        changed = true;
        break outer;
      }
    }

    if (!changed) break;
    if (pass >= limit) {
      cyclic = true;
      break;
    }
  }

  const kept = steps
    .filter((step) => step.caseIds.length > 0)
    .map((step, index) => ({ ...step, order: index + 1 }));
  return { flow: { steps: kept }, moved: [...moved], cyclic };
}
