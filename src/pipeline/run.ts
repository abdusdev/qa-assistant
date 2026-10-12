import { AIError } from '../ai/errors.js';
import { FlowError, generateFlow } from '../ai/flow.js';
import { generateTestCases, GenerationError, type GenerateOptions } from '../ai/generate.js';
import { PROMPT_VERSION, type PromptContext } from '../ai/prompt.js';
import type { Flow, TestCase } from '../ai/schemas.js';
import { UsageTracker, type AIProvider, type AIUsage } from '../ai/types.js';
import type { Ticket } from '../jira/ticket.js';
import { mapLimit } from '../util/concurrency.js';
import { removeCrossTicketDuplicates } from './dedupe.js';
import { applyFlow, enforceDependencyOrder, fallbackFlow } from './flow.js';

export type ProgressEvent =
  | { type: 'ticket_started'; ticket: string; done: number; total: number }
  | { type: 'ticket_done'; ticket: string; cases: number; done: number; total: number }
  | { type: 'ticket_failed'; ticket: string; error: string; done: number; total: number }
  | { type: 'ticket_skipped'; ticket: string; reason: string; done: number; total: number }
  | { type: 'flow_started'; cases: number }
  | { type: 'flow_done'; source: 'ai' | 'fallback' }
  | { type: 'finished' };

export interface Pricing {
  /** Price in US dollars per million input tokens. */
  inputPerMillion: number;
  /** Price in US dollars per million output tokens. */
  outputPerMillion: number;
}

/** What the pipeline needs from a result cache. The database provides one. */
export interface TicketCache {
  get(ticket: Ticket, context: PromptContext): Promise<CachedTicketResult | undefined>;
  put(ticket: Ticket, context: PromptContext, result: CachedTicketResult): Promise<void>;
}

export interface CachedTicketResult {
  cases: TestCase[];
  detail: { sufficient: boolean; missing: string[] };
  model: string;
}

export interface PipelineOptions {
  /** Tickets processed at the same time. Default 3. */
  concurrency?: number;
  /** Passed to every ticket's generation: retries, self-review, temperature. */
  generate?: Pick<GenerateOptions, 'maxRetries' | 'selfReview' | 'temperature'>;
  /** Looks up extra context per ticket: module notes, past cases, code changes. */
  contextFor?: (ticket: Ticket) => PromptContext | Promise<PromptContext>;
  onProgress?: (event: ProgressEvent) => void;
  /** Aborting stops new tickets from starting. Finished work is kept. */
  signal?: AbortSignal;
  /** Set false to skip the AI flow step and group by each case's own step. */
  buildFlow?: boolean;
  /** Cross-ticket duplicates at or above this similarity are removed. Default 0.8. */
  duplicateThreshold?: number;
  /** Above this many cases the flow is grouped without the AI. Default 300. */
  maxCasesForAiFlow?: number;
  /** Stop the run after this many rate-limit failures in a row. Default 3. */
  maxConsecutiveRateLimits?: number;
  /** Used to estimate the cost of the run. */
  pricing?: Pricing;
  /** Results of earlier runs. A ticket that has not changed is not sent to the AI again. */
  cache?: TicketCache;
}

export interface TicketOutcome {
  ticket: string;
  status: 'ok' | 'failed' | 'skipped';
  cases: number;
  attempts?: number;
  reviewed?: boolean;
  reviewNote?: string;
  /** The model that answered, useful when several models are configured. */
  model?: string;
  /** True when the cases came from an earlier run and the AI was not called. */
  cached?: boolean;
  /** What knowledge and context was chosen for this ticket, when the caller reports it. */
  context?: unknown;
  /** Whether the ticket said enough to write reliable cases, and what was missing. */
  detail?: { sufficient: boolean; missing: string[] };
  error?: string;
}

export interface PipelineResult {
  /** Cases numbered TC-1..n across the run, ordered by the flow. */
  cases: TestCase[];
  flow: Flow;
  /** Where the flow came from: the AI, the grouping fallback, or none (no cases). */
  flowSource: 'ai' | 'fallback' | 'none';
  /** One entry per input ticket, in input order. */
  tickets: TicketOutcome[];
  warnings: string[];
  /** Cases fully grounded in the ticket or context, partly grounded, and resting on assumptions. */
  grounding: { grounded: number; partly: number; assumed: number };
  usage: AIUsage;
  calls: number;
  /** Set only when pricing was given. In US dollars. */
  estimatedCostUsd?: number;
  promptVersion: string;
  cancelled: boolean;
  durationMs: number;
}

const FATAL_KINDS = new Set(['unauthorized', 'model_not_found']);

export function estimateCost(usage: AIUsage, pricing: Pricing): number {
  return (
    (usage.inputTokens * pricing.inputPerMillion + usage.outputTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Turns tickets into test cases and one ordered flow.
 *
 * - tickets run in parallel up to a limit, and one failing ticket never stops the others
 * - a broken AI connection (bad key, unknown model) stops the run at once and throws
 * - repeated rate-limit failures stop the run, and the finished tickets are kept
 * - cases are de-duplicated across tickets and numbered TC-1..n over the whole run
 * - the flow comes from the AI, or from a plain grouping when the AI cannot produce a sound one
 */
export async function runPipeline(
  provider: AIProvider,
  tickets: Ticket[],
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const started = Date.now();
  const tracker = new UsageTracker();
  const warnings: string[] = [];
  const total = tickets.length;
  const maxStreak = Math.max(1, options.maxConsecutiveRateLimits ?? 3);

  const outcomes = new Array<TicketOutcome>(total);
  const casesByTicket: TestCase[][] = tickets.map(() => []);

  let done = 0;
  let fatal: AIError | undefined;
  let rateLimitStreak = 0;
  let halted: 'rate_limit' | 'quota' | undefined;
  let cancelled = false;

  const emit = (event: ProgressEvent) => {
    try {
      options.onProgress?.(event);
    } catch {
      // A broken progress listener must never break the run.
    }
  };

  const skip = (index: number, ticket: Ticket, reason: string) => {
    outcomes[index] = { ticket: ticket.key, status: 'skipped', cases: 0, error: reason };
    done++;
    emit({ type: 'ticket_skipped', ticket: ticket.key, reason, done, total });
  };

  await mapLimit(tickets, options.concurrency ?? 3, async (ticket, index) => {
    if (options.signal?.aborted) {
      cancelled = true;
      return skip(index, ticket, 'The run was cancelled.');
    }
    if (fatal) return skip(index, ticket, 'Skipped: the AI connection is not working.');
    if (halted) return skip(index, ticket, 'Skipped: the AI rate limit or quota was reached.');

    emit({ type: 'ticket_started', ticket: ticket.key, done, total });

    try {
      const context = (await options.contextFor?.(ticket)) ?? {};

      // A ticket that has not changed since an earlier run does not cost another AI call.
      const hit = await options.cache?.get(ticket, context).catch(() => undefined);
      if (hit) {
        casesByTicket[index] = hit.cases;
        outcomes[index] = {
          ticket: ticket.key,
          status: 'ok',
          cases: hit.cases.length,
          cached: true,
          ...(context.meta !== undefined && { context: context.meta }),
          model: hit.model,
          detail: hit.detail,
        };
        done++;
        emit({ type: 'ticket_done', ticket: ticket.key, cases: hit.cases.length, done, total });
        return;
      }

      const result = await generateTestCases(provider, ticket, {
        ...options.generate,
        context,
        usage: tracker,
      });

      // Only a finished result is remembered: a draft whose review failed should be retried later.
      if (result.reviewed || options.generate?.selfReview === false) {
        await options.cache
          ?.put(ticket, context, {
            cases: result.cases,
            detail: result.detail,
            model: result.model,
          })
          .catch(() => undefined);
      }

      casesByTicket[index] = result.cases;
      outcomes[index] = {
        ticket: ticket.key,
        status: 'ok',
        cases: result.cases.length,
        attempts: result.attempts,
        reviewed: result.reviewed,
        ...(context.meta !== undefined && { context: context.meta }),
        model: result.model,
        detail: result.detail,
        ...(result.reviewNote !== undefined && { reviewNote: result.reviewNote }),
      };
      rateLimitStreak = 0;
      done++;
      emit({ type: 'ticket_done', ticket: ticket.key, cases: result.cases.length, done, total });
    } catch (error) {
      if (error instanceof AIError && FATAL_KINDS.has(error.kind)) {
        fatal ??= error;
      } else if (error instanceof AIError && error.kind === 'quota_exhausted') {
        halted ??= 'quota'; // every configured model is out for the day: more calls cannot succeed
      } else if (error instanceof AIError && error.kind === 'rate_limited') {
        rateLimitStreak++;
        if (rateLimitStreak >= maxStreak) halted ??= 'rate_limit';
      } else if (error instanceof GenerationError) {
        rateLimitStreak = 0; // the AI answered, so the connection and quota work
      }

      const message = messageOf(error);
      outcomes[index] = { ticket: ticket.key, status: 'failed', cases: 0, error: message };
      done++;
      emit({ type: 'ticket_failed', ticket: ticket.key, error: message, done, total });
    }
  });

  // A wrong key or model fails every ticket the same way, so report it instead of a pile of failures.
  if (fatal) throw fatal;

  const failed = outcomes.filter((o) => o.status === 'failed');
  if (failed.length > 0) {
    warnings.push(
      `${failed.length} of ${total} tickets failed: ${failed.map((o) => o.ticket).join(', ')}.`,
    );
  }
  for (const outcome of outcomes) {
    if (outcome.status === 'ok' && outcome.detail && !outcome.detail.sufficient) {
      warnings.push(
        `${outcome.ticket} has too little detail for reliable cases` +
          (outcome.detail.missing.length > 0 ? `: ${outcome.detail.missing.join(' ')}` : '.') +
          ' Treat its cases as drafts built on assumptions.',
      );
    }
  }
  if (options.generate?.selfReview !== false) {
    const unreviewed = outcomes.filter((o) => o.status === 'ok' && o.reviewed === false);
    if (unreviewed.length > 0) {
      const reason = unreviewed[0]?.reviewNote?.replace(/^The review [^:]*: /, '') ?? '';
      warnings.push(
        `The quality review did not complete for ${unreviewed.length} ticket(s), so their first ` +
          `drafts were kept: ${unreviewed.map((o) => o.ticket).join(', ')}. ` +
          (reason ? `Reason: ${reason.slice(0, 160)}` : ''),
      );
    }
  }
  if (halted) {
    const skipped = outcomes.filter((o) => o.status === 'skipped').length;
    warnings.push(
      halted === 'quota'
        ? `The run stopped early because every configured AI model has used its daily limit ` +
            `(${skipped} tickets were not processed). Wait for the reset, add another model to ` +
            'AI_FALLBACK_MODELS, or use a paid tier, then run the remaining tickets again.'
        : `The run stopped early after repeated rate-limit errors (${skipped} tickets were not processed). ` +
            'Wait for the quota to reset, or use a paid tier, and run the remaining tickets again.',
    );
  }
  if (cancelled || options.signal?.aborted) {
    cancelled = true;
    warnings.push('The run was cancelled. Tickets finished before that are kept.');
  }

  // Merge in ticket order (not completion order), then remove repeats across tickets.
  const merged = casesByTicket.flat();
  const { kept, removed } = removeCrossTicketDuplicates(merged, options.duplicateThreshold ?? 0.8);
  for (const { removed: gone, keptInstead } of removed) {
    warnings.push(
      `Left out "${gone.title}" (${gone.ticket}): near-duplicate of "${keptInstead.title}" (${keptInstead.ticket}).`,
    );
  }

  // Every case gets its run-wide number. Dependencies point at the new numbers; a dependency
  // on a case that was removed as a duplicate points at the case that was kept instead.
  const newId = new Map<TestCase, string>();
  kept.forEach((c, index) => newId.set(c, `TC-${index + 1}`));
  for (const { removed: gone, keptInstead } of removed) {
    const target = newId.get(keptInstead);
    if (target) newId.set(gone, target);
  }
  const byTicketAndId = new Map(merged.map((c) => [`${c.ticket}|${c.id}`, c]));

  const numbered = kept.map((c, index) => {
    const id = `TC-${index + 1}`;
    const dependsOn = c.depends_on
      .map((dep) => {
        const target = byTicketAndId.get(`${c.ticket}|${dep}`);
        return target ? newId.get(target) : undefined;
      })
      .filter((dep): dep is string => dep !== undefined && dep !== id);
    return { ...c, id, depends_on: [...new Set(dependsOn)] };
  });

  // The flow: AI first, plain grouping if that fails. Either way every case lands in one step.
  let flow: Flow = { steps: [] };
  let flowSource: PipelineResult['flowSource'] = 'none';

  if (numbered.length > 0) {
    emit({ type: 'flow_started', cases: numbered.length });
    const maxForAi = options.maxCasesForAiFlow ?? 300;
    let useFallback = false;

    if (options.buildFlow === false) {
      useFallback = true;
    } else if (options.signal?.aborted) {
      useFallback = true;
    } else if (numbered.length > maxForAi) {
      useFallback = true;
      warnings.push(
        `${numbered.length} cases is too many for the AI to order in one pass, so they were ` +
          'grouped by their own flow step instead.',
      );
    } else {
      try {
        const result = await generateFlow(provider, numbered, { usage: tracker });
        flow = result.flow;
        flowSource = 'ai';
      } catch (error) {
        if (!(error instanceof FlowError || error instanceof AIError)) throw error;
        useFallback = true;
        warnings.push(
          `The AI could not order the flow (${error.message}) so the cases were grouped by ` +
            'their own flow step instead.',
        );
      }
    }

    if (useFallback) {
      flow = fallbackFlow(numbered);
      flowSource = 'fallback';
    }
    emit({ type: 'flow_done', source: flowSource === 'ai' ? 'ai' : 'fallback' });
  }

  if (flow.steps.length > 0) {
    const ordered = enforceDependencyOrder(numbered, flow);
    flow = ordered.flow;
    if (ordered.moved.length > 0) {
      warnings.push(
        `${ordered.moved.length} case(s) were moved after the case they depend on: ` +
          `${ordered.moved.join(', ')}.`,
      );
    }
    if (ordered.cyclic) {
      warnings.push(
        'Some cases depend on each other in a circle, so their order could not be fixed.',
      );
    }
  }

  const cases = applyFlow(numbered, flow);
  const countOf = (level: TestCase['grounding']) =>
    cases.filter((c) => c.grounding === level).length;
  emit({ type: 'finished' });

  const usage = tracker.total;
  return {
    cases,
    flow,
    flowSource,
    tickets: outcomes,
    warnings,
    grounding: {
      grounded: countOf('grounded'),
      partly: countOf('partly'),
      assumed: countOf('assumed'),
    },
    usage,
    calls: tracker.calls,
    ...(options.pricing && { estimatedCostUsd: estimateCost(usage, options.pricing) }),
    promptVersion: PROMPT_VERSION,
    cancelled,
    durationMs: Date.now() - started,
  };
}
