import { AIError } from './errors.js';
import type { AIProvider, AIRequest, AIResponse } from './types.js';

export interface FallbackEntry {
  /** A short name for logs and messages, such as the model id. */
  label: string;
  provider: AIProvider;
}

/** Reported when a model runs out of quota and the next one takes over. */
export interface ModelSwitch {
  from: string;
  /** The model that takes over, or undefined when no model is left. */
  to: string | undefined;
  reason: string;
}

export interface FallbackOptions {
  /** Told once each time a model becomes unavailable. */
  onSwitch?: (event: ModelSwitch) => void;
  /** Replaceable for tests. */
  now?: () => number;
  /** How long a model is skipped after its quota runs out, when the provider gives no time. */
  defaultCooldownMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Uses the first model that still has quota. When a model reports that its daily limit is
 * used up, it is skipped from then on (until its reset time) and the next model is tried.
 * Only quota errors switch models: a wrong key or a server error would not be fixed by it.
 */
export class FallbackProvider implements AIProvider {
  readonly name: string;
  /** Every switch that happened, oldest first. */
  readonly switches: ModelSwitch[] = [];

  private readonly entries: FallbackEntry[];
  private readonly unavailableUntil = new Map<number, number>();
  private readonly onSwitch: ((event: ModelSwitch) => void) | undefined;
  private readonly now: () => number;
  private readonly defaultCooldownMs: number;

  constructor(entries: FallbackEntry[], options: FallbackOptions = {}) {
    if (entries.length === 0) {
      throw new AIError('invalid_request', 'At least one model is needed.');
    }
    this.entries = entries;
    this.name = entries[0]?.provider.name ?? 'fallback';
    this.onSwitch = options.onSwitch;
    this.now = options.now ?? Date.now;
    this.defaultCooldownMs = options.defaultCooldownMs ?? 6 * HOUR_MS;
  }

  /** The model that will be tried first right now. */
  get currentModel(): string | undefined {
    const now = this.now();
    return this.entries.find((_, index) => (this.unavailableUntil.get(index) ?? 0) <= now)?.label;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    let lastError: AIError | undefined;

    for (let index = 0; index < this.entries.length; index++) {
      if ((this.unavailableUntil.get(index) ?? 0) > this.now()) continue;
      const entry = this.entries[index] as FallbackEntry;

      try {
        return await entry.provider.generate(request);
      } catch (error) {
        if (!(error instanceof AIError) || error.kind !== 'quota_exhausted') throw error;

        lastError = error;
        this.markUnavailable(index, error);
      }
    }

    throw new AIError(
      'quota_exhausted',
      `Every configured model has reached its daily limit (${this.entries
        .map((entry) => entry.label)
        .join(', ')}). ${lastError?.message ?? ''}`.trim(),
      429,
      this.shortestWaitMs(),
    );
  }

  private markUnavailable(index: number, error: AIError): void {
    const alreadyOut = (this.unavailableUntil.get(index) ?? 0) > this.now();
    this.unavailableUntil.set(index, this.now() + (error.retryAfterMs ?? this.defaultCooldownMs));
    if (alreadyOut) return; // several parallel calls can fail together; report once

    const from = (this.entries[index] as FallbackEntry).label;
    const event: ModelSwitch = {
      from,
      to: this.currentModel,
      reason: error.message,
    };
    this.switches.push(event);
    try {
      this.onSwitch?.(event);
    } catch {
      // A broken listener must never break a run.
    }
  }

  private shortestWaitMs(): number | undefined {
    const now = this.now();
    const waits = [...this.unavailableUntil.values()]
      .map((until) => until - now)
      .filter((w) => w > 0);
    return waits.length > 0 ? Math.min(...waits) : undefined;
  }
}
