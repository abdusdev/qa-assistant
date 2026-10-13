import { History, RunView } from './components/History.js';
import { JobView } from './components/JobView.js';
import { RunForm } from './components/RunForm.js';
import { useRoute } from './hooks.js';

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

  return (
    <>
      <DraftBanner />
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <a href="#/" className="text-lg font-semibold">
            QA Assistant
          </a>
          <nav aria-label="Main">
            <a
              href="#/"
              className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
            >
              New run
            </a>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6">
        {route.kind === 'home' && (
          <>
            <RunForm />
            <History />
          </>
        )}
        {route.kind === 'job' && (
          <>
            <BackLink />
            <JobView key={route.id} id={route.id} />
          </>
        )}
        {route.kind === 'run' && (
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
