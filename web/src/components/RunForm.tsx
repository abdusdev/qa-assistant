import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { go } from '../hooks.js';
import { MODES, buildRequest, emptyForm, formProblem, type FormState } from '../lib/view.js';

const field =
  'mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900';

export function RunForm() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [problem, setProblem] = useState<string | undefined>();
  const [serverError, setServerError] = useState<ApiError | undefined>();
  const [sending, setSending] = useState(false);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setProblem(undefined);
    setServerError(undefined);
  };

  const current = MODES.find((m) => m.mode === form.mode) ?? MODES[0]!;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = formProblem(form);
    if (found) {
      setProblem(found);
      return;
    }
    setSending(true);
    setServerError(undefined);
    try {
      const { jobId } = await api.start(buildRequest(form));
      go(`#/jobs/${jobId}`);
    } catch (caught) {
      setServerError(
        caught instanceof ApiError ? caught : new ApiError(0, 'unknown', 'Something went wrong.'),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-labelledby="new-run-title"
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <h2 id="new-run-title" className="text-lg font-semibold">
        Generate test cases
      </h2>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">What do you want to test?</legend>
        <div className="mt-2 inline-flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          {MODES.map((mode) => (
            <button
              key={mode.mode}
              type="button"
              aria-pressed={form.mode === mode.mode}
              onClick={() => update('mode', mode.mode)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                form.mode === mode.mode
                  ? 'bg-white shadow dark:bg-slate-950'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="mt-4 block text-sm">
        <span className="font-medium">{current.label}</span>
        <span className="ml-2 text-slate-500 dark:text-slate-400">{current.hint}</span>
        {form.mode === 'list' ? (
          <textarea
            rows={3}
            value={form.value}
            onChange={(event) => update('value', event.target.value)}
            placeholder={current.placeholder}
            className={field}
          />
        ) : (
          <input
            type="text"
            value={form.value}
            onChange={(event) => update('value', event.target.value)}
            placeholder={current.placeholder}
            className={field}
          />
        )}
      </label>

      {(form.mode === 'sprint' || form.mode === 'epic') && (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-medium">Issue types</span>
            <input
              type="text"
              value={form.types}
              onChange={(event) => update('types', event.target.value)}
              placeholder="Story, Bug"
              className={field}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Statuses</span>
            <input
              type="text"
              value={form.statuses}
              onChange={(event) => update('statuses', event.target.value)}
              placeholder="Review, Done"
              className={field}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Most tickets</span>
            <input
              type="number"
              min={1}
              max={200}
              value={form.max}
              onChange={(event) => update('max', event.target.value)}
              placeholder="100"
              className={field}
            />
          </label>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.useCodeContext}
            onChange={(event) => update('useCodeContext', event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Include the code changes of each ticket</span>
            <span className="block text-slate-500 dark:text-slate-400">
              Reads the ticket&apos;s pull requests when the server is set up for it. Source code is
              sent to the AI provider. Untick it to leave the code out of this run.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.selfReview}
            onChange={(event) => update('selfReview', event.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">Let the AI review its own draft</span>
            <span className="block text-slate-500 dark:text-slate-400">
              Better cases, but a second AI request for every ticket.
            </span>
          </span>
        </label>
      </div>

      {(problem || serverError) && (
        <div
          role="alert"
          className="mt-4 rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
        >
          <p className="font-medium">{problem ?? serverError?.message}</p>
          {serverError && serverError.details.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {serverError.details.map((detail, i) => (
                <li key={i}>
                  {detail.field}: {detail.problem}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-5">
        <button
          type="submit"
          disabled={sending}
          className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-60"
        >
          {sending ? 'Starting...' : 'Generate test cases'}
        </button>
      </div>
    </form>
  );
}
