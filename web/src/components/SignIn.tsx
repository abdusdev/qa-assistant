import { useState, type FormEvent } from 'react';

const field =
  'mt-2 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base focus:border-blue-600 focus:outline-none focus:ring-4 focus:ring-blue-100 dark:border-slate-700 dark:bg-slate-950 dark:focus:ring-blue-950';

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
      className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <h2 id="sign-in-title" className="text-2xl font-semibold tracking-tight">
        Sign in
      </h2>
      <p className="mt-2 text-base text-slate-600 dark:text-slate-400">
        This server asks for an access token. Ask whoever runs it for the token.
      </p>

      <label className="mt-6 block text-base">
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
      <label className="mt-4 block text-base">
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
        <p role="alert" className="mt-4 text-base font-medium text-rose-700 dark:text-rose-300">
          {problem ?? 'That token was not accepted.'}
        </p>
      )}

      <button
        type="submit"
        className="mt-6 rounded-lg bg-blue-700 px-6 py-3 text-base font-semibold text-white hover:bg-blue-800 dark:bg-blue-400 dark:text-slate-950 dark:hover:bg-blue-300"
      >
        Sign in
      </button>
    </form>
  );
}
