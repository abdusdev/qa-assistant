/**
 * Manual check helper: resolves an input to tickets, the way the tool will.
 *   npm run jira:resolve -- epic SHP-4110
 *   npm run jira:resolve -- sprint "SN - Sprint 45" --status Done --type Story,Bug
 *   npm run jira:resolve -- list "SHP-4111, SHP-4112 SHP-99999"
 * Options: --type A,B   --status A,B   --max N
 */
import { ConfigError, loadConfig } from '../config/env.js';
import { JiraClient } from './client.js';
import { JiraError } from './errors.js';
import { resolveInput, type InputMode } from './resolver.js';

const MODES: InputMode[] = ['ticket', 'list', 'sprint', 'epic', 'release'];

function parseArgs(argv: string[]) {
  const [mode, value, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const flagValue = rest[i + 1];
    if (name?.startsWith('--') && flagValue !== undefined) flags.set(name.slice(2), flagValue);
  }
  const csv = (name: string) =>
    flags
      .get(name)
      ?.split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  return { mode, value, types: csv('type'), statuses: csv('status'), max: flags.get('max') };
}

async function main(): Promise<void> {
  const { mode, value, types, statuses, max } = parseArgs(process.argv.slice(2));

  if (!mode || !MODES.includes(mode as InputMode) || value === undefined) {
    console.error(
      `Usage: npm run jira:resolve -- <${MODES.join('|')}> "<value>" [--type A,B] [--status A,B] [--max N]`,
    );
    process.exitCode = 1;
    return;
  }

  const { jira } = loadConfig();
  if (!jira) {
    console.error('Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env first.');
    process.exitCode = 1;
    return;
  }

  const client = new JiraClient({
    baseUrl: jira.baseUrl,
    email: jira.email,
    apiToken: jira.apiToken,
    ...(jira.acceptanceCriteriaField && { acceptanceCriteriaField: jira.acceptanceCriteriaField }),
  });

  const result = await resolveInput(
    client,
    {
      mode: mode as InputMode,
      value,
      filters: { ...(types && { types }), ...(statuses && { statuses }) },
    },
    {
      projectKey: jira.project,
      enableRelease: jira.enableRelease,
      ...(max && { maxTickets: Number(max) }),
    },
  );

  for (const ticket of result.tickets) {
    console.log(
      `${ticket.key.padEnd(10)} ${ticket.type.padEnd(8)} ${ticket.status.padEnd(14)} ${ticket.summary}`,
    );
  }
  console.log(`\n${result.tickets.length} ticket(s).`);
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof JiraError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
