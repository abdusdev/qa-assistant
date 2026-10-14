import { useState, type FormEvent } from 'react';

const field =
  'mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900';

/** Asks for the access token (and a name for the change history) when the server needs one. */
export function SignIn(props: {
  wrongToken: boolean;
  onSubmit: (token: string, name: string) => void;
}) {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (token.trim() === '') {
      setProblem('Enter the access token.');
      return;
    }
    props.onSubmit(token, name);
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-labelledby="sign-in-title"
      className="mx-auto mt-10 max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <h2 id="sign-in-title" className="text-lg font-semibold">
        Sign in
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        This server asks for an access token. Ask whoever runs it for the token.
      </p>

      <label className="mt-4 block text-sm">
        <span className="font-medium">Access token</span>
        <input
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
            setProblem(undefined);
          }}
          className={field}
        />
      </label>
      <label className="mt-3 block text-sm">
        <span className="font-medium">Your name</span>
        <span className="ml-2 text-slate-500 dark:text-slate-400">
          shown in the history of changes
        </span>
        <input
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={field}
        />
      </label>

      {(problem || props.wrongToken) && (
        <p role="alert" className="mt-3 text-sm font-medium text-rose-700 dark:text-rose-300">
          {problem ?? 'That token was not accepted.'}
        </p>
      )}

      <button
        type="submit"
        className="mt-5 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800"
      >
        Sign in
      </button>
    </form>
  );
}
