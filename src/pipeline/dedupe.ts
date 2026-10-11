import type { TestCase } from '../ai/schemas.js';
import { similarity } from '../util/similarity.js';

export interface RemovedDuplicate {
  removed: TestCase;
  /** The case that was kept instead. */
  keptInstead: TestCase;
}

const textOf = (c: TestCase) => `${c.title} ${c.expected}`;

/**
 * Removes cases that say nearly the same thing as an earlier case of a *different* ticket.
 * Two tickets often touch the same behaviour, and QA should not run it twice.
 * Cases of the same ticket are never removed here: close wording there is usually a real
 * boundary (100 orders versus 101 orders), and the review pass already merges true repeats.
 */
export function removeCrossTicketDuplicates(
  cases: TestCase[],
  threshold = 0.8,
): { kept: TestCase[]; removed: RemovedDuplicate[] } {
  const kept: TestCase[] = [];
  const removed: RemovedDuplicate[] = [];

  for (const candidate of cases) {
    const twin = kept.find(
      (other) =>
        other.ticket !== candidate.ticket &&
        other.type === candidate.type &&
        similarity(textOf(other), textOf(candidate)) >= threshold,
    );

    if (twin) removed.push({ removed: candidate, keptInstead: twin });
    else kept.push(candidate);
  }

  return { kept, removed };
}
