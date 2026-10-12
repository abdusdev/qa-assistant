import { z } from 'zod';
import { adfToText } from './adf.js';
import { JiraError } from './errors.js';
import { KEY_PATTERN } from './keys.js';
import { ticketSchema, type Ticket } from './ticket.js';

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Custom field id that holds acceptance criteria, for example customfield_10042. */
  acceptanceCriteriaField?: string;
}

export interface JiraClientOptions {
  /** Replaceable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429, 5xx and network errors. */
  maxRetries?: number;
  /** First retry delay, doubled each time when Jira gives no Retry-After. */
  baseDelayMs?: number;
  /** Replaceable for tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRY_AFTER_MS = 30_000;
const BASE_FIELDS = [
  'summary',
  'description',
  'status',
  'issuetype',
  'parent',
  'labels',
  'fixVersions',
  'comment',
  'updated',
];

const named = z.looseObject({ name: z.string() });

const rawIssueSchema = z.looseObject({
  key: z.string(),
  fields: z.looseObject({
    summary: z.string().nullish(),
    updated: z.string().nullish(),
    description: z.unknown().optional(),
    status: named.nullish(),
    issuetype: named.nullish(),
    parent: z.looseObject({ key: z.string() }).nullish(),
    labels: z.array(z.string()).nullish(),
    fixVersions: z.array(named).nullish(),
    comment: z
      .looseObject({
        comments: z
          .array(
            z.looseObject({
              author: z.looseObject({ displayName: z.string().nullish() }).nullish(),
              created: z.string().nullish(),
              body: z.unknown().optional(),
            }),
          )
          .nullish(),
      })
      .nullish(),
  }),
});

export interface ConnectionStatus {
  /** Name of the account the credentials belong to. */
  displayName: string;
  accountId: string;
  /** Only set when a project key was checked. */
  project?: { key: string; accessible: boolean };
}

export interface SearchResult {
  tickets: Ticket[];
  /** True when more tickets matched than were returned. */
  truncated: boolean;
}

export interface SearchOptions {
  /** Most tickets to return. Default 100. */
  maxTickets?: number;
  /** Tickets requested per page. Default and maximum 100. */
  pageSize?: number;
}

const DEFAULT_MAX_TICKETS = 100;
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 100;

const searchPageSchema = z.looseObject({
  issues: z.array(z.unknown()),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().nullish(),
});

const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class JiraClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly authHeader: string;
  private readonly acField: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: JiraClientConfig, options: JiraClientOptions = {}) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiToken = config.apiToken;
    this.authHeader =
      'Basic ' + Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    this.acField = config.acceptanceCriteriaField;
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Fetches one ticket by key and returns it with rich text already converted to plain text. */
  async getIssue(rawKey: string): Promise<Ticket> {
    const key = rawKey.trim().toUpperCase();
    if (!KEY_PATTERN.test(key)) {
      throw new JiraError(
        'invalid_key',
        `"${rawKey.slice(0, 40)}" is not a valid Jira ticket key.`,
      );
    }

    const query = new URLSearchParams({ fields: this.fieldList().join(',') });
    const body = await this.request(`/rest/api/3/issue/${key}?${query.toString()}`, key);
    return this.toTicket(body, key);
  }

  /**
   * Runs a JQL search and returns the matching tickets, following Jira's paging until the
   * end or until maxTickets is reached.
   */
  async searchIssues(jql: string, options: SearchOptions = {}): Promise<SearchResult> {
    const max = Math.max(1, options.maxTickets ?? DEFAULT_MAX_TICKETS);
    const pageSize = Math.min(Math.max(1, options.pageSize ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE);
    const tickets: Ticket[] = [];
    let truncated = false;
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await this.request('/rest/api/3/search/jql', 'the search', {
        method: 'POST',
        body: {
          jql,
          fields: this.fieldList(),
          maxResults: pageSize,
          ...(pageToken !== undefined && { nextPageToken: pageToken }),
        },
      });

      const parsed = searchPageSchema.safeParse(raw);
      if (!parsed.success) {
        throw new JiraError('invalid_response', 'Jira returned an unexpected search response.');
      }

      for (const issue of parsed.data.issues) {
        if (tickets.length >= max) {
          truncated = true;
          break;
        }
        tickets.push(this.toTicket(issue, 'a search result'));
      }

      const next = parsed.data.nextPageToken ?? undefined;
      const hasMore = next !== undefined && parsed.data.isLast !== true && next !== pageToken;
      if (truncated || !hasMore) break;
      if (tickets.length >= max) {
        truncated = true;
        break;
      }
      pageToken = next;
    }

    return { tickets, truncated };
  }

  private fieldList(): string[] {
    return this.acField ? [...BASE_FIELDS, this.acField] : BASE_FIELDS;
  }

  /**
   * Verifies the credentials by asking Jira who they belong to, and optionally whether
   * that account can see a project. Does not depend on any ticket existing.
   */
  async checkConnection(projectKey?: string): Promise<ConnectionStatus> {
    const project = projectKey?.trim().toUpperCase();
    if (project !== undefined && !PROJECT_KEY_PATTERN.test(project)) {
      throw new JiraError('invalid_key', `"${projectKey}" is not a valid Jira project key.`);
    }

    const body = await this.request('/rest/api/3/myself', 'your account');
    const me = z.looseObject({ displayName: z.string(), accountId: z.string() }).safeParse(body);
    if (!me.success) {
      throw new JiraError('invalid_response', 'Jira returned an unexpected answer for "who am I".');
    }

    const status: ConnectionStatus = {
      displayName: me.data.displayName,
      accountId: me.data.accountId,
    };
    if (project !== undefined) {
      status.project = { key: project, accessible: await this.canSeeProject(project) };
    }
    return status;
  }

  private async canSeeProject(projectKey: string): Promise<boolean> {
    try {
      await this.request(`/rest/api/3/project/${projectKey}`, projectKey);
      return true;
    } catch (error) {
      if (
        error instanceof JiraError &&
        (error.kind === 'not_found' || error.kind === 'forbidden')
      ) {
        return false;
      }
      throw error;
    }
  }

  private toTicket(body: unknown, requestedKey: string): Ticket {
    const parsed = rawIssueSchema.safeParse(body);
    if (!parsed.success) {
      throw new JiraError(
        'invalid_response',
        `Jira returned an unexpected response for ${requestedKey}.`,
      );
    }

    const { key, fields } = parsed.data;
    const acRaw = this.acField ? (fields as Record<string, unknown>)[this.acField] : undefined;
    const acceptanceCriteria = adfToText(acRaw);

    return ticketSchema.parse({
      key,
      url: `${this.baseUrl}/browse/${key}`,
      summary: fields.summary ?? '',
      type: fields.issuetype?.name ?? '',
      status: fields.status?.name ?? '',
      description: adfToText(fields.description),
      ...(acceptanceCriteria !== '' && { acceptanceCriteria }),
      ...(fields.parent && { parentKey: fields.parent.key }),
      ...(fields.updated && { updated: fields.updated }),
      labels: fields.labels ?? [],
      fixVersions: (fields.fixVersions ?? []).map((version) => version.name),
      comments: (fields.comment?.comments ?? []).map((comment) => ({
        author: comment.author?.displayName ?? 'Unknown',
        created: comment.created ?? '',
        body: adfToText(comment.body),
      })),
    });
  }

  private async request(
    path: string,
    key: string,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;

      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
          },
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (canRetry) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new JiraError('network', `Could not reach Jira: ${this.describeNetworkError(cause)}`);
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new JiraError(
            'invalid_response',
            `Jira returned a response for ${key} that is not JSON.`,
          );
        }
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && canRetry) {
        await this.sleep(this.retryDelay(response, attempt));
        continue;
      }

      throw await this.errorFor(response, key);
    }
  }

  private backoff(attempt: number): number {
    return this.baseDelayMs * 2 ** attempt;
  }

  private retryDelay(response: Response, attempt: number): number {
    const seconds = Number(response.headers.get('retry-after'));
    if (Number.isFinite(seconds) && seconds >= 0 && response.headers.get('retry-after') !== null) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
    return this.backoff(attempt);
  }

  private describeNetworkError(cause: unknown): string {
    if (cause instanceof Error) {
      if (cause.name === 'TimeoutError' || cause.name === 'AbortError')
        return 'the request timed out';
      return this.redact(cause.message).slice(0, 200);
    }
    return 'unknown network error';
  }

  private async errorFor(response: Response, key: string): Promise<JiraError> {
    const status = response.status;
    const detail = await this.readDetail(response);
    const suffix = detail ? ` ${detail}` : '';

    if (status === 401) {
      return new JiraError(
        'unauthorized',
        'Jira rejected the credentials (401). Check JIRA_EMAIL and JIRA_API_TOKEN.',
        status,
      );
    }
    if (status === 403) {
      return new JiraError('forbidden', `Jira denied access to ${key} (403).${suffix}`, status);
    }
    if (status === 404) {
      return new JiraError(
        'not_found',
        `Ticket ${key} was not found, or you do not have permission to see it (404).`,
        status,
      );
    }
    if (status === 429) {
      return new JiraError(
        'rate_limited',
        'Jira rate limit reached (429). Try again shortly.',
        status,
      );
    }
    if (status >= 500) {
      return new JiraError('server_error', `Jira is unavailable (${status}).${suffix}`, status);
    }
    return new JiraError(
      'bad_request',
      `Jira rejected the request for ${key} (${status}).${suffix}`,
      status,
    );
  }

  private async readDetail(response: Response): Promise<string> {
    try {
      const data: unknown = await response.json();
      const messages = (data as { errorMessages?: unknown })?.errorMessages;
      if (Array.isArray(messages)) {
        return this.redact(messages.filter((m) => typeof m === 'string').join(' ')).slice(0, 200);
      }
    } catch {
      // Body missing or not JSON: the status code alone is enough.
    }
    return '';
  }

  private redact(text: string): string {
    const secrets = [this.apiToken, this.authHeader, this.authHeader.replace('Basic ', '')];
    return secrets.reduce(
      (clean, secret) => (secret ? clean.split(secret).join('[redacted]') : clean),
      text,
    );
  }
}
