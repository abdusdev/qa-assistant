import type { SearchOptions, SearchResult } from './client.js';
import { JiraError } from './errors.js';
import { extractKeys } from './keys.js';
import { buildJql, type SearchFilters } from './jql.js';
import type { Ticket } from './ticket.js';

export type InputMode = 'ticket' | 'list' | 'sprint' | 'epic' | 'release';

export interface ResolveRequest {
  mode: InputMode;
  /** A key, pasted text containing keys, a sprint name, an epic key or a version. */
  value: string;
  filters?: SearchFilters;
}

export interface ResolveOptions {
  /** Most tickets returned in one run. Default 100. */
  maxTickets?: number;
  /** Release (fix version) input is off until the team confirms Fix versions are used. */
  enableRelease?: boolean;
  /** Tickets fetched at the same time in list mode. Default 5. */
  concurrency?: number;
  /** Lets lowercase keys of this project (shp-1) be recognised in pasted text. */
  projectKey?: string;
}

export interface ResolveResult {
  tickets: Ticket[];
  /** Things QA should know about: missing tickets, left-out tickets, truncation. */
  warnings: string[];
}

/** The part of the Jira client the resolver needs. Lets tests pass a simple fake. */
export interface TicketSource {
  getIssue(key: string): Promise<Ticket>;
  searchIssues(jql: string, options?: SearchOptions): Promise<SearchResult>;
}

const DEFAULT_MAX_TICKETS = 100;
const DEFAULT_CONCURRENCY = 5;

/** Runs the task on every item with at most `limit` running at once, keeping input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const includesIgnoreCase = (list: string[], value: string) =>
  list.some((item) => item.trim().toLowerCase() === value.trim().toLowerCase());

function leftOutBy(ticket: Ticket, filters: SearchFilters): string | undefined {
  const reasons: string[] = [];
  if (filters.types?.length && !includesIgnoreCase(filters.types, ticket.type)) {
    reasons.push(`type "${ticket.type}" is not in the selected types`);
  }
  if (filters.statuses?.length && !includesIgnoreCase(filters.statuses, ticket.status)) {
    reasons.push(`status "${ticket.status}" is not in the selected statuses`);
  }
  return reasons.length > 0 ? `${ticket.key} was left out: ${reasons.join(' and ')}.` : undefined;
}

async function resolveKeys(
  source: TicketSource,
  request: ResolveRequest,
  options: Required<Pick<ResolveOptions, 'maxTickets' | 'concurrency'>> &
    Pick<ResolveOptions, 'projectKey'>,
): Promise<ResolveResult> {
  const warnings: string[] = [];
  let keys = extractKeys(
    request.value,
    options.projectKey ? { projectKey: options.projectKey } : {},
  );

  if (keys.length === 0) {
    throw new JiraError(
      'invalid_input',
      'No ticket keys were found in the input. Expected something like SHP-1234.',
    );
  }

  if (keys.length > options.maxTickets) {
    warnings.push(
      `Only the first ${options.maxTickets} of ${keys.length} tickets were loaded. ` +
        'Split the list into smaller runs.',
    );
    keys = keys.slice(0, options.maxTickets);
  }

  type Outcome = { key: string; ticket: Ticket } | { key: string; warning: string };

  const outcomes = await mapLimit<string, Outcome>(keys, options.concurrency, async (key) => {
    try {
      return { key, ticket: await source.getIssue(key) };
    } catch (error) {
      if (error instanceof JiraError && error.kind === 'not_found') {
        return { key, warning: `${key} was not found, or you do not have permission to see it.` };
      }
      if (error instanceof JiraError && error.kind === 'forbidden') {
        return { key, warning: `${key} could not be read: access was denied.` };
      }
      throw error; // wrong login, rate limit, outage: the whole run cannot be trusted
    }
  });

  const filters = request.filters ?? {};
  const tickets: Ticket[] = [];
  for (const outcome of outcomes) {
    if ('warning' in outcome) {
      warnings.push(outcome.warning);
      continue;
    }
    const reason = leftOutBy(outcome.ticket, filters);
    if (reason) warnings.push(reason);
    else tickets.push(outcome.ticket);
  }

  return { tickets, warnings };
}

async function resolveSearch(
  source: TicketSource,
  request: ResolveRequest & { mode: 'sprint' | 'epic' | 'release' },
  maxTickets: number,
): Promise<ResolveResult> {
  const jql = buildJql(request.mode, request.value, request.filters);
  const result = await source.searchIssues(jql, { maxTickets });
  const warnings: string[] = [];

  if (result.truncated) {
    warnings.push(
      `More than ${maxTickets} tickets matched, so only the first ${maxTickets} were loaded. ` +
        'Narrow the input with the type or status filters.',
    );
  }
  if (result.tickets.length === 0) {
    warnings.push(
      `No tickets matched the ${request.mode} "${request.value.trim()}". ` +
        'Check the name and the selected filters.',
    );
  }

  const seen = new Set<string>();
  const tickets = result.tickets.filter((ticket) => {
    if (seen.has(ticket.key)) return false;
    seen.add(ticket.key);
    return true;
  });

  return { tickets, warnings };
}

/**
 * Turns what QA typed into a de-duplicated list of tickets.
 * A wrong key or a ticket left out by the filters becomes a warning, not a failure.
 */
export async function resolveInput(
  source: TicketSource,
  request: ResolveRequest,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  const maxTickets = Math.max(1, options.maxTickets ?? DEFAULT_MAX_TICKETS);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  switch (request.mode) {
    case 'ticket':
    case 'list':
      return resolveKeys(source, request, {
        maxTickets,
        concurrency,
        ...(options.projectKey && { projectKey: options.projectKey }),
      });
    case 'release':
      if (!options.enableRelease) {
        throw new JiraError(
          'invalid_input',
          'Release input is not enabled. Set JIRA_ENABLE_RELEASE=true once Fix versions are in use.',
        );
      }
      return resolveSearch(source, { ...request, mode: 'release' }, maxTickets);
    case 'sprint':
    case 'epic':
      return resolveSearch(source, { ...request, mode: request.mode }, maxTickets);
    default:
      throw new JiraError('invalid_input', 'Unknown input type.');
  }
}
