import { AIError } from './errors.js';
import type { AIProvider, AIRequest, AIResponse } from './types.js';

/** What the fake returns for one call: an answer, or an error to throw. */
export type FakeReply = string | Error | ((request: AIRequest) => string | Promise<string>);

export interface FakeAIOptions {
  /** Replies used in order, one per call. */
  replies?: FakeReply[];
  /** Used when the replies run out. If not set, running out is an error. */
  fallback?: FakeReply;
  /** Pretend delay in milliseconds, for testing slow answers. */
  delayMs?: number;
}

const approxTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

/**
 * An AI stand-in that returns prepared answers. Used by tests and for local work,
 * so nothing calls a real model or costs money.
 */
export class FakeAIProvider implements AIProvider {
  readonly name = 'fake';
  /** Every request received, for assertions in tests. */
  readonly calls: AIRequest[] = [];

  private readonly queue: FakeReply[];
  private readonly fallback: FakeReply | undefined;
  private readonly delayMs: number;

  constructor(options: FakeAIOptions = {}) {
    this.queue = [...(options.replies ?? [])];
    this.fallback = options.fallback;
    this.delayMs = options.delayMs ?? 0;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.calls.push(request);

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const reply = this.queue.shift() ?? this.fallback;
    if (reply === undefined) {
      throw new AIError('invalid_response', 'The fake AI has no more prepared replies.');
    }
    if (reply instanceof Error) throw reply;

    const text = typeof reply === 'function' ? await reply(request) : reply;
    const inputTokens = approxTokens((request.system ?? '') + request.prompt);
    const outputTokens = approxTokens(text);

    return {
      text,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: 'fake',
      truncated: false,
    };
  }
}
