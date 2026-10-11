import { z } from 'zod';
import { AIError } from './errors.js';
import type { AIProvider, AIRequest, AIResponse, AIUsage } from './types.js';

export interface GeminiConfig {
  apiKey: string;
  /** Model id as shown in Google AI Studio. */
  model: string;
  /** Hard cap for the answer length of every call. Default 8192. */
  maxOutputTokens?: number;
  baseUrl?: string;
}

export interface GeminiOptions {
  /** Replaceable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. Model answers are slow, so this is generous. */
  timeoutMs?: number;
  /** Retries after the first attempt, for 429, 5xx and network errors. */
  maxRetries?: number;
  /** First retry delay, doubled each time when Google gives no delay. */
  baseDelayMs?: number;
  /** Replaceable for tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MAX_RETRY_DELAY_MS = 60_000;
const MODEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const BLOCKED_FINISH_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
]);

const responseSchema = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        content: z
          .looseObject({
            parts: z.array(z.looseObject({ text: z.string().optional() })).optional(),
          })
          .nullish(),
        finishReason: z.string().nullish(),
      }),
    )
    .nullish(),
  promptFeedback: z.looseObject({ blockReason: z.string().nullish() }).nullish(),
  usageMetadata: z
    .looseObject({
      promptTokenCount: z.number().nullish(),
      candidatesTokenCount: z.number().nullish(),
      thoughtsTokenCount: z.number().nullish(),
      totalTokenCount: z.number().nullish(),
    })
    .nullish(),
  modelVersion: z.string().nullish(),
});

const errorBodySchema = z.looseObject({
  error: z
    .looseObject({
      message: z.string().nullish(),
      details: z.array(z.looseObject({ retryDelay: z.string().nullish() })).nullish(),
    })
    .nullish(),
});

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: GeminiConfig, options: GeminiOptions = {}) {
    if (!MODEL_PATTERN.test(config.model)) {
      throw new AIError('invalid_request', 'AI_MODEL contains characters a model id cannot have.');
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
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

    const body = {
      ...(request.system?.trim() && {
        systemInstruction: { parts: [{ text: request.system }] },
      }),
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig: {
        maxOutputTokens: Math.min(
          request.maxOutputTokens ?? this.maxOutputTokens,
          this.maxOutputTokens,
        ),
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.json && { responseMimeType: 'application/json' }),
      },
    };

    const raw = await this.post(`/v1beta/models/${this.model}:generateContent`, body);
    return this.toResponse(raw);
  }

  private toResponse(raw: unknown): AIResponse {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AIError('invalid_response', 'Gemini returned an answer in an unexpected shape.');
    }
    const data = parsed.data;

    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) {
      throw new AIError('blocked', `Gemini blocked the prompt (${blockReason}).`);
    }

    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new AIError('invalid_response', 'Gemini returned no answer.');
    }

    const text = (candidate.content?.parts ?? []).map((part) => part.text ?? '').join('');
    const finishReason = candidate.finishReason ?? '';

    if (text === '' && BLOCKED_FINISH_REASONS.has(finishReason)) {
      throw new AIError('blocked', `Gemini refused to answer (${finishReason}).`);
    }
    if (text === '' && finishReason !== 'MAX_TOKENS') {
      throw new AIError('invalid_response', 'Gemini returned an empty answer.');
    }

    const usage = data.usageMetadata;
    const inputTokens = usage?.promptTokenCount ?? 0;
    // Thinking tokens are billed and count against the output limit, so they are included.
    const outputTokens = (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
    const result: AIUsage = {
      inputTokens,
      outputTokens,
      totalTokens: usage?.totalTokenCount ?? inputTokens + outputTokens,
    };

    return {
      text,
      usage: result,
      model: data.modelVersion ?? this.model,
      truncated: finishReason === 'MAX_TOKENS',
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;

      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (canRetry) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new AIError('network', `Could not reach Gemini: ${this.describeNetworkError(cause)}`);
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new AIError('invalid_response', 'Gemini returned a response that is not JSON.');
        }
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && canRetry) {
        await this.sleep(await this.retryDelay(response, attempt));
        continue;
      }

      throw await this.errorFor(response);
    }
  }

  private backoff(attempt: number): number {
    return Math.min(this.baseDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
  }

  private async retryDelay(response: Response, attempt: number): Promise<number> {
    const header = response.headers.get('retry-after');
    if (header !== null && Number.isFinite(Number(header)) && Number(header) >= 0) {
      return Math.min(Number(header) * 1000, MAX_RETRY_DELAY_MS);
    }

    // Google reports the wait as "23s" inside the error details.
    const detail = await this.readBody(response);
    for (const item of detail?.error?.details ?? []) {
      const match = /^(\d+(?:\.\d+)?)s$/.exec(item.retryDelay ?? '');
      if (match?.[1]) return Math.min(Number(match[1]) * 1000, MAX_RETRY_DELAY_MS);
    }
    return this.backoff(attempt);
  }

  private async readBody(response: Response): Promise<z.infer<typeof errorBodySchema> | undefined> {
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

  private async errorFor(response: Response): Promise<AIError> {
    const status = response.status;
    const body = await this.readBody(response);
    const detail = this.redact(body?.error?.message ?? '').slice(0, 200);
    const suffix = detail ? ` ${detail}` : '';

    const keyRejected =
      status === 401 || status === 403 || (status === 400 && /api key/i.test(detail));
    if (keyRejected) {
      return new AIError(
        'unauthorized',
        `Gemini rejected the API key (${status}). Check AI_API_KEY.`,
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
      return new AIError(
        'rate_limited',
        `Gemini rate limit or quota reached (429).${suffix}`,
        status,
      );
    }
    if (status >= 500) {
      return new AIError('server_error', `Gemini is unavailable (${status}).${suffix}`, status);
    }
    return new AIError(
      'invalid_request',
      `Gemini rejected the request (${status}).${suffix}`,
      status,
    );
  }

  private redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[redacted]') : text;
  }
}
