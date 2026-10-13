import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import type { ApiRunSummary } from '../lib/types.js';

const STATUS_STYLE: Record<ApiRunSummary['status'], string> = {
  running: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  completed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  failed: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  cancelled: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
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

export function History() {
  const loaded = useLoad(() => api.runs(20), 'runs');

  return (
    <section aria-labelledby="history-title">
      <h2 id="history-title" className="text-lg font-semibold">
        Earlier runs
      </h2>

      {loaded.state === 'loading' && (
        <p role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          Loading the history...
        </p>
      )}

      {loaded.state === 'error' && (
        <p
          role="status"
          className="mt-3 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400"
        >
          {loaded.error.code === 'database_not_configured'
            ? 'The history is not available because the server has no database (DATABASE_URL).'
            : `The history could not be loaded. ${loaded.error.message}`}
        </p>
      )}

      {loaded.state === 'ready' && loaded.value.runs.length === 0 && (
        <p className="mt-3 rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
          No runs yet. The first one you start will appear here.
        </p>
      )}

      {loaded.state === 'ready' && loaded.value.runs.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {loaded.value.runs.map((run) => (
            <li key={run.id}>
              <a
                href={`#/runs/${run.id}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  <span className="mr-2 text-slate-500 dark:text-slate-400">{run.inputMode}</span>
                  {run.inputValue}
                </span>
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  {run.caseCount} case{run.caseCount === 1 ? '' : 's'}
                </span>
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  {when(run.createdAt)}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[run.status]}`}
                >
                  {run.status}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
