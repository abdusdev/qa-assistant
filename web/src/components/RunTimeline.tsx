import type { JobStatus } from '../lib/types.js';

const STEPS = [
  { stage: 'resolving', label: 'Fetch tickets', detail: 'Read each ticket from Jira' },
  { stage: 'generating', label: 'Write cases', detail: 'Draft and check the cases' },
  { stage: 'ordering', label: 'Order the flow', detail: 'Put the cases in test order' },
  { stage: 'saving', label: 'Save the run', detail: 'Keep it so it can be reviewed' },
] as const;

type StepState = 'done' | 'now' | 'next' | 'failed';

function stateOf(index: number, stage: string, status: JobStatus): StepState {
  const current = STEPS.findIndex((s) => s.stage === stage);
  // A finished run has passed every step. A queued one has not reached the first.
  if (stage === 'finished' && status === 'done') return 'done';
  const position = stage === 'finished' || current === -1 ? -1 : current;
  if (status === 'failed' || status === 'cancelled') {
    if (position === -1) return index === 0 ? 'failed' : 'next';
    if (index < position) return 'done';
    return index === position ? 'failed' : 'next';
  }
  if (position === -1) return 'next';
  if (index < position) return 'done';
  return index === position ? 'now' : 'next';
}

const DOT: Record<StepState, string> = {
  done: 'bg-blue-700 text-white dark:bg-blue-400 dark:text-slate-950',
  now: 'step-now bg-orange-500 text-white',
  next: 'border-2 border-slate-300 bg-white text-slate-400 dark:border-slate-700 dark:bg-slate-900',
  failed: 'bg-rose-600 text-white',
};

/** The stages of a run as a parcel-tracking trail: what is done, what is happening, what is next. */
export function RunTimeline({ stage, status }: { stage: string; status: JobStatus }) {
  return (
    <ol
      aria-label="Run progress"
      data-testid="run-timeline"
      className="grid gap-6 sm:grid-cols-4 sm:gap-0"
    >
      {STEPS.map((step, index) => {
        const state = stateOf(index, stage, status);
        const last = index === STEPS.length - 1;
        // The line after a step is filled once the step is done.
        const lineDone = state === 'done';
        return (
          <li
            key={step.stage}
            aria-current={state === 'now' ? 'step' : undefined}
            data-state={state}
          >
            <div className="flex items-center">
              <span
                className={`grid h-9 w-9 flex-none place-items-center rounded-full text-base font-semibold ${DOT[state]}`}
              >
                {state === 'done' ? (
                  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden="true">
                    <path
                      d="m3.5 8.5 3 3 6-7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : state === 'failed' ? (
                  '!'
                ) : (
                  index + 1
                )}
              </span>
              {!last && (
                <span
                  aria-hidden="true"
                  className={`mx-3 hidden h-0.5 flex-1 rounded sm:block ${
                    lineDone ? 'bg-blue-700 dark:bg-blue-400' : 'bg-slate-200 dark:bg-slate-700'
                  }`}
                />
              )}
            </div>
            <div className="mt-3 sm:pr-4">
              <span
                className={`block text-base font-semibold ${
                  state === 'next' ? 'text-slate-500 dark:text-slate-400' : ''
                }`}
              >
                {step.label}
                <span className="sr-only">
                  {state === 'done'
                    ? ', done'
                    : state === 'now'
                      ? ', in progress'
                      : state === 'failed'
                        ? ', stopped'
                        : ', waiting'}
                </span>
              </span>
              <span className="block text-sm text-slate-500 dark:text-slate-400">
                {step.detail}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
