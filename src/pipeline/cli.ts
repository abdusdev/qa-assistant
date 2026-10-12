/**
 * Runs the whole pipeline by hand: tickets in, test cases and a flow out.
 *
 *   npm run pipeline -- file evals/tickets/example-bulk-shipment.json
 *   npm run pipeline -- epic SHP-4110 --allow-real-tickets
 *   npm run pipeline -- sprint "SN - Sprint 45" --type Story,Bug,Task --max 5 --allow-real-tickets
 *
 * Options: --type A,B  --status A,B  --max N  --concurrency N  --no-review
 *          --allow-real-tickets  (needed to send real Jira tickets to Gemini)
 *          --no-code-context     leave the pull request changes out of this run
 *          --allow-code-to-ai    agree, for this run, that source code goes to the AI provider
 *                                (or set ALLOW_CODE_TO_AI=true in .env)
 *
 * Code context is included by default for real tickets. Set GITHUB_TOKEN, GITHUB_REPOS and
 * ALLOW_CODE_TO_AI=true in .env.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEvalFile } from '../ai/eval-file.js';
import { createProvider } from '../ai/index.js';
import { AIError } from '../ai/errors.js';
import { ConfigError, loadConfig } from '../config/env.js';
import { JiraClient } from '../jira/client.js';
import { JiraError } from '../jira/errors.js';
import { resolveInput, type InputMode } from '../jira/resolver.js';
import type { Ticket } from '../jira/ticket.js';
import { PROMPT_VERSION } from '../ai/prompt.js';
import { createTicketCache, migrate, openDatabase, Repository, type Db } from '../db/index.js';
import {
  CodeContextProvider,
  GitHubClient,
  GitHubError,
  decideCodeContext,
} from '../github/index.js';
import { buildKnowledgeContext, loadKnowledge, type Knowledge } from '../knowledge/index.js';
import { combineContexts } from './context.js';
import { runPipeline } from './run.js';

const JIRA_MODES: InputMode[] = ['ticket', 'list', 'sprint', 'epic', 'release'];

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { positional, flags };
}

const csv = (value: string | true | undefined) =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    : undefined;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [mode, ...rest] = positional;

  const usage =
    'Usage: npm run pipeline -- file <path.json> [<path.json> ...]\n' +
    `       npm run pipeline -- <${JIRA_MODES.join('|')}> "<value>" [--type A,B] [--status A,B] ` +
    '[--max N] [--allow-real-tickets]';
  if (!mode || rest.length === 0) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const provider = createProvider(config.ai, {
    onSwitch: (e) =>
      console.log(
        `! ${e.from} has used its daily limit. ${e.to ? `Switching to ${e.to}.` : 'No other model is left.'}`,
      ),
  });
  if (provider.name === 'fake') {
    console.error('AI_PROVIDER is "fake", which gives no real answers. Set AI_PROVIDER=gemini.');
    process.exitCode = 1;
    return;
  }

  // The code changes of each ticket are included on every real run. Sending code to the AI provider
  // is agreed to once (ALLOW_CODE_TO_AI) or per run (--allow-code-to-ai); without it the run stops.
  const codeDecision = decideCodeContext(config, {
    realTickets: mode !== 'file',
    flags: {
      force: flags.has('code-context'),
      off: flags.has('no-code-context'),
      allow: flags.has('allow-code-to-ai'),
    },
  });
  if ('error' in codeDecision) {
    console.error(codeDecision.error);
    process.exitCode = 1;
    return;
  }
  let codeContext: CodeContextProvider | undefined;
  if (codeDecision.use && config.github) {
    codeContext = new CodeContextProvider(new GitHubClient({ token: config.github.token }), {
      repos: codeDecision.repos,
    });
    console.log(`Code context: on (${codeDecision.repos.join(', ')})`);
  } else if (!codeDecision.use) {
    console.log(`${codeDecision.warn ? '! ' : ''}Code context: off, ${codeDecision.reason}`);
  }

  let tickets: Ticket[] = [];
  const warnings: string[] = [];

  if (mode === 'file') {
    for (const file of rest) tickets.push((await loadEvalFile(file)).ticket);
  } else if (JIRA_MODES.includes(mode as InputMode)) {
    if (!flags.has('allow-real-tickets')) {
      console.error(
        'This would send real Jira ticket text to the AI provider.\n' +
          'On the free Gemini tier, Google may use that content to improve its products and ' +
          'reviewers may read it.\nUse the paid tier or get approval, then add --allow-real-tickets.\n' +
          'To try the pipeline safely, use: npm run pipeline -- file evals/tickets/example-bulk-shipment.json',
      );
      process.exitCode = 1;
      return;
    }
    if (!config.jira) {
      console.error('Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env first.');
      process.exitCode = 1;
      return;
    }

    const client = new JiraClient({
      baseUrl: config.jira.baseUrl,
      email: config.jira.email,
      apiToken: config.jira.apiToken,
      ...(config.jira.acceptanceCriteriaField && {
        acceptanceCriteriaField: config.jira.acceptanceCriteriaField,
      }),
    });
    const types = csv(flags.get('type'));
    const statuses = csv(flags.get('status'));
    const max = typeof flags.get('max') === 'string' ? Number(flags.get('max')) : undefined;

    const resolved = await resolveInput(
      client,
      {
        mode: mode as InputMode,
        value: rest.join(' '),
        filters: { ...(types && { types }), ...(statuses && { statuses }) },
      },
      {
        projectKey: config.jira.project,
        enableRelease: config.jira.enableRelease,
        ...(max !== undefined && { maxTickets: max }),
      },
    );
    tickets = resolved.tickets;
    warnings.push(...resolved.warnings);
  } else {
    console.error(`Unknown input type "${mode}".\n${usage}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Provider: ${provider.name}${config.ai.model ? ` (${config.ai.model})` : ''} | tickets: ${tickets.length}\n`,
  );

  const concurrency =
    typeof flags.get('concurrency') === 'string' ? Number(flags.get('concurrency')) : undefined;

  const selfReview = !flags.has('no-review');

  // Product knowledge, module notes and past cases for each ticket.
  let knowledge: Knowledge | undefined;
  if (!flags.has('no-knowledge')) {
    const knowledgeFlag = flags.get('knowledge');
    const dir = typeof knowledgeFlag === 'string' ? knowledgeFlag : 'knowledge';
    knowledge = await loadKnowledge(dir);
    const filled =
      Boolean(knowledge.overview || knowledge.glossary || knowledge.standards) ||
      knowledge.modules.length > 0 ||
      (knowledge.codeNotes?.length ?? 0) > 0 ||
      knowledge.pastCases.length > 0;
    console.log(
      filled
        ? `Knowledge (${dir}): ${knowledge.modules.length} module note(s), ` +
            `${knowledge.pastCases.length} past case(s)
`
        : `Knowledge (${dir}) is empty, so the AI works from the ticket alone. See knowledge/README.md.
`,
    );
    if (!filled) knowledge = undefined;
  }

  // With DATABASE_URL set, the run is saved and unchanged tickets are not sent to the AI again.
  let db: Db | undefined;
  let repo: Repository | undefined;
  let runId: string | undefined;
  if (config.databaseUrl && !flags.has('no-save')) {
    db = await openDatabase(config.databaseUrl);
    await migrate(db);
    repo = new Repository(db);
    runId = await repo.createRun({
      mode,
      value: rest.join(' ').slice(0, 500),
      filters: {
        ...(csv(flags.get('type')) && { types: csv(flags.get('type')) }),
        ...(csv(flags.get('status')) && { statuses: csv(flags.get('status')) }),
      },
      promptVersion: PROMPT_VERSION,
    });
  }

  const cache =
    repo && !flags.has('no-cache')
      ? createTicketCache(repo, {
          promptVersion: PROMPT_VERSION,
          model: config.ai.model ?? provider.name,
          selfReview,
        })
      : undefined;

  const result = await runPipeline(provider, tickets, {
    ...(concurrency !== undefined && { concurrency }),
    ...(cache && { cache }),
    ...((knowledge || codeContext) && {
      contextFor: async (ticket: Ticket) =>
        combineContexts({
          knowledge: knowledge && buildKnowledgeContext(knowledge, ticket),
          code: codeContext && (await codeContext.contextFor(ticket)),
        }),
    }),
    generate: { selfReview },
    onProgress: (event) => {
      if (event.type === 'ticket_done') {
        console.log(
          `  ok      ${event.ticket}: ${event.cases} cases (${event.done}/${event.total})`,
        );
      } else if (event.type === 'ticket_failed') {
        console.log(`  FAILED  ${event.ticket} (${event.done}/${event.total})`);
      } else if (event.type === 'ticket_skipped') {
        console.log(`  skipped ${event.ticket}: ${event.reason}`);
      } else if (event.type === 'flow_started') {
        console.log(`  ordering ${event.cases} cases into a flow...`);
      }
    },
  }).catch(async (error: unknown) => {
    // A run that stops (for example a rejected key) must not stay marked as running.
    if (repo && runId) {
      await repo.failRun(runId, error instanceof Error ? error.message : String(error));
    }
    await db?.close();
    throw error;
  });

  console.log(`\n== Test flow (${result.flowSource}) ==`);
  for (const step of result.flow.steps) {
    console.log(`${step.order}. ${step.name}${step.description ? ` - ${step.description}` : ''}`);
    for (const id of step.caseIds) {
      const c = result.cases.find((testCase) => testCase.id === id);
      if (c) {
        const mark =
          c.grounding === 'grounded'
            ? 'grounded'
            : `${c.grounding}, ${c.assumptions.length} to confirm`;
        console.log(`     ${c.id} [${c.type}/${c.priority}] (${mark}) ${c.ticket}: ${c.title}`);
      }
    }
  }

  const allWarnings = [...warnings, ...result.warnings];
  if (allWarnings.length > 0) {
    console.log('\n== Warnings ==');
    for (const warning of allWarnings) console.log(`- ${warning}`);
  }

  console.log(
    `\n${result.cases.length} cases: ${result.grounding.grounded} grounded, ` +
      `${result.grounding.partly} partly grounded, ${result.grounding.assumed} assumed | ` +
      `from ${result.tickets.filter((t) => t.status === 'ok').length} of ` +
      `${result.tickets.length} tickets | ${result.calls} AI calls | ${result.usage.totalTokens} tokens | ` +
      `${(result.durationMs / 1000).toFixed(1)} s`,
  );

  if (repo && runId) {
    await repo.saveResult(runId, result);
    const fromCache = result.tickets.filter((t) => t.cached).length;
    console.log(
      `Saved as run ${runId}${fromCache > 0 ? ` (${fromCache} ticket(s) came from the cache)` : ''}`,
    );
  }
  await db?.close();

  const outDir = path.resolve('out');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(
    outDir,
    `pipeline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  await writeFile(outFile, JSON.stringify({ ...result, inputWarnings: warnings }, null, 2));
  console.log(`Full result: ${path.relative(process.cwd(), outFile)}`);
}

main().catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof AIError ||
    error instanceof JiraError ||
    error instanceof GitHubError
  ) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
