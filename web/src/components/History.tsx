import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import type { ApiRunSummary } from '../lib/types.js';

const STATUS_STYLE: Record<ApiRunSummary['status'], { chip: string; dot: string }> = {
  running: {
    chip: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
    dot: 'bg-orange-500',
  },
  completed: {
    chip: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
    dot: 'bg-emerald-500',
  },
  failed: {
    chip: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
    dot: 'bg-rose-500',
  },
  cancelled: {
    chip: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    dot: 'bg-amber-500',
  },
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type Load<T> =
  { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; error: ApiError };

function useLoad<T>(load: () => Promise<T>, key: string): Load<T> {
  const [result, setResult] = useState<Load<T>>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setResult({ state: 'loading' });
    load().then(
      (value) => !cancelled && setResult({ state: 'ready', value }),
      (caught: unknown) =>
        !cancelled &&
        setResult({
          state: 'error',
          error:
            caught instanceof ApiError
              ? caught
              : new ApiError(0, 'unknown', 'Something went wrong.'),
        }),
    );
    return () => {
      cancelled = true;
    };
    // The loader is recreated on every render; the key says when to load again.
  }, [key]);
  return result;
}

const note =
  'mt-4 rounded-xl border border-dashed border-slate-300 p-6 text-base text-slate-600 dark:border-slate-700 dark:text-slate-400';

export function History() {
  const loaded = useLoad(() => api.runs(20), 'runs');

  return (
    <section aria-labelledby="history-title">
      <h2 id="history-title" className="text-2xl font-semibold tracking-tight">
        Earlier runs
      </h2>

      {loaded.state === 'loading' && (
        <div role="status" className="mt-4 space-y-3">
          <span className="sr-only">Loading the history...</span>
          <div className="skeleton h-14 w-full" aria-hidden="true" />
          <div className="skeleton h-14 w-full" aria-hidden="true" />
        </div>
      )}

      {loaded.state === 'error' && (
        <p role="status" className={note}>
          {loaded.error.code === 'database_not_configured'
            ? 'The history is not available because the server has no database (DATABASE_URL).'
            : `The history could not be loaded. ${loaded.error.message}`}
        </p>
      )}

      {loaded.state === 'ready' && loaded.value.runs.length === 0 && (
        <p className={note}>No runs yet. The first one you start will appear here.</p>
      )}

      {loaded.state === 'ready' && loaded.value.runs.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {loaded.value.runs.map((run) => (
            <li key={run.id}>
              <a
                href={`#/runs/${run.id}`}
                className="group flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/60"
              >
                <span
                  aria-hidden="true"
                  className={`h-2.5 w-2.5 flex-none rounded-full ${STATUS_STYLE[run.status].dot}`}
                />
                <span className="min-w-0 flex-1 truncate text-base font-medium">
                  <span className="mr-3 font-normal text-slate-500 dark:text-slate-400">
                    {run.inputMode}
                  </span>
                  <span className="font-mono">{run.inputValue}</span>
                </span>
                <span className="text-base text-slate-600 dark:text-slate-400">
                  {run.caseCount} case{run.caseCount === 1 ? '' : 's'}
                </span>
                <span className="text-base text-slate-600 dark:text-slate-400">
                  {when(run.createdAt)}
                </span>
                <span
                  className={`rounded-full px-3 py-0.5 text-sm font-medium ${STATUS_STYLE[run.status].chip}`}
                >
                  {run.status}
                </span>
                <span
                  aria-hidden="true"
                  className="text-slate-400 transition-transform group-hover:translate-x-1"
                >
                  &rarr;
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
