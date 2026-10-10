import { z } from 'zod';
import { adfToText } from './adf.js';
import { JiraError } from './errors.js';
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

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;
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
];

const named = z.looseObject({ name: z.string() });

const rawIssueSchema = z.looseObject({
  key: z.string(),
  fields: z.looseObject({
    summary: z.string().nullish(),
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

    const fields = this.acField ? [...BASE_FIELDS, this.acField] : BASE_FIELDS;
    const query = new URLSearchParams({ fields: fields.join(',') });
    const body = await this.request(`/rest/api/3/issue/${key}?${query.toString()}`, key);
    return this.toTicket(body, key);
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
      labels: fields.labels ?? [],
      fixVersions: (fields.fixVersions ?? []).map((version) => version.name),
      comments: (fields.comment?.comments ?? []).map((comment) => ({
        author: comment.author?.displayName ?? 'Unknown',
        created: comment.created ?? '',
        body: adfToText(comment.body),
      })),
    });
  }

  private async request(path: string, key: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;

      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}${path}`, {
          headers: { Authorization: this.authHeader, Accept: 'application/json' },
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
