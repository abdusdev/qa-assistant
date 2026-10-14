import type { ReactNode } from 'react';
import type { TicketDetail } from '../lib/types.js';

const chip =
  'rounded-md bg-slate-100 px-2 py-0.5 text-sm font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300';

const characters = (ticket: TicketDetail) =>
  ticket.description.length +
  (ticket.acceptanceCriteria?.length ?? 0) +
  ticket.comments.reduce((sum, c) => sum + c.body.length, 0);

function TextBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <h4 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h4>
      <div className="mt-2 max-h-[36rem] overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-base leading-relaxed text-slate-800 dark:bg-slate-950 dark:text-slate-200">
        {children}
      </div>
    </section>
  );
}

/** One ticket, as Jira returned it. Opens to show every word the cases are written from. */
function TicketText({ ticket, open }: { ticket: TicketDetail; open: boolean }) {
  return (
    <details
      open={open}
      data-testid={`ticket-text-${ticket.key}`}
      className="group rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="text-slate-400 transition-transform group-open:rotate-90"
        >
          &#9656;
        </span>
        <span className="font-mono text-base font-medium text-blue-700 dark:text-blue-300">
          {ticket.key}
        </span>
        <span className="min-w-0 flex-1 text-base font-semibold">{ticket.summary}</span>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {characters(ticket).toLocaleString()} characters
        </span>
      </summary>

      <div className="border-t border-slate-200 px-5 py-5 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-2">
          <span className={chip}>{ticket.type}</span>
          <span className={chip}>{ticket.status}</span>
          {ticket.labels.map((label) => (
            <span key={label} className={chip}>
              {label}
            </span>
          ))}
          {ticket.parentKey && <span className={chip}>Parent {ticket.parentKey}</span>}
          <a
            href={ticket.url}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto text-base font-medium text-blue-700 hover:underline dark:text-blue-300"
          >
            Open in Jira
          </a>
        </div>

        <div className="mt-5">
          <TextBlock title="Description">
            {ticket.description.trim() || (
              <span className="text-slate-500 dark:text-slate-400">
                The ticket has no description.
              </span>
            )}
          </TextBlock>
          {ticket.acceptanceCriteria?.trim() && (
            <TextBlock title="Acceptance criteria">{ticket.acceptanceCriteria}</TextBlock>
          )}
          {ticket.comments.length > 0 && (
            <TextBlock title={`Comments (${ticket.commentCount})`}>
              {ticket.comments.map((comment, i) => (
                <p key={i} className={i > 0 ? 'mt-3' : ''}>
                  <span className="font-medium">{comment.author}</span>
                  <span className="text-slate-500 dark:text-slate-400">
                    {' '}
                    on {comment.created.slice(0, 10)}
                  </span>
                  {'\n'}
                  {comment.body}
                </p>
              ))}
            </TextBlock>
          )}
        </div>

        {ticket.truncated && (
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            Some of this ticket was shortened because it is very long.
          </p>
        )}
      </div>
    </details>
  );
}

/** A placeholder while the tickets are being read from Jira, so the page is clearly working. */
export function TicketManifestPending({ what }: { what: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="tickets-fetching"
      className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
    >
      <p className="text-base font-medium">Fetching {what} from Jira...</p>
      <div className="mt-4 space-y-3" aria-hidden="true">
        <div className="skeleton h-4 w-2/3" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-4 w-5/6" />
      </div>
    </div>
  );
}

/** The ticket text a run is working from, one expandable block per ticket. */
export function TicketManifest({
  tickets,
  heading = 'Tickets fetched from Jira',
  note,
}: {
  tickets: TicketDetail[];
  heading?: string;
  note?: string;
}) {
  if (tickets.length === 0) return null;
  return (
    <section aria-labelledby="manifest-title" data-testid="ticket-manifest">
      <h3 id="manifest-title" className="text-xl font-semibold tracking-tight">
        {heading}
      </h3>
      <p className="mt-1 max-w-2xl text-base text-slate-600 dark:text-slate-400">
        {note ??
          `${tickets.length === 1 ? 'This is the ticket' : 'These are the tickets'} as Jira returned ${
            tickets.length === 1 ? 'it' : 'them'
          }. The cases are written from this text and the ShipNest product notes.`}
      </p>
      <div className="mt-5 space-y-3">
        {tickets.map((ticket) => (
          <TicketText key={ticket.key} ticket={ticket} open={tickets.length <= 3} />
        ))}
      </div>
    </section>
  );
}
