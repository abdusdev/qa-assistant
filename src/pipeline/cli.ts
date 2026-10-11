/**
 * Runs the whole pipeline by hand: tickets in, test cases and a flow out.
 *
 *   npm run pipeline -- file evals/tickets/example-bulk-shipment.json
 *   npm run pipeline -- epic SHP-4110 --allow-real-tickets
 *   npm run pipeline -- sprint "SN - Sprint 45" --type Story,Bug,Task --max 5 --allow-real-tickets
 *
 * Options: --type A,B  --status A,B  --max N  --concurrency N  --no-review
 *          --allow-real-tickets  (needed to send real Jira tickets to Gemini)
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

  const result = await runPipeline(provider, tickets, {
    ...(concurrency !== undefined && { concurrency }),
    generate: { selfReview: !flags.has('no-review') },
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
  if (error instanceof ConfigError || error instanceof AIError || error instanceof JiraError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
