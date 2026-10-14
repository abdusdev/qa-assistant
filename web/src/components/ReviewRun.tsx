import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, downloadFile, review } from '../api.js';
import { getToken } from '../session.js';
import {
  CASE_TYPES,
  EXPORT_LABEL,
  PRIORITIES,
  draftOf,
  draftProblem,
  emptyDraft,
  exportUrl,
  keptShareText,
  newCaseOf,
  patchOf,
  reviewText,
  type CaseDraft,
  type ExportFormat,
} from '../lib/review.js';
import type { ApiCase, ApiJob, ApiRun } from '../lib/types.js';
import { formatDuration, isFinished, viewOfRun } from '../lib/view.js';
import { CaseCard } from './Results.js';

const field =
  'mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900';
const button =
  'rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800';
const primary =
  'rounded-lg bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60';

const asError = (caught: unknown): ApiError =>
  caught instanceof ApiError ? caught : new ApiError(0, 'unknown', 'Something went wrong.');

function ErrorLine({ error }: { error: ApiError | undefined }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="mt-2 rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
    >
      <p>{error.message}</p>
      {error.details.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {error.details.map((detail, i) => (
            <li key={i}>
              {detail.field}: {detail.problem}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The form for changing a case, or for writing a new one. */
function CaseEditor(props: {
  initial: CaseDraft;
  flowSteps: string[];
  submitLabel: string;
  onSubmit: (draft: CaseDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [problem, setProblem] = useState<string | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof CaseDraft>(key: K, value: CaseDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setProblem(undefined);
    setError(undefined);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = draftProblem(draft);
    if (found) {
      setProblem(found);
      return;
    }
    setSaving(true);
    try {
      await props.onSubmit(draft);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Edit case" className="mt-3 space-y-3 text-sm">
      <label className="block">
        <span className="font-medium">Title</span>
        <input
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
          className={field}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="font-medium">Type</span>
          <select
            value={draft.type}
            onChange={(e) => set('type', e.target.value)}
            className={field}
          >
            {CASE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-medium">Priority</span>
          <select
            value={draft.priority}
            onChange={(e) => set('priority', e.target.value)}
            className={field}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="font-medium">Flow step</span>
          <input
            list="flow-steps"
            value={draft.flow_step}
            onChange={(e) => set('flow_step', e.target.value)}
            className={field}
          />
          <datalist id="flow-steps">
            {props.flowSteps.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
      </div>
      <label className="block">
        <span className="font-medium">Preconditions</span>
        <span className="ml-2 text-slate-500 dark:text-slate-400">one per line</span>
        <textarea
          rows={2}
          value={draft.preconditions}
          onChange={(e) => set('preconditions', e.target.value)}
          className={field}
        />
      </label>
      <label className="block">
        <span className="font-medium">Steps</span>
        <span className="ml-2 text-slate-500 dark:text-slate-400">one per line, in order</span>
        <textarea
          rows={4}
          value={draft.steps}
          onChange={(e) => set('steps', e.target.value)}
          className={field}
        />
      </label>
      <label className="block">
        <span className="font-medium">Expected result</span>
        <textarea
          rows={2}
          value={draft.expected}
          onChange={(e) => set('expected', e.target.value)}
          className={field}
        />
      </label>
      <label className="block">
        <span className="font-medium">To confirm</span>
        <span className="ml-2 text-slate-500 dark:text-slate-400">one per line</span>
        <textarea
          rows={2}
          value={draft.assumptions}
          onChange={(e) => set('assumptions', e.target.value)}
          className={field}
        />
      </label>

      {problem && (
        <p role="alert" className="font-medium text-rose-700 dark:text-rose-300">
          {problem}
        </p>
      )}
      <ErrorLine error={error} />

      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={primary}>
          {saving ? 'Saving...' : props.submitLabel}
        </button>
        <button type="button" onClick={props.onCancel} disabled={saving} className={button}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface ReviewApi {
  runId: string;
  flowSteps: string[];
  reload: () => Promise<void>;
}

/** A case with its review controls: approve, edit, move and delete. */
function ReviewedCase({
  testCase,
  api: ctx,
  canMoveUp,
  canMoveDown,
}: {
  testCase: ApiCase;
  api: ReviewApi;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  const [busy, setBusy] = useState(false);
  const uid = testCase.uid as string;

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      await ctx.reload();
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={`case-${testCase.id}`}>
      <CaseCard testCase={testCase}>
        {editing ? (
          <CaseEditor
            initial={draftOf(testCase)}
            flowSteps={ctx.flowSteps}
            submitLabel="Save changes"
            onCancel={() => setEditing(false)}
            onSubmit={async (draft) => {
              const patch = patchOf(testCase, draft);
              if (Object.keys(patch).length > 0) await review.edit(uid, patch);
              setEditing(false);
              await ctx.reload();
            }}
          />
        ) : (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <button
              type="button"
              disabled={busy}
              aria-pressed={testCase.approved === true}
              onClick={() => void act(() => review.approve(uid, !testCase.approved))}
              className={testCase.approved ? primary : button}
            >
              {testCase.approved ? 'Approved' : 'Approve'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditing(true)}
              className={button}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={busy || !canMoveUp}
              aria-label={`Move ${testCase.id} up`}
              onClick={() => void act(() => review.move(uid, 'up'))}
              className={button}
            >
              Move up
            </button>
            <button
              type="button"
              disabled={busy || !canMoveDown}
              aria-label={`Move ${testCase.id} down`}
              onClick={() => void act(() => review.move(uid, 'down'))}
              className={button}
            >
              Move down
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => review.remove(uid))}
              className={`${button} text-rose-700 dark:text-rose-300`}
            >
              Delete
            </button>
          </div>
        )}
        <ErrorLine error={error} />
      </CaseCard>
    </div>
  );
}

/** Writes one ticket again and waits for it. Replaces that ticket's AI cases, nothing else. */
function RegenerateTicket({
  ticket,
  runId,
  onDone,
}: {
  ticket: string;
  runId: string;
  onDone: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [job, setJob] = useState<ApiJob | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gone = useRef(false);

  useEffect(() => {
    // Reset on every mount: a development build mounts, unmounts and mounts again.
    gone.current = false;
    return () => {
      gone.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const poll = useCallback(
    async (jobId: string) => {
      try {
        const next = await api.job(jobId);
        if (gone.current) return;
        setJob(next);
        if (isFinished(next.status)) {
          if (next.status === 'done') await onDone();
          return;
        }
        timer.current = setTimeout(() => void poll(jobId), 700);
      } catch (caught) {
        if (!gone.current) setError(asError(caught));
      }
    },
    [onDone],
  );

  async function start() {
    setConfirming(false);
    setError(undefined);
    setJob(undefined);
    try {
      const { jobId } = await review.regenerate(runId, ticket);
      setJob({ status: 'queued' } as ApiJob);
      void poll(jobId);
    } catch (caught) {
      setError(asError(caught));
    }
  }

  const working = job !== undefined && !isFinished(job.status);

  return (
    <div className="mt-1">
      {!confirming && !working && (
        <button type="button" onClick={() => setConfirming(true)} className={button}>
          Write {ticket} again
        </button>
      )}
      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Write ${ticket} again`}
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <p>
            This replaces the AI&apos;s cases for <strong>{ticket}</strong>, including any edits you
            made to them. Cases you added by hand stay. Other tickets are not touched.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void start()} className={primary}>
              Replace the cases
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={button}>
              Keep what I have
            </button>
          </div>
        </div>
      )}
      {working && (
        <p role="status" className="text-sm text-slate-600 dark:text-slate-400">
          Writing {ticket} again...
        </p>
      )}
      {job?.status === 'done' && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">
          {ticket} was written again.
        </p>
      )}
      {job?.status === 'failed' && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          {job.error} Nothing was changed.
        </p>
      )}
      {job?.status === 'cancelled' && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
          It was cancelled. Nothing was changed.
        </p>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

export function RunView({ id }: { id: string }) {
  const [run, setRun] = useState<ApiRun | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [loading, setLoading] = useState(true);
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState<{ busy: boolean; error?: ApiError }>({ busy: false });

  const load = useCallback(async () => {
    try {
      setRun(await api.run(id));
      setError(undefined);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    setRun(undefined);
    void load();
  }, [load]);

  const view = useMemo(() => (run ? viewOfRun(run) : undefined), [run]);
  const flowSteps = useMemo(
    () => [
      ...new Set([
        ...(run?.flow.map((s) => s.name) ?? []),
        ...(view?.groups.map((g) => g.name) ?? []),
      ]),
    ],
    [run, view],
  );

  if (loading) {
    return (
      <p role="status" className="text-slate-600 dark:text-slate-400">
        Loading the run...
      </p>
    );
  }
  if (error || !run || !view) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-rose-300 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950"
      >
        <p className="font-semibold text-rose-900 dark:text-rose-200">
          {error?.status === 404 ? 'There is no such run' : 'The run could not be loaded'}
        </p>
        <p className="mt-1 text-sm text-rose-900 dark:text-rose-200">{error?.message}</p>
      </div>
    );
  }

  const ctx: ReviewApi = { runId: run.id, flowSteps, reload: load };
  const deleted = run.cases.filter((c) => c.state === 'deleted');
  const stats = run.stats;
  const tickets = run.tickets.map((t) => t.ticket);

  async function approveAll() {
    setBulk({ busy: true });
    try {
      await review.approveAll(run!.id);
      await load();
      setBulk({ busy: false });
    } catch (caught) {
      setBulk({ busy: false, error: asError(caught) });
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">
          {run.inputMode} {run.inputValue}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {new Date(run.createdAt).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}{' '}
          · {run.status}
          {run.model && ` · ${run.model}`}
          {run.durationMs !== null && ` · ${formatDuration(run.durationMs)}`}
        </p>
        {run.error && (
          <p role="alert" className="mt-2 text-sm text-rose-700 dark:text-rose-300">
            {run.error}
          </p>
        )}
      </section>

      {stats && (
        <section
          aria-label="Review"
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="font-semibold">Review</h3>
              <p data-testid="review-summary" className="mt-1 text-sm">
                {stats.approved} of {stats.total} approved
              </p>
              <p data-testid="review-counts" className="text-sm text-slate-600 dark:text-slate-400">
                {reviewText(stats)} · {keptShareText(stats)} of the AI&apos;s cases survived
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={bulk.busy || stats.approved === stats.total}
                onClick={() => void approveAll()}
                className={button}
              >
                Approve all
              </button>
            </div>
          </div>
          <ErrorLine error={bulk.error} />

          <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
            <p className="text-sm font-medium">Download</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {(['docx', 'md', 'csv'] as ExportFormat[]).map((format) => (
                <a
                  key={format}
                  href={exportUrl(run.id, format, approvedOnly)}
                  download
                  className={button}
                  onClick={(event) => {
                    // With no token a plain link is enough. With one, the file is fetched with it.
                    if (getToken() === '') return;
                    event.preventDefault();
                    void downloadFile(exportUrl(run.id, format, approvedOnly)).catch((caught) =>
                      setBulk({ busy: false, error: asError(caught) }),
                    );
                  }}
                >
                  {EXPORT_LABEL[format]}
                </a>
              ))}
              <label className="ml-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={approvedOnly}
                  onChange={(e) => setApprovedOnly(e.target.checked)}
                />
                Approved cases only
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Every file says it is an AI draft that needs QA review.
            </p>
          </div>
        </section>
      )}

      {view.problems.length > 0 && (
        <section
          role="alert"
          className="rounded-lg border border-rose-300 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950"
        >
          <h3 className="font-semibold text-rose-900 dark:text-rose-200">
            {view.problems.length} ticket{view.problems.length === 1 ? '' : 's'} did not produce
            cases
          </h3>
          <ul className="mt-2 space-y-1 text-sm text-rose-900 dark:text-rose-200">
            {view.problems.map((problem) => (
              <li key={problem.ticket}>
                <span className="font-mono font-medium">{problem.ticket}</span>: {problem.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.warnings.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <h3 className="font-semibold text-amber-900 dark:text-amber-200">Notes</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-200">
            {view.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Tickets" className="space-y-2">
        <h3 className="font-semibold">Tickets in this run</h3>
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {tickets.map((ticket) => (
            <li key={ticket} className="px-4 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm font-medium">{ticket}</span>
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  {view.cases.filter((c) => c.ticket === ticket && c.state !== 'deleted').length}{' '}
                  cases
                </span>
              </div>
              <RegenerateTicket ticket={ticket} runId={run.id} onDone={load} />
            </li>
          ))}
        </ul>
      </section>

      {view.groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-600 dark:border-slate-700 dark:text-slate-400">
          There are no cases in this run.
        </p>
      ) : (
        view.groups.map((group) => (
          <details key={group.name} open>
            <summary className="cursor-pointer select-none text-lg font-semibold">
              {group.order}. {group.name}
              <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">
                {group.cases.length} case{group.cases.length === 1 ? '' : 's'}
              </span>
            </summary>
            {group.description && (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{group.description}</p>
            )}
            <div className="mt-3 space-y-3">
              {group.cases.map((c, index) => (
                <ReviewedCase
                  key={c.uid ?? `${c.ticket}-${c.id}`}
                  testCase={c}
                  api={ctx}
                  canMoveUp={index > 0}
                  canMoveDown={index < group.cases.length - 1}
                />
              ))}
            </div>
          </details>
        ))
      )}

      <section aria-label="Add a case">
        {adding ? (
          <NewCase
            ctx={ctx}
            tickets={tickets}
            defaultStep={view.groups[0]?.name ?? 'Happy path'}
            onClose={() => setAdding(false)}
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={button}>
            Add a case
          </button>
        )}
      </section>

      {deleted.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none font-semibold">
            Deleted cases ({deleted.length})
          </summary>
          <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {deleted.map((c) => (
              <DeletedRow key={c.uid} testCase={c} ctx={ctx} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function NewCase({
  ctx,
  tickets,
  defaultStep,
  onClose,
}: {
  ctx: ReviewApi;
  tickets: string[];
  defaultStep: string;
  onClose: () => void;
}) {
  const [ticket, setTicket] = useState(tickets[0] ?? '');
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h3 className="font-semibold">Add a case</h3>
      <label className="mt-3 block text-sm">
        <span className="font-medium">Ticket</span>
        <select value={ticket} onChange={(e) => setTicket(e.target.value)} className={field}>
          {tickets.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </label>
      <CaseEditor
        initial={emptyDraft(defaultStep)}
        flowSteps={ctx.flowSteps}
        submitLabel="Add the case"
        onCancel={onClose}
        onSubmit={async (draft) => {
          await review.add(ctx.runId, newCaseOf(ticket, draft));
          onClose();
          await ctx.reload();
        }}
      />
    </div>
  );
}

function DeletedRow({ testCase, ctx }: { testCase: ApiCase; ctx: ReviewApi }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | undefined>();
  return (
    <li className="px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="mr-2 font-mono text-slate-500 dark:text-slate-400">{testCase.id}</span>
          {testCase.title}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await review.restore(testCase.uid as string);
              await ctx.reload();
            } catch (caught) {
              setError(asError(caught));
              setBusy(false);
            }
          }}
          className={button}
        >
          Restore
        </button>
      </div>
      <ErrorLine error={error} />
    </li>
  );
}
