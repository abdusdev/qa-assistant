/**
 * Builds the pilot report from saved runs.
 *
 *   npm run pilot -- report --since 2026-10-14 [--until 2026-10-21] [--runs id,id]
 *                           [--baseline docs/pilot/baseline-template.csv] [--out pilot-report.md]
 *                           [--title "Sprint 42 pilot"]
 *   npm run pilot -- template [--out baseline.csv]     writes an empty baseline file
 *
 * Needs DATABASE_URL. Reads the database; changes nothing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { ConfigError, loadConfig } from '../config/env.js';
import { migrate, openDatabase, Repository } from '../db/index.js';
import { parseBaseline } from './baseline.js';
import { collectPilot } from './collect.js';
import { buildReport, renderReport } from './report.js';

// One row per ticket in the pilot. The example row is harmless: it matches no run and is warned about.
const TEMPLATE =
  'ticket,manual_minutes,review_minutes,missed_cases,notes\n' +
  'SHP-0000,45,15,1,Example: the tax rule was not in the ticket\n';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      flags.set(arg.slice(2), argv[i + 1] ?? '');
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function dateFlag(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) throw new Error(`--${name} must be a date such as 2026-10-14.`);
  return date;
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command] = positional;

  if (command === 'template') {
    const out = flags.get('out') ?? 'baseline.csv';
    await writeFile(out, TEMPLATE);
    console.log(`Wrote ${out}. Fill in one row per ticket.`);
    return;
  }

  if (command !== 'report') {
    console.error(
      'Usage: npm run pilot -- report (--since <date> | --runs <id,id>) [--until <date>]\n' +
        '                              [--baseline file.csv] [--out file.md] [--title text]\n' +
        '       npm run pilot -- template [--out baseline.csv]',
    );
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  if (!config.databaseUrl) {
    console.error('Set DATABASE_URL in .env first (see .env.example).');
    process.exitCode = 1;
    return;
  }

  let baseline: ReturnType<typeof parseBaseline>['entries'] = [];
  const baselineFile = flags.get('baseline');
  if (baselineFile) {
    const parsed = parseBaseline(await readFile(baselineFile, 'utf8'));
    if (parsed.problems.length > 0) {
      for (const problem of parsed.problems) console.error(problem);
      process.exitCode = 1;
      return;
    }
    baseline = parsed.entries;
  }

  const runIds = flags
    .get('runs')
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const since = dateFlag(flags.get('since'), 'since');
  const until = dateFlag(flags.get('until'), 'until');

  const db = await openDatabase(config.databaseUrl);
  try {
    await migrate(db);
    const inputs = await collectPilot(new Repository(db), {
      ...(runIds && { runIds }),
      ...(since && { since }),
      ...(until && { until }),
    });
    const report = buildReport(inputs, baseline, {
      ...(flags.get('title') && { title: flags.get('title') as string }),
    });

    const seen = new Set(report.tickets.map((t) => t.ticket));
    const unmatched = baseline.filter((entry) => !seen.has(entry.ticket));
    for (const entry of unmatched) {
      console.warn(`${entry.ticket} is in the baseline file but in none of the selected runs.`);
    }

    const out = flags.get('out') ?? 'pilot-report.md';
    await writeFile(out, renderReport(report));
    console.log(
      `Wrote ${out}: ${report.runs.length} run(s), ${report.tickets.length} ticket(s), ` +
        `${report.totals.generated} AI case(s). Reading: ${report.recommendation}.`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else if (error instanceof Error) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
});
