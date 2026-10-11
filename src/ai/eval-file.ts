import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ticketSchema } from '../jira/ticket.js';

/**
 * The format of a file in evals/tickets: one ticket and, optionally, QA's own cases for it.
 * Most ticket fields are optional so a file can be short.
 */
export const evalFileSchema = z.object({
  ticket: ticketSchema.extend({
    url: z.string().default(''),
    status: z.string().default(''),
    type: z.string().default(''),
    description: z.string().default(''),
    labels: z.array(z.string()).default([]),
    fixVersions: z.array(z.string()).default([]),
    comments: ticketSchema.shape.comments.default([]),
  }),
  reference: z.array(z.object({ title: z.string(), expected: z.string().default('') })).default([]),
});

export type EvalFile = z.infer<typeof evalFileSchema>;

export async function loadEvalFile(filePath: string): Promise<EvalFile> {
  return evalFileSchema.parse(JSON.parse(await readFile(filePath, 'utf8')));
}
