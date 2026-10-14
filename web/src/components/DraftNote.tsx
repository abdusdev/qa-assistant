/**
 * Says the cases were written by an AI. It sits beside the cases, where it matters, instead of as a
 * bar across every page. Every download still carries the same notice.
 */
export function DraftNote({ className = '' }: { className?: string }) {
  return (
    <p
      role="note"
      data-testid="draft-banner"
      title="These test cases were written by an AI and must be checked and edited by a person before they are relied on."
      className={`inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 ${className}`}
    >
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-orange-500" />
      AI draft: needs QA review
    </p>
  );
}
