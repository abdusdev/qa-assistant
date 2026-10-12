/**
 * Helpers for the knowledge folder.
 *   npm run knowledge -- check [dir]                      what was found, and what is missing
 *   npm run knowledge -- match SHP-1234 [dir]             which notes and past cases a ticket gets
 *   npm run knowledge -- import-cases cases.csv [--module Shipments] [--out file.md]
 *   npm run knowledge -- components                       components and labels used in Jira
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadConfig } from '../config/env.js';
import { JiraClient } from '../jira/client.js';
import { JiraError } from '../jira/errors.js';
import { loadKnowledge } from './loader.js';
import { buildKnowledgeContext } from './match.js';
import { importCsv, serializePastCases } from './past-cases.js';

const USAGE =
  'Usage: npm run knowledge -- <check [dir] | match KEY [dir] | import-cases file.csv ' +
  '[--module NAME] [--out FILE] | components>';

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

const approxTokens = (chars: number) => Math.round(chars / 4);

async function check(dir: string): Promise<void> {
  const knowledge = await loadKnowledge(dir);
  const yes = (value: string | undefined) =>
    value
      ? `yes (${value.length} characters, about ${approxTokens(value.length)} tokens)`
      : 'NOT FILLED IN';

  console.log(`Knowledge folder: ${dir}`);
  console.log(`  overview.md   ${yes(knowledge.overview)}`);
  console.log(`  glossary.md   ${yes(knowledge.glossary)}`);
  console.log(`  standards.md  ${yes(knowledge.standards)}`);

  console.log(`  modules       ${knowledge.modules.length}`);
  for (const module of knowledge.modules) {
    const hints = [
      module.components.length > 0 && `components: ${module.components.join(', ')}`,
      module.labels.length > 0 && `labels: ${module.labels.join(', ')}`,
      module.keywords.length > 0 && `${module.keywords.length} keywords`,
    ].filter(Boolean);
    console.log(
      `    - ${module.name} (${module.body.length} characters; ${hints.join('; ') || 'no matching hints'})`,
    );
    if (hints.length === 0) {
      console.log('      Add components, labels or keywords so tickets can find this note.');
    }
  }

  const byModule = new Map<string, number>();
  for (const pastCase of knowledge.pastCases) {
    const key = pastCase.module ?? '(no module)';
    byModule.set(key, (byModule.get(key) ?? 0) + 1);
  }
  console.log(`  code overviews ${knowledge.codeNotes?.length ?? 0} reviewed`);
  console.log(`  past cases    ${knowledge.pastCases.length}`);
  for (const [module, count] of byModule) console.log(`    - ${module}: ${count}`);

  const fixed = [knowledge.overview, knowledge.glossary, knowledge.standards]
    .filter(Boolean)
    .reduce((sum, text) => sum + (text?.length ?? 0), 0);
  if (fixed > 12_000) {
    console.log(
      `\nThe fixed knowledge is ${fixed} characters. Very long text costs tokens on every ticket and ` +
        'can drown out the ticket. Aim for under 12,000.',
    );
  }

  if (knowledge.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of knowledge.warnings) console.log(`  - ${warning}`);
  }
}

async function jiraClient(): Promise<{ client: JiraClient; project: string }> {
  const { jira } = loadConfig();
  if (!jira) throw new Error('Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env first.');
  return {
    client: new JiraClient({
      baseUrl: jira.baseUrl,
      email: jira.email,
      apiToken: jira.apiToken,
    }),
    project: jira.project,
  };
}

async function match(key: string, dir: string): Promise<void> {
  const knowledge = await loadKnowledge(dir);
  const { client } = await jiraClient();
  const ticket = await client.getIssue(key);
  const context = buildKnowledgeContext(knowledge, ticket);

  console.log(`${ticket.key}: ${ticket.summary}`);
  console.log(`  components: ${(ticket.components ?? []).join(', ') || '(none)'}`);
  console.log(`  labels:     ${ticket.labels.join(', ') || '(none)'}\n`);

  if (context.meta.modules.length === 0) {
    console.log(
      "No module note matched. Add this ticket's component, a label or a keyword to a module note.",
    );
  }
  for (const module of context.meta.modules) {
    console.log(`Module note: ${module.name} (score ${module.score})`);
    for (const reason of module.reasons) console.log(`  - ${reason}`);
  }
  console.log(
    context.meta.pastCases.length > 0
      ? `\nPast cases chosen (${context.meta.pastCases.length}):`
      : '\nNo past case is similar enough.',
  );
  for (const pastCase of context.meta.pastCases) {
    console.log(`  - ${pastCase.title} [${pastCase.source}] similarity ${pastCase.score}`);
  }
  console.log(
    `\nThe AI would receive: ${context.productKnowledge?.length ?? 0} characters of fixed knowledge, ` +
      `${context.moduleNotes?.length ?? 0} of module notes, ${context.pastCases?.join('').length ?? 0} of past cases.`,
  );
}

async function importCases(args: string[]): Promise<void> {
  const file = args[0];
  if (!file || file.startsWith('--')) throw new Error('Give the CSV file to import.');

  const module = flagValue(args, 'module');
  const csv = await readFile(file, 'utf8');
  const result = importCsv(csv, path.basename(file), module);

  const columns = Object.entries(result.columns)
    .map(([field, column]) => `${field} <- "${column}"`)
    .join(', ');
  console.log(`Columns used: ${columns || '(none recognised)'}`);
  console.log(`Imported ${result.cases.length} case(s); skipped ${result.skipped.length}.`);
  for (const skipped of result.skipped.slice(0, 10)) {
    console.log(`  row ${skipped.row}: ${skipped.reason}`);
  }
  if (result.cases.length === 0) return;

  const out =
    flagValue(args, 'out') ??
    path.join('knowledge', 'past-cases', `${path.basename(file, path.extname(file))}.md`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, serializePastCases(result.cases));
  console.log(`Written to ${out}. Read it through before relying on it.`);
}

async function components(): Promise<void> {
  const { client, project } = await jiraClient();
  const result = await client.searchIssues(`project = ${project} ORDER BY updated DESC`, {
    maxTickets: 200,
  });

  const count = (values: string[]) => {
    const map = new Map<string, number>();
    for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
    return [...map].sort((a, b) => b[1] - a[1]);
  };

  console.log(
    `Looked at the ${result.tickets.length} most recently updated tickets of ${project}.\n`,
  );
  console.log('Components:');
  const comps = count(result.tickets.flatMap((t) => t.components ?? []));
  for (const [name, n] of comps) console.log(`  ${String(n).padStart(4)}  ${name}`);
  if (comps.length === 0) console.log('  (none are used, so rely on labels and keywords)');

  console.log('\nLabels:');
  const labels = count(result.tickets.flatMap((t) => t.labels));
  for (const [name, n] of labels.slice(0, 30)) console.log(`  ${String(n).padStart(4)}  ${name}`);
  if (labels.length === 0) console.log('  (none)');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'check':
      return check(args[0] ?? 'knowledge');
    case 'match': {
      const key = args[0];
      if (!key) throw new Error('Give a ticket key, for example SHP-4103.');
      return match(key, args[1] ?? 'knowledge');
    }
    case 'import-cases':
      return importCases(args);
    case 'components':
      return components();
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof JiraError || error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
