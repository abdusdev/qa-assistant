import type { PromptContext } from '../ai/prompt.js';
import { PROMPT_VERSION } from '../ai/prompt.js';
import type { AIProvider } from '../ai/types.js';
import type { AppConfig } from '../config/env.js';
import { createTicketCache, type Repository } from '../db/index.js';
import { CodeContextProvider, decideCodeContext, GitHubClient } from '../github/index.js';
import type { GitHubSource } from '../github/types.js';
import { resolveInput, type TicketSource } from '../jira/resolver.js';
import type { Ticket } from '../jira/ticket.js';
import { buildKnowledgeContext, type Knowledge } from '../knowledge/index.js';
import { combineContexts } from '../pipeline/context.js';
import { runPipeline, type PipelineResult } from '../pipeline/run.js';
import {
  RunError,
  type GenerateInput,
  type JobResult,
  type JobRunner,
  type RunnerContext,
} from './types.js';

export interface RunnerDeps {
  provider: AIProvider;
  /** Jira, or fixture tickets for offline runs. */
  tickets: TicketSource;
  config: Pick<AppConfig, 'jira' | 'github' | 'ai'>;
  /** The loaded knowledge folder. Looked up for every run so edits are picked up. */
  knowledge?: () => Promise<Knowledge | undefined>;
  /** Saves each run and caches results. Without it runs only live in memory. */
  repository?: Repository;
  /** Replaceable in tests. Defaults to the real client built from the settings. */
  github?: GitHubSource;
  /** Tickets processed at the same time inside one run. */
  ticketConcurrency?: number;
}

export function toJobResult(result: PipelineResult): JobResult {
  return {
    cases: result.cases,
    flow: result.flow,
    flowSource: result.flowSource,
    tickets: result.tickets,
    warnings: result.warnings,
    grounding: result.grounding,
    usage: result.usage,
    calls: result.calls,
    durationMs: result.durationMs,
    promptVersion: result.promptVersion,
  };
}

/**
 * Says whether a run could use code context the way the person asked, before anything starts.
 * Returns the reason in words when it could not, so the API can answer straight away.
 */
export function checkCodeContext(
  config: Pick<AppConfig, 'github'>,
  input: GenerateInput,
): string | undefined {
  const decision = decideCodeContext(config, {
    realTickets: true,
    flags: {
      force: input.useCodeContext === true,
      off: input.useCodeContext === false,
    },
  });
  return 'error' in decision ? decision.error : undefined;
}

/** The real runner: resolve tickets, build context, run the pipeline, save the run. */
export function createRunner(deps: RunnerDeps): JobRunner {
  return async ({ input, signal, report }: RunnerContext) => {
    report({ type: 'stage', stage: 'resolving' });

    // Writing one ticket again updates a saved run in place, so the run must exist.
    const regenerating = input.regenerateRunId;
    if (regenerating !== undefined) {
      if (!deps.repository) {
        throw new RunError('Writing a ticket again needs the database (DATABASE_URL).');
      }
      if (!(await deps.repository.getRun(regenerating))) {
        throw new RunError('The run to update does not exist.');
      }
    }

    const resolved = await resolveInput(
      deps.tickets,
      {
        mode: input.mode,
        value: input.value,
        filters: {
          ...(input.filters?.types && { types: input.filters.types }),
          ...(input.filters?.statuses && { statuses: input.filters.statuses }),
        },
      },
      {
        ...(deps.config.jira && {
          projectKey: deps.config.jira.project,
          enableRelease: deps.config.jira.enableRelease,
        }),
        ...(input.max !== undefined && { maxTickets: input.max }),
      },
    );
    if (resolved.tickets.length === 0) {
      throw new RunError(
        ['No tickets matched the input.', ...resolved.warnings].join(' ').slice(0, 600),
      );
    }

    const decision = decideCodeContext(deps.config, {
      realTickets: true,
      flags: {
        force: input.useCodeContext === true,
        off: input.useCodeContext === false,
      },
    });
    if ('error' in decision) throw new RunError(decision.error);

    const github: GitHubSource | undefined = decision.use
      ? (deps.github ??
        (deps.config.github ? new GitHubClient({ token: deps.config.github.token }) : undefined))
      : undefined;
    const code =
      decision.use && github
        ? new CodeContextProvider(github, { repos: decision.repos })
        : undefined;
    const knowledge = await deps.knowledge?.();

    const contextFor = async (ticket: Ticket): Promise<PromptContext> =>
      combineContexts({
        knowledge: knowledge && buildKnowledgeContext(knowledge, ticket),
        code: code && (await code.contextFor(ticket)),
      });

    report({ type: 'tickets', tickets: resolved.tickets.map((t) => t.key) });
    report({ type: 'stage', stage: 'generating' });

    const selfReview = input.selfReview ?? true;
    const repo = deps.repository;
    const runId =
      regenerating ??
      (repo
        ? await repo.createRun({
            mode: input.mode,
            value: input.value.slice(0, 500),
            filters: { ...input.filters, ...(input.max !== undefined && { max: input.max }) },
            promptVersion: PROMPT_VERSION,
          })
        : undefined);
    // A result from the cache would be the same cases again, which is not what was asked for.
    const cache =
      repo && regenerating === undefined
        ? createTicketCache(repo, {
            promptVersion: PROMPT_VERSION,
            model: deps.config.ai.model ?? deps.provider.name,
            selfReview,
          })
        : undefined;

    let result: PipelineResult;
    try {
      result = await runPipeline(deps.provider, resolved.tickets, {
        signal,
        contextFor,
        generate: { selfReview },
        ...(regenerating !== undefined && { buildFlow: false }),
        ...(cache && { cache }),
        ...(deps.ticketConcurrency !== undefined && { concurrency: deps.ticketConcurrency }),
        onProgress: (event) => {
          switch (event.type) {
            case 'ticket_started':
              report({ type: 'ticket', ticket: event.ticket, status: 'running' });
              break;
            case 'ticket_done':
              report({
                type: 'ticket',
                ticket: event.ticket,
                status: 'ok',
                cases: event.cases,
              });
              break;
            case 'ticket_failed':
              report({
                type: 'ticket',
                ticket: event.ticket,
                status: 'failed',
                error: event.error,
              });
              break;
            case 'ticket_skipped':
              report({
                type: 'ticket',
                ticket: event.ticket,
                status: 'skipped',
                error: event.reason,
              });
              break;
            case 'flow_started':
              report({ type: 'stage', stage: 'ordering' });
              break;
            default:
              break;
          }
        },
      });
    } catch (error) {
      // A run that stops (for example a rejected key) must not stay marked as running.
      if (repo && runId && regenerating === undefined) {
        await repo
          .failRun(runId, error instanceof Error ? error.message : String(error))
          .catch(() => undefined);
      }
      throw error;
    }

    const warnings = [...resolved.warnings, ...result.warnings];
    if (repo && runId && regenerating !== undefined) {
      // Only a ticket that was written successfully replaces the old cases. On a failure
      // or a cancel the run is left exactly as it was.
      const outcome = result.tickets[0];
      if (result.cancelled) throw new RunError('Cancelled. The run was left as it was.');
      if (!outcome || outcome.status !== 'ok') {
        throw new RunError(
          `The ticket could not be written again, so the run was left as it was: ${outcome?.error ?? 'no answer'}`,
        );
      }
      report({ type: 'stage', stage: 'saving' });
      const ticketKey = resolved.tickets[0]?.key ?? input.value;
      await repo.replaceTicketCases(runId, ticketKey, result.cases);
    } else if (repo && runId) {
      report({ type: 'stage', stage: 'saving' });
      await repo.saveResult(runId, { ...result, warnings });
    }

    return {
      result: { ...toJobResult(result), warnings },
      ...(runId !== undefined && { runId }),
      cancelled: result.cancelled,
    };
  };
}
