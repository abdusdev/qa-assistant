import { z } from 'zod';

export const ticketCommentSchema = z.object({
  author: z.string(),
  created: z.string(),
  body: z.string(),
});

/** A Jira ticket, normalized for the rest of the app. Rich text is already plain text. */
export const ticketSchema = z.object({
  key: z.string(),
  url: z.string(),
  summary: z.string(),
  type: z.string(),
  status: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string().optional(),
  parentKey: z.string().optional(),
  labels: z.array(z.string()),
  fixVersions: z.array(z.string()),
  comments: z.array(ticketCommentSchema),
});

export type Ticket = z.infer<typeof ticketSchema>;
export type TicketComment = z.infer<typeof ticketCommentSchema>;
