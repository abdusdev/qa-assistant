import { z } from 'zod';
import { AIError } from './errors.js';
import type { AIProvider, AIRequest, AIResponse } from './types.js';

/** Providers that speak the OpenAI "Responses" API. xAI's Grok uses the same request shape. */
export type OpenAIFamilyName = 'openai' | 'grok';

export interface OpenAIFamilyConfig {
  name: OpenAIFamilyName;
  apiKey: string;
  /** Model id from the provider's model list. */
  model: string;
  /** Hard cap for the answer length of every call. Default 8192. */
  maxOutputTokens?: number;
  /** Replaceable for tests. Defaults to the provider's public API. */
  baseUrl?: string;
}

export interface OpenAIFamilyOptions {
  /** Replaceable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. Model answers are slow, so this is generous. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429, 5xx and network errors. */
  maxRetries?: number;
  /** First retry delay, doubled each time when the provider gives no delay. */
  baseDelayMs?: number;
  /** Replaceable for tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const BASE_URLS: Record<OpenAIFamilyName, string> = {
  openai: 'https://api.openai.com/v1',
  grok: 'https://api.x.ai/v1',
};
const LABELS: Record<OpenAIFamilyName, string> = { openai: 'OpenAI', grok: 'xAI (Grok)' };
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MAX_RETRY_DELAY_MS = 60_000;
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/**
 * Parameters that some models refuse (reasoning models take no custom temperature) or that an
 * older API may not know. When the provider says one of them is the problem, it is dropped and
 * the call is made again. The answer does not depend on any of them.
 */
const DROPPABLE = ['temperature', 'store'] as const;
type Droppable = (typeof DROPPABLE)[number];

const responseSchema = z.looseObject({
  status: z.string().nullish(),
  error: z.union([z.string(), z.looseObject({ message: z.string().nullish() })]).nullish(),
  incomplete_details: z.looseObject({ reason: z.string().nullish() }).nullish(),
  model: z.string().nullish(),
  output: z
    .array(
      z.looseObject({
        type: z.string().nullish(),
        content: z
          .array(
            z.looseObject({
              type: z.string().nullish(),
              text: z.string().nullish(),
              refusal: z.string().nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
  usage: z
    .looseObject({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
    })
    .nullish(),
});

const errorBodySchema = z.looseObject({
  error: z
    .union([
      z.string(),
      z.looseObject({
        message: z.string().nullish(),
        type: z.string().nullish(),
        code: z.string().nullish(),
      }),
    ])
    .nullish(),
  code: z.string().nullish(),
  message: z.string().nullish(),
});

type ErrorBody = z.infer<typeof errorBodySchema>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The message and codes of an error body, whichever of the known shapes it came in. */
function describeError(body: ErrorBody | undefined): { message: string; codes: string } {
  const error = body?.error;
  if (typeof error === 'string') {
    return { message: error, codes: body?.code ?? '' };
  }
  return {
    message: error?.message ?? body?.message ?? '',
    codes: [error?.code, error?.type, body?.code].filter(Boolean).join(' '),
  };
}

export class OpenAIFamilyProvider implements AIProvider {
  readonly name: OpenAIFamilyName;

  private readonly label: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: OpenAIFamilyConfig, options: OpenAIFamilyOptions = {}) {
    if (!MODEL_PATTERN.test(config.model)) {
      throw new AIError('invalid_request', 'AI_MODEL contains characters a model id cannot have.');
    }
    this.name = config.name;
    this.label = LABELS[config.name];
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.baseUrl = (config.baseUrl ?? BASE_URLS[config.name]).replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    if (request.prompt.trim() === '') {
      throw new AIError('invalid_request', 'The prompt is empty.');
    }

    const dropped = new Set<Droppable>();
    for (;;) {
      const body = {
        model: this.model,
        input: [
          ...(request.system?.trim() ? [{ role: 'system', content: request.system }] : []),
          { role: 'user', content: request.prompt },
        ],
        max_output_tokens: Math.min(
          request.maxOutputTokens ?? this.maxOutputTokens,
          this.maxOutputTokens,
        ),
        // The ticket text should not be kept on the provider's side.
        ...(!dropped.has('store') && { store: false }),
        ...(request.temperature !== undefined &&
          !dropped.has('temperature') && { temperature: request.temperature }),
      };

      const result = await this.post('/responses', body);
      if (result.kind === 'ok') return this.toResponse(result.data);

      // A refused optional parameter is removed and the call made again, once per parameter.
      const refused = DROPPABLE.find(
        (name) =>
          name in body && new RegExp(`\\b${name}\\b`, 'i').test(describeError(result.body).message),
      );
      if (!refused) throw this.errorFor(result.status, result.body);
      dropped.add(refused);
    }
  }

  private toResponse(raw: unknown): AIResponse {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AIError(
        'invalid_response',
        `${this.label} returned an answer in an unexpected shape.`,
      );
    }
    const data = parsed.data;

    if (data.status === 'failed') {
      const message =
        typeof data.error === 'string' ? data.error : (data.error?.message ?? 'no reason given');
      throw new AIError(
        'server_error',
        `${this.label} could not produce an answer: ${this.redact(message).slice(0, 200)}`,
      );
    }

    const parts = (data.output ?? []).flatMap((item) =>
      item.type === 'message' || item.type === undefined ? (item.content ?? []) : [],
    );
    if (parts.some((part) => part.type === 'refusal')) {
      throw new AIError('blocked', `${this.label} refused to answer.`);
    }
    const text = parts
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');

    const incomplete = data.status === 'incomplete';
    const reason = data.incomplete_details?.reason ?? '';
    if (incomplete && reason === 'content_filter') {
      throw new AIError('blocked', `${this.label} stopped the answer (content filter).`);
    }
    if (text === '' && !incomplete) {
      throw new AIError('invalid_response', `${this.label} returned an empty answer.`);
    }

    const inputTokens = data.usage?.input_tokens ?? 0;
    // Reasoning tokens are billed as output and are already inside output_tokens.
    const outputTokens = data.usage?.output_tokens ?? 0;
    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: data.usage?.total_tokens ?? inputTokens + outputTokens,
      },
      model: data.model ?? this.model,
      truncated: incomplete,
    };
  }

  /**
   * Returns the parsed answer, or the status and body of a 400 so generate() can decide whether
   * a parameter was the cause. Every other failure is thrown here.
   */
  private async post(
    path: string,
    body: unknown,
  ): Promise<
    { kind: 'ok'; data: unknown } | { kind: 'bad'; status: number; body: ErrorBody | undefined }
  > {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;

      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (canRetry) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new AIError(
          'network',
          `Could not reach ${this.label}: ${this.describeNetworkError(cause)}`,
        );
      }

      if (response.ok) {
        try {
          return { kind: 'ok', data: await response.json() };
        } catch {
          throw new AIError(
            'invalid_response',
            `${this.label} returned a response that is not JSON.`,
          );
        }
      }

      const errorBody = await this.readBody(response);

      if (response.status === 400) return { kind: 'bad', status: 400, body: errorBody };

      // A used-up balance or quota will not clear in a minute, so retrying only wastes time.
      if (response.status === 429 && this.isOutOfQuota(errorBody)) {
        throw this.errorFor(429, errorBody);
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && canRetry) {
        await this.sleep(this.retryDelay(response, attempt));
        continue;
      }
      throw this.errorFor(response.status, errorBody);
    }
  }

  private isOutOfQuota(body: ErrorBody | undefined): boolean {
    const { message, codes } = describeError(body);
    return (
      /insufficient_quota|billing/i.test(codes) || /quota|credit|balance|billing/i.test(message)
    );
  }

  private backoff(attempt: number): number {
    return Math.min(this.baseDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
  }

  private retryDelay(response: Response, attempt: number): number {
    const header = response.headers.get('retry-after');
    if (header !== null && Number.isFinite(Number(header)) && Number(header) >= 0) {
      return Math.min(Number(header) * 1000, MAX_RETRY_DELAY_MS);
    }
    return this.backoff(attempt);
  }

  private async readBody(response: Response): Promise<ErrorBody | undefined> {
    try {
      const parsed = errorBodySchema.safeParse(await response.json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private describeNetworkError(cause: unknown): string {
    if (cause instanceof Error) {
      if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
        return 'the request timed out';
      }
      return this.redact(cause.message).slice(0, 200);
    }
    return 'unknown network error';
  }

  private errorFor(status: number, body: ErrorBody | undefined): AIError {
    const detail = this.redact(describeError(body).message).slice(0, 200);
    const suffix = detail ? ` ${detail}` : '';

    if (status === 401) {
      return new AIError(
        'unauthorized',
        `${this.label} rejected the API key (401). Check AI_API_KEY.`,
        status,
      );
    }
    if (status === 403) {
      return new AIError(
        'unauthorized',
        `${this.label} refused the request (403). Check AI_API_KEY and that the account may use this model.${suffix}`,
        status,
      );
    }
    if (status === 404) {
      return new AIError(
        'model_not_found',
        `Model "${this.model}" was not found (404). Check AI_MODEL.`,
        status,
      );
    }
    if (status === 429) {
      if (this.isOutOfQuota(body)) {
        return new AIError(
          'quota_exhausted',
          `${this.label} says the quota or credit balance for this key is used up (429).${suffix}`,
          status,
        );
      }
      return new AIError(
        'rate_limited',
        `${this.label} rate limit reached (429).${suffix}`,
        status,
      );
    }
    if (status >= 500) {
      return new AIError(
        'server_error',
        `${this.label} is unavailable (${status}).${suffix}`,
        status,
      );
    }
    return new AIError(
      'invalid_request',
      `${this.label} rejected the request (${status}).${suffix}`,
      status,
    );
  }

  private redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[redacted]') : text;
  }
}
