/** One request to an AI model: instructions plus one user message. */
export interface AIRequest {
  /** Fixed instructions, such as the role, rules and output format. */
  system?: string;
  /** The message for this call, such as a ticket and its context. */
  prompt: string;
  /** Ask the model to answer with JSON only. */
  json?: boolean;
  /** Upper limit for the answer length. Cannot exceed the provider's configured cap. */
  maxOutputTokens?: number;
  /** 0 is the most predictable. Test cases should stay low. */
  temperature?: number;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AIResponse {
  text: string;
  usage: AIUsage;
  /** The model that answered. */
  model: string;
  /** True when the answer was cut off by the output limit, so it may be incomplete. */
  truncated: boolean;
}

/** What the rest of the app needs from an AI model. Providers implement this. */
export interface AIProvider {
  readonly name: string;
  generate(request: AIRequest): Promise<AIResponse>;
}

/** Adds up token usage over many calls, for a per-run total. */
export class UsageTracker {
  private totals: AIUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private callCount = 0;

  add(usage: AIUsage): void {
    this.totals = {
      inputTokens: this.totals.inputTokens + usage.inputTokens,
      outputTokens: this.totals.outputTokens + usage.outputTokens,
      totalTokens: this.totals.totalTokens + usage.totalTokens,
    };
    this.callCount += 1;
  }

  get total(): AIUsage {
    return { ...this.totals };
  }

  get calls(): number {
    return this.callCount;
  }
}
