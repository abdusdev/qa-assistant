import { useState } from 'react';
import { api } from '../api.js';
import { go, useJob } from '../hooks.js';
import { STATUS_LABEL, isFinished, progressText, viewOfJob } from '../lib/view.js';
import type { TicketProgress } from '../lib/types.js';
import { Results } from './Results.js';

const TICKET_STYLE: Record<TicketProgress['status'], string> = {
  pending: 'text-slate-500 dark:text-slate-400',
  running: 'text-blue-700 dark:text-blue-300',
  ok: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-rose-700 dark:text-rose-300',
  skipped: 'text-amber-700 dark:text-amber-300',
};

const TICKET_LABEL: Record<TicketProgress['status'], string> = {
  pending: 'Waiting',
  running: 'Working',
  ok: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

export function JobView({ id }: { id: string }) {
  const { job, error, loading } = useJob(id);
  const [cancelling, setCancelling] = useState(false);

  if (loading) {
    return (
      <p role="status" className="text-slate-600 dark:text-slate-400">
        Loading the run...
      </p>
    );
  }
  if (error && !job) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-rose-300 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950"
      >
        <p className="font-semibold text-rose-900 dark:text-rose-200">
          {error.status === 404
            ? 'This run is no longer on the server'
            : 'The run could not be read'}
        </p>
        <p className="mt-1 text-sm text-rose-900 dark:text-rose-200">
          {error.status === 404
            ? 'Runs in progress are kept in memory, so a restart loses them. Finished runs that were saved are in the history.'
            : error.message}
        </p>
        <button
          type="button"
          onClick={() => go('#/')}
          className="mt-3 text-sm font-medium text-blue-700 underline dark:text-blue-300"
        >
          Back to the start
        </button>
      </div>
    );
  }
  if (!job) return null;

  const finished = isFinished(job.status);
  const view = viewOfJob(job);

  async function cancel() {
    setCancelling(true);
    try {
      await api.cancel(id);
    } catch {
      // The job may have just ended; the next read shows what happened.
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="progress-title"
        className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="progress-title" className="text-lg font-semibold">
              {job.input.mode === 'sprint' || job.input.mode === 'epic'
                ? `${job.input.mode[0]?.toUpperCase()}${job.input.mode.slice(1)} ${job.input.value}`
                : job.input.value}
            </h2>
            <p
              role="status"
              aria-live="polite"
              data-testid="job-status"
              className="mt-1 text-sm text-slate-600 dark:text-slate-400"
            >
              <span className="font-medium">{STATUS_LABEL[job.status]}</span>
              {!finished && ` · ${progressText(job)}`}
              {job.cancelRequested && !finished && ' · stopping'}
            </p>
          </div>
          {!finished && (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={cancelling || job.cancelRequested}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              {job.cancelRequested ? 'Stopping...' : 'Cancel'}
            </button>
          )}
        </div>

        {job.progress.total > 0 && (
          <div className="mt-4">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={job.progress.total}
              aria-valuenow={job.progress.done}
              aria-label="Tickets finished"
              className="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-800"
            >
              <div
                className="h-full bg-blue-600 transition-all"
                style={{ width: `${(job.progress.done / job.progress.total) * 100}%` }}
              />
            </div>
            <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
              {job.progress.tickets.map((ticket) => (
                <li key={ticket.ticket} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                  <span className="font-mono font-medium">{ticket.ticket}</span>
                  <span className={TICKET_STYLE[ticket.status]}>{TICKET_LABEL[ticket.status]}</span>
                  {ticket.cases !== undefined && (
                    <span className="text-slate-500 dark:text-slate-400">
                      {ticket.cases} case{ticket.cases === 1 ? '' : 's'}
                    </span>
                  )}
                  {ticket.error && (
                    <span className="basis-full text-rose-700 dark:text-rose-300">
                      {ticket.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {job.status === 'failed' && (
        <div
          role="alert"
          className="rounded-lg border border-rose-300 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950"
        >
          <p className="font-semibold text-rose-900 dark:text-rose-200">The run failed</p>
          <p className="mt-1 text-sm text-rose-900 dark:text-rose-200">{job.error}</p>
          <button
            type="button"
            onClick={() => go('#/')}
            className="mt-3 text-sm font-medium text-blue-700 underline dark:text-blue-300"
          >
            Start another run
          </button>
        </div>
      )}

      {job.status === 'cancelled' && (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          The run was cancelled.{' '}
          {view && view.cases.length > 0
            ? 'The cases written before it stopped are shown below.'
            : 'No cases were written.'}
        </p>
      )}

      {view && (
        <section aria-label="Results">
          <Results view={view} durationMs={job.result?.durationMs} calls={job.result?.calls} />
        </section>
      )}

      {job.runId && (job.status === 'done' || job.status === 'cancelled') && (
        <section
          aria-label="Next step"
          className="rounded-lg border border-blue-300 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950"
        >
          <p className="text-sm text-blue-950 dark:text-blue-100">
            The run is saved. Review it to edit cases, approve them and download Word, Markdown or
            CSV.
          </p>
          <a
            href={`#/runs/${job.runId}`}
            className="mt-2 inline-block rounded-lg bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800"
          >
            Review and edit these cases
          </a>
        </section>
      )}
    </div>
  );
}
