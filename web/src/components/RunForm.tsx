import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { go } from '../hooks.js';
import { MODES, buildRequest, emptyForm, formProblem, type FormState } from '../lib/view.js';

const field =
  'mt-2 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-950 dark:placeholder:text-slate-500 dark:focus:border-blue-300 dark:focus:ring-blue-950';

function Option({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6 py-4">
      <span>
        <span className="block text-base font-medium">{title}</span>
        <span className="mt-0.5 block max-w-xl text-base text-slate-500 dark:text-slate-400">
          {description}
        </span>
      </span>
      <input
        type="checkbox"
        className="switch mt-1"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

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
    <section aria-labelledby="new-run-title">
      <h2 id="new-run-title" className="max-w-3xl text-4xl font-semibold tracking-tight">
        Generate test cases
      </h2>
      <p className="mt-3 max-w-2xl text-lg text-slate-600 dark:text-slate-400">
        Enter Jira tickets. While the cases are written you can read the exact ticket text fetched
        from Jira, then review, edit and download the result.
      </p>

      <form
        onSubmit={submit}
        noValidate
        aria-label="Run settings"
        className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 dark:border-slate-800 dark:bg-slate-900"
      >
        <fieldset>
          <legend className="text-base font-medium">What do you want to test?</legend>
          <div className="mt-3 inline-flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
            {MODES.map((mode) => (
              <button
                key={mode.mode}
                type="button"
                aria-pressed={form.mode === mode.mode}
                onClick={() => update('mode', mode.mode)}
                className={`rounded-lg px-5 py-2 text-base font-medium ${
                  form.mode === mode.mode
                    ? 'bg-white text-blue-800 shadow-sm dark:bg-slate-950 dark:text-blue-200'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="mt-6 block">
          <span className="text-base font-medium">{current.label}</span>
          <span className="ml-2 text-base text-slate-500 dark:text-slate-400">{current.hint}</span>
          {form.mode === 'list' ? (
            <textarea
              rows={3}
              value={form.value}
              onChange={(event) => update('value', event.target.value)}
              placeholder={current.placeholder}
              className={`${field} font-mono`}
            />
          ) : (
            <input
              type="text"
              value={form.value}
              onChange={(event) => update('value', event.target.value)}
              placeholder={current.placeholder}
              className={`${field} font-mono`}
            />
          )}
        </label>

        {(form.mode === 'sprint' || form.mode === 'epic') && (
          <div className="mt-6 grid gap-5 sm:grid-cols-3">
            <label className="block">
              <span className="text-base font-medium">Issue types</span>
              <input
                type="text"
                value={form.types}
                onChange={(event) => update('types', event.target.value)}
                placeholder="Story, Bug"
                className={field}
              />
            </label>
            <label className="block">
              <span className="text-base font-medium">Statuses</span>
              <input
                type="text"
                value={form.statuses}
                onChange={(event) => update('statuses', event.target.value)}
                placeholder="Review, Done"
                className={field}
              />
            </label>
            <label className="block">
              <span className="text-base font-medium">Most tickets</span>
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

        <div className="mt-6 divide-y divide-slate-200 border-t border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          <Option
            title="Include the code changes of each ticket"
            description="Reads the ticket's pull requests when the server is set up for it. Source code is sent to the AI provider. Untick it to leave the code out of this run."
            checked={form.useCodeContext}
            onChange={(checked) => update('useCodeContext', checked)}
          />
          <Option
            title="Let the AI review its own draft"
            description="Better cases, but a second AI request for every ticket."
            checked={form.selfReview}
            onChange={(checked) => update('selfReview', checked)}
          />
        </div>

        {(problem || serverError) && (
          <div
            role="alert"
            className="mt-2 rounded-lg border border-rose-300 bg-rose-50 p-4 text-base text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
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

        <div className="mt-6">
          <button
            type="submit"
            disabled={sending}
            className="inline-flex items-center gap-3 rounded-lg bg-orange-600 px-7 py-3.5 text-base font-semibold text-white shadow-sm hover:bg-orange-700 disabled:opacity-70"
          >
            {sending && (
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              />
            )}
            {sending ? 'Starting...' : 'Generate test cases'}
          </button>
        </div>
      </form>
    </section>
  );
}
