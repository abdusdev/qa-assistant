import type { Repository } from '../db/repository.js';
import type { PilotRunInput } from './report.js';

export interface PilotSelection {
  /** Specific runs. */
  runIds?: string[];
  /** Runs created from this moment (inclusive). */
  since?: Date;
  /** Runs created before this moment (exclusive). */
  until?: Date;
}

/**
 * Loads the runs a pilot report covers. Only completed runs count: a failed or cancelled run has
 * no draft that QA reviewed. Asking for a run by id that is missing is an error, not a silent skip.
 */
export async function collectPilot(
  repo: Repository,
  selection: PilotSelection,
): Promise<PilotRunInput[]> {
  const ids = new Set(selection.runIds ?? []);
  if (ids.size === 0 && !selection.since) {
    throw new Error('Say which runs to report on: --runs <id,id> or --since <date>.');
  }

  const wanted = new Set(ids);
  if (selection.since) {
    const runs = await repo.listRuns(500);
    for (const run of runs) {
      if (run.createdAt < selection.since) continue;
      if (selection.until && run.createdAt >= selection.until) continue;
      wanted.add(run.id);
    }
  }

  const inputs: PilotRunInput[] = [];
  for (const id of wanted) {
    const run = await repo.getRun(id);
    if (!run) throw new Error(`There is no run with the id ${id}.`);
    if (run.status !== 'completed') {
      if (ids.has(id)) throw new Error(`Run ${id} is ${run.status}, not completed.`);
      continue;
    }
    inputs.push({ run, activity: await repo.reviewActivity(id) });
  }
  if (inputs.length === 0) throw new Error('No completed runs match.');
  return inputs;
}
