import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { go, useJob } from '../hooks.js';
import { STATUS_LABEL, isFinished, progressText, viewOfJob } from '../lib/view.js';
import type { TicketDetail, TicketProgress } from '../lib/types.js';
import { DraftNote } from './DraftNote.js';
import { Results } from './Results.js';
import { RunTimeline } from './RunTimeline.js';
import { TicketManifest, TicketManifestPending } from './TicketManifest.js';

const TICKET_STYLE: Record<TicketProgress['status'], string> = {
  pending: 'text-slate-500 dark:text-slate-400',
  running: 'text-orange-700 dark:text-orange-400',
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

const STATUS_CHIP: Record<string, string> = {
  queued: 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  running: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
  done: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  failed: 'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  cancelled: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
};

/** Reads the fetched ticket text once it exists. It does not change after that. */
function useTicketDetails(id: string, ready: boolean): TicketDetail[] | undefined {
  const [tickets, setTickets] = useState<TicketDetail[] | undefined>();

  useEffect(() => {
    setTickets(undefined);
  }, [id]);

  useEffect(() => {
    if (!ready || tickets !== undefined) return;
    let cancelled = false;
    api.jobTickets(id).then(
      (body) => !cancelled && setTickets(body.tickets),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [id, ready, tickets]);

  return tickets;
}

export function JobView({ id }: { id: string }) {
  const { job, error, loading } = useJob(id);
  const tickets = useTicketDetails(id, job?.hasTicketDetails === true);
  const [cancelling, setCancelling] = useState(false);

  if (loading) {
    return (
      <p role="status" className="text-base text-slate-600 dark:text-slate-400">
        Loading the run...
      </p>
    );
  }
  if (error && !job) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-rose-300 bg-rose-50 p-5 dark:border-rose-900 dark:bg-rose-950"
      >
        <p className="text-lg font-semibold text-rose-900 dark:text-rose-200">
          {error.status === 404
            ? 'This run is no longer on the server'
            : 'The run could not be read'}
        </p>
        <p className="mt-1 text-base text-rose-900 dark:text-rose-200">
          {error.status === 404
            ? 'Runs in progress are kept in memory, so a restart loses them. Finished runs that were saved are in the history.'
            : error.message}
        </p>
        <button
          type="button"
          onClick={() => go('#/')}
          className="mt-3 text-base font-medium text-blue-700 underline dark:text-blue-300"
        >
          Back to the start
        </button>
      </div>
    );
  }
  if (!job) return null;

  const finished = isFinished(job.status);
  const view = viewOfJob(job);
  const named = job.input.mode === 'sprint' || job.input.mode === 'epic';
  const title = named
    ? `${job.input.mode[0]?.toUpperCase()}${job.input.mode.slice(1)} ${job.input.value}`
    : job.input.value;

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
    <div className="space-y-8">
      <section aria-labelledby="progress-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="progress-title" className="break-words text-3xl font-semibold tracking-tight">
                {title}
              </h2>
              <span
                className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_CHIP[job.status] ?? STATUS_CHIP.queued}`}
              >
                {STATUS_LABEL[job.status]}
              </span>
            </div>
            <p
              role="status"
              aria-live="polite"
              data-testid="job-status"
              className="mt-2 text-base text-slate-600 dark:text-slate-400"
            >
              <span className="font-medium">{STATUS_LABEL[job.status]}</span>
              {!finished
                ? `: ${progressText(job)}`
                : job.progress.total > 0
                  ? `: ${job.progress.done} of ${job.progress.total} ticket${job.progress.total === 1 ? '' : 's'} processed`
                  : ''}
              {job.cancelRequested && !finished && ', stopping'}
            </p>
          </div>
          {!finished && (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={cancelling || job.cancelRequested}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-base font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              {job.cancelRequested ? 'Stopping...' : 'Cancel'}
            </button>
          )}
        </div>

        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <RunTimeline stage={job.progress.stage} status={job.status} />

          {job.progress.total > 0 && (
            <div className="mt-8 border-t border-slate-200 pt-6 dark:border-slate-800">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={job.progress.total}
                aria-valuenow={job.progress.done}
                aria-label="Tickets finished"
                className="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
              >
                <div
                  className="h-full rounded-full bg-blue-700 transition-all duration-500 dark:bg-blue-400"
                  style={{ width: `${(job.progress.done / job.progress.total) * 100}%` }}
                />
              </div>
              <ul className="mt-4 divide-y divide-slate-200 dark:divide-slate-800">
                {job.progress.tickets.map((ticket) => (
                  <li
                    key={ticket.ticket}
                    className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-base"
                  >
                    <span className="font-mono font-medium">{ticket.ticket}</span>
                    <span className={`font-medium ${TICKET_STYLE[ticket.status]}`}>
                      {TICKET_LABEL[ticket.status]}
                    </span>
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
        </div>
      </section>

      {tickets && tickets.length > 0 ? (
        <TicketManifest tickets={tickets} />
      ) : (
        !finished && <TicketManifestPending what="the ticket text" />
      )}

      {job.status === 'failed' && (
        <div
          role="alert"
          className="rounded-xl border border-rose-300 bg-rose-50 p-5 dark:border-rose-900 dark:bg-rose-950"
        >
          <p className="text-lg font-semibold text-rose-900 dark:text-rose-200">The run failed</p>
          <p className="mt-1 text-base text-rose-900 dark:text-rose-200">{job.error}</p>
          <button
            type="button"
            onClick={() => go('#/')}
            className="mt-3 text-base font-medium text-blue-700 underline dark:text-blue-300"
          >
            Start another run
          </button>
        </div>
      )}

      {job.status === 'cancelled' && (
        <p
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-base text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          The run was cancelled.{' '}
          {view && view.cases.length > 0
            ? 'The cases written before it stopped are shown below.'
            : 'No cases were written.'}
        </p>
      )}

      {view && (
        <section aria-label="Results">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xl font-semibold tracking-tight">Test cases</h3>
            <DraftNote />
          </div>
          <Results view={view} durationMs={job.result?.durationMs} calls={job.result?.calls} />
        </section>
      )}

      {job.runId && (job.status === 'done' || job.status === 'cancelled') && (
        <section
          aria-label="Next step"
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-blue-200 bg-blue-50 p-6 dark:border-blue-900 dark:bg-blue-950"
        >
          <p className="max-w-xl text-base text-blue-950 dark:text-blue-100">
            The run is saved. Review it to edit cases, approve them and download Word, Markdown or
            CSV. Each download starts with the tickets the cases were written for.
          </p>
          <a
            href={`#/runs/${job.runId}`}
            className="rounded-lg bg-blue-700 px-5 py-3 text-base font-semibold text-white hover:bg-blue-800 dark:bg-blue-400 dark:text-slate-950 dark:hover:bg-blue-300"
          >
            Review and edit these cases
          </a>
        </section>
      )}
    </div>
  );
}
