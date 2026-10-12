import { createHash } from 'node:crypto';
import type { PromptContext } from '../ai/prompt.js';
import type { Ticket } from '../jira/ticket.js';
import type { CachedTicketResult, TicketCache } from '../pipeline/run.js';
import type { Repository } from './repository.js';

export interface CacheIdentity {
  /** Changing the prompt must not reuse results made by the old one. */
  promptVersion: string;
  /** The model the run is configured to use. */
  model: string;
  /** A result made with the review pass differs from one made without it. */
  selfReview: boolean;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The same context always gives the same hash, whatever order the object's keys are in. */
export function contextHash(context: PromptContext): string {
  const stable = {
    productKnowledge: context.productKnowledge ?? '',
    moduleNotes: context.moduleNotes ?? '',
    pastCases: context.pastCases ?? [],
    codeChanges: context.codeChanges ?? '',
  };
  return sha256(JSON.stringify(stable));
}

/**
 * The key a result is stored under. It changes when the ticket changes in Jira, when the prompt
 * version changes, when the model changes, or when the knowledge or code context changes.
 * A ticket without an "updated" time cannot be cached safely, so it has no key.
 */
export function cacheKeyFor(
  ticket: Pick<Ticket, 'key' | 'updated'>,
  context: PromptContext,
  identity: CacheIdentity,
): string | undefined {
  if (!ticket.updated) return undefined;
  return sha256(
    JSON.stringify([
      ticket.key,
      ticket.updated,
      identity.promptVersion,
      identity.model,
      identity.selfReview,
      contextHash(context),
    ]),
  );
}

/** A result cache for the pipeline, kept in the database. */
export function createTicketCache(repo: Repository, identity: CacheIdentity): TicketCache {
  return {
    async get(ticket, context) {
      const key = cacheKeyFor(ticket, context, identity);
      if (!key) return undefined;
      return repo.cacheGet<CachedTicketResult>(key);
    },
    async put(ticket, context, result) {
      const key = cacheKeyFor(ticket, context, identity);
      if (!key || !ticket.updated) return;
      await repo.cachePut({
        cacheKey: key,
        ticketKey: ticket.key,
        ticketUpdated: ticket.updated,
        promptVersion: identity.promptVersion,
        model: identity.model,
        payload: result,
      });
    },
  };
}
