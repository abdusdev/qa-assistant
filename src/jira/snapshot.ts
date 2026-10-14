import type { Ticket } from './ticket.js';

/** Longest text kept for one field, so a huge ticket cannot slow the page or bloat a document. */
export const MAX_FIELD_CHARS = 20_000;
export const MAX_COMMENTS = 20;

/**
 * A ticket as Jira returned it, kept with a run so the person (and every export) can see which
 * ticket text the cases were written against. It is the same text the prompt is built from.
 */
export interface TicketSnapshot {
  key: string;
  url: string;
  summary: string;
  type: string;
  status: string;
  description: string;
  acceptanceCriteria?: string;
  labels: string[];
  components?: string[];
  parentKey?: string;
  updated?: string;
  /** Comments Jira has, even when fewer are kept. */
  commentCount: number;
  comments: { author: string; created: string; body: string }[];
  /** True when a field or the comment list was cut. */
  truncated: boolean;
}

export function toTicketSnapshot(ticket: Ticket): TicketSnapshot {
  let truncated = false;
  const clip = (text: string): string => {
    if (text.length <= MAX_FIELD_CHARS) return text;
    truncated = true;
    return text.slice(0, MAX_FIELD_CHARS);
  };

  const comments = ticket.comments.slice(0, MAX_COMMENTS).map((comment) => ({
    author: comment.author,
    created: comment.created,
    body: clip(comment.body),
  }));
  if (ticket.comments.length > MAX_COMMENTS) truncated = true;

  return {
    key: ticket.key,
    url: ticket.url,
    summary: ticket.summary,
    type: ticket.type,
    status: ticket.status,
    description: clip(ticket.description),
    ...(ticket.acceptanceCriteria !== undefined && {
      acceptanceCriteria: clip(ticket.acceptanceCriteria),
    }),
    labels: ticket.labels,
    ...(ticket.components && ticket.components.length > 0 && { components: ticket.components }),
    ...(ticket.parentKey !== undefined && { parentKey: ticket.parentKey }),
    ...(ticket.updated !== undefined && { updated: ticket.updated }),
    commentCount: ticket.comments.length,
    comments,
    truncated,
  };
}
