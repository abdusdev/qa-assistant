import { History } from './components/History.js';
import { JobView } from './components/JobView.js';
import { RunView } from './components/ReviewRun.js';
import { RunForm } from './components/RunForm.js';
import { SignIn } from './components/SignIn.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { useAccess, useRoute } from './hooks.js';

/** A parcel label: a barcode on a rounded tag. Drawn here so nothing is fetched for it. */
function Mark() {
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9" aria-hidden="true">
      <rect width="32" height="32" rx="8" className="fill-blue-700 dark:fill-blue-400" />
      <path
        d="M8 9v14M12 9v14M15 9v14M19 9v14M23 9v14"
        className="stroke-white dark:stroke-slate-950"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M10 9v14M17 9v14M21 9v14"
        className="stroke-orange-500"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function App() {
  const route = useRoute();
  const { access, submit, signOutNow, retry } = useAccess();

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <a
            href="#/"
            className="flex items-center gap-3 rounded-lg"
            aria-label="QA Assistant, home"
          >
            <Mark />
            <span className="leading-tight">
              <span className="block text-lg font-semibold tracking-tight">QA Assistant</span>
              <span className="block text-sm text-slate-500 dark:text-slate-400">
                Test cases from Jira tickets
              </span>
            </span>
          </a>
          <nav aria-label="Main" className="flex items-center gap-1">
            <a
              href="#/"
              className="rounded-lg px-3 py-2 text-base font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-slate-800"
            >
              New run
            </a>
            {access.state === 'ready' && access.authRequired && (
              <button
                type="button"
                onClick={signOutNow}
                className="rounded-lg px-3 py-2 text-base font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Sign out{access.user !== 'qa' ? ` (${access.user})` : ''}
              </button>
            )}
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-10 px-5 py-10">
        {access.state === 'checking' && (
          <p role="status" className="text-base text-slate-600 dark:text-slate-400">
            Connecting...
          </p>
        )}
        {access.state === 'sign-in' && <SignIn wrongToken={access.wrongToken} onSubmit={submit} />}
        {access.state === 'unreachable' && (
          <div
            role="alert"
            className="rounded-xl border border-rose-300 bg-rose-50 p-5 dark:border-rose-900 dark:bg-rose-950"
          >
            <p className="text-lg font-semibold text-rose-900 dark:text-rose-200">
              The server could not be reached
            </p>
            <p className="mt-1 text-base text-rose-900 dark:text-rose-200">{access.message}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 text-base font-medium text-blue-700 underline dark:text-blue-300"
            >
              Try again
            </button>
          </div>
        )}
        {access.state === 'ready' && route.kind === 'home' && (
          <>
            <RunForm />
            <History />
          </>
        )}
        {access.state === 'ready' && route.kind === 'job' && (
          <>
            <BackLink />
            <JobView key={route.id} id={route.id} />
          </>
        )}
        {access.state === 'ready' && route.kind === 'run' && (
          <>
            <BackLink />
            <RunView key={route.id} id={route.id} />
          </>
        )}
      </main>
    </>
  );
}

function BackLink() {
  return (
    <a
      href="#/"
      className="-mt-4 inline-flex items-center gap-2 text-base font-medium text-blue-700 hover:underline dark:text-blue-300"
    >
      <span aria-hidden="true">&larr;</span> Back to the start
    </a>
  );
}
