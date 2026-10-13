import { useMemo, useState } from 'react';
import {
  GROUNDING_LABEL,
  SOURCE_LABEL,
  filterCases,
  formatDuration,
  type ResultView,
} from '../lib/view.js';
import type { ApiCase, Grounding } from '../lib/types.js';

const GROUNDING_STYLE: Record<Grounding, string> = {
  grounded:
    'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200 ring-emerald-300 dark:ring-emerald-800',
  partly:
    'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 ring-amber-300 dark:ring-amber-800',
  assumed:
    'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200 ring-rose-300 dark:ring-rose-800',
};

const PRIORITY_STYLE: Record<string, string> = {
  high: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  medium: 'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  low: 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
};

const chip = 'rounded px-2 py-0.5 text-xs font-medium';

export function CaseCard({ testCase }: { testCase: ApiCase }) {
  const sources = testCase.sources.filter((s) => s.from !== 'inferred' || s.quote !== '');
  return (
    <article
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      aria-labelledby={`case-${testCase.id}-${testCase.ticket}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h4
          id={`case-${testCase.id}-${testCase.ticket}`}
          className="text-base font-semibold leading-snug"
        >
          <span className="mr-2 font-mono text-sm text-slate-500 dark:text-slate-400">
            {testCase.id}
          </span>
          {testCase.title}
        </h4>
        <div className="flex flex-wrap gap-1.5">
          <span className={`${chip} bg-slate-200 uppercase dark:bg-slate-800`}>
            {testCase.type}
          </span>
          <span className={`${chip} ${PRIORITY_STYLE[testCase.priority] ?? PRIORITY_STYLE.low}`}>
            {testCase.priority}
          </span>
          <span className={`${chip} ring-1 ${GROUNDING_STYLE[testCase.grounding]}`}>
            {GROUNDING_LABEL[testCase.grounding]}
          </span>
        </div>
      </header>

      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        {testCase.ticket}
        {testCase.state === 'edited' && ' · edited by QA'}
        {testCase.state === 'added' && ' · added by QA'}
        {testCase.depends_on.length > 0 && ` · runs after ${testCase.depends_on.join(', ')}`}
      </p>

      {testCase.preconditions.length > 0 && (
        <section className="mt-3">
          <h5 className="text-sm font-semibold">Preconditions</h5>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
            {testCase.preconditions.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-3">
        <h5 className="text-sm font-semibold">Steps</h5>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm">
          {testCase.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="mt-3">
        <h5 className="text-sm font-semibold">Expected result</h5>
        <p className="mt-1 text-sm">{testCase.expected}</p>
      </section>

      {(sources.length > 0 || testCase.assumptions.length > 0) && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium text-blue-700 dark:text-blue-300">
            Where this comes from
            {testCase.assumptions.length > 0 && ` · ${testCase.assumptions.length} to confirm`}
          </summary>
          {sources.length > 0 && (
            <ul className="mt-2 space-y-1">
              {sources.map((source, i) => (
                <li key={i}>
                  <span className="text-slate-600 dark:text-slate-400">
                    {SOURCE_LABEL[source.from] ?? source.from}
                  </span>
                  {source.quote && <q className="ml-1 italic">{source.quote}</q>}
                </li>
              ))}
            </ul>
          )}
          {testCase.assumptions.length > 0 && (
            <div className="mt-2">
              <p className="font-medium">To confirm</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {testCase.assumptions.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-xl font-semibold">{value}</dd>
    </div>
  );
}

export interface ResultsProps {
  view: ResultView;
  /** Shown in the summary when known. */
  durationMs?: number | null;
  calls?: number;
}

/** The finished cases, grouped by flow step, with what went wrong for any ticket kept visible. */
export function Results({ view, durationMs, calls }: ResultsProps) {
  const [ticket, setTicket] = useState('');
  const [text, setText] = useState('');

  const ticketsWithCases = useMemo(
    () => [...new Set(view.cases.map((c) => c.ticket))].sort(),
    [view.cases],
  );
  const filtering = ticket !== '' || text.trim() !== '';
  const visible = useMemo(() => {
    const keep = new Set(
      filterCases(view.cases, { ticket, text }).map((c) => `${c.ticket}/${c.id}`),
    );
    return view.groups
      .map((group) => ({
        ...group,
        cases: group.cases.filter((c) => keep.has(`${c.ticket}/${c.id}`)),
      }))
      .filter((group) => group.cases.length > 0);
  }, [view, ticket, text]);

  const shown = visible.reduce((sum, group) => sum + group.cases.length, 0);
  const total = view.groups.reduce((sum, group) => sum + group.cases.length, 0);

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Test cases" value={total} />
        <Stat label="Backed by the ticket" value={view.grounding.grounded} />
        <Stat label="To confirm" value={view.grounding.partly + view.grounding.assumed} />
        <Stat
          label="Time"
          value={durationMs !== undefined && durationMs !== null ? formatDuration(durationMs) : '-'}
        />
      </dl>
      {calls !== undefined && (
        <p className="-mt-3 text-xs text-slate-500 dark:text-slate-400">
          {calls} AI call{calls === 1 ? '' : 's'}
        </p>
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

      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-600 dark:border-slate-700 dark:text-slate-400">
          No test cases were produced.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block font-medium">Search</span>
              <input
                type="search"
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Title, step or expected result"
                className="mt-1 w-64 max-w-full rounded border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            {ticketsWithCases.length > 1 && (
              <label className="text-sm">
                <span className="block font-medium">Ticket</span>
                <select
                  value={ticket}
                  onChange={(event) => setTicket(event.target.value)}
                  className="mt-1 rounded border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-900"
                >
                  <option value="">All tickets</option>
                  {ticketsWithCases.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {filtering && (
              <p className="pb-2 text-sm text-slate-600 dark:text-slate-400">
                Showing {shown} of {total}
              </p>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              No case matches the search.
            </p>
          ) : (
            visible.map((group) => (
              <details key={group.name} open className="group">
                <summary className="cursor-pointer select-none text-lg font-semibold">
                  {group.order}. {group.name}
                  <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">
                    {group.cases.length} case{group.cases.length === 1 ? '' : 's'}
                  </span>
                </summary>
                {group.description && (
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                    {group.description}
                  </p>
                )}
                <div className="mt-3 space-y-3">
                  {group.cases.map((c) => (
                    <CaseCard key={`${c.ticket}-${c.id}`} testCase={c} />
                  ))}
                </div>
              </details>
            ))
          )}
        </>
      )}
    </div>
  );
}
