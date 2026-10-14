import { History } from './components/History.js';
import { JobView } from './components/JobView.js';
import { RunView } from './components/ReviewRun.js';
import { RunForm } from './components/RunForm.js';
import { SignIn } from './components/SignIn.js';
import { useAccess, useRoute } from './hooks.js';

/** Always on screen: every case here was written by an AI. */
function DraftBanner() {
  return (
    <div
      role="note"
      data-testid="draft-banner"
      className="sticky top-0 z-10 border-b border-amber-300 bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      AI draft: needs QA review. These test cases were written by an AI and must be checked and
      edited by a person before they are relied on.
    </div>
  );
}

export function App() {
  const route = useRoute();
  const { access, submit, signOutNow, retry } = useAccess();

  return (
    <>
      <DraftBanner />
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <a href="#/" className="text-lg font-semibold">
            QA Assistant
          </a>
          <nav aria-label="Main" className="flex items-center gap-4">
            <a
              href="#/"
              className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
            >
              New run
            </a>
            {access.state === 'ready' && access.authRequired && (
              <button
                type="button"
                onClick={signOutNow}
                className="text-sm font-medium text-slate-600 hover:underline dark:text-slate-400"
              >
                Sign out{access.user !== 'qa' ? ` (${access.user})` : ''}
              </button>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
        {access.state === 'checking' && (
          <p role="status" className="text-slate-600 dark:text-slate-400">
            Connecting...
          </p>
        )}
        {access.state === 'sign-in' && <SignIn wrongToken={access.wrongToken} onSubmit={submit} />}
        {access.state === 'unreachable' && (
          <div
            role="alert"
            className="rounded-lg border border-rose-300 bg-rose-50 p-4 dark:border-rose-900 dark:bg-rose-950"
          >
            <p className="font-semibold text-rose-900 dark:text-rose-200">
              The server could not be reached
            </p>
            <p className="mt-1 text-sm text-rose-900 dark:text-rose-200">{access.message}</p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 text-sm font-medium text-blue-700 underline dark:text-blue-300"
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
      className="inline-block text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
    >
      &larr; Back to the start
    </a>
  );
}
