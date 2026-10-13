/**
 * Exports a run as Markdown, CSV or Word.
 *
 *   npm run export -- run <run id> --format docx --out cases.docx      (needs DATABASE_URL)
 *   npm run export -- file out/pipeline-2026-10-12T14-28-14-868Z.json --format md --title "SHP-4103"
 *
 * Options: --format md|csv|docx (default md)  --out <file>  --title <text>  --author <name>
 *
 * Every export carries the "AI draft: needs QA review" notice.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { ConfigError, loadConfig } from '../config/env.js';
import { migrate, openDatabase, Repository } from '../db/index.js';
import type { PipelineResult } from '../pipeline/run.js';
import {
  EXPORT_FORMATS,
  fromPipelineResult,
  fromStoredRun,
  toCsv,
  toDocx,
  toMarkdown,
  type ExportFormat,
  type ExportRun,
} from './index.js';

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

async function render(run: ExportRun, format: ExportFormat): Promise<string | Buffer> {
  if (format === 'md') return toMarkdown(run);
  if (format === 'csv') return toCsv(run);
  return toDocx(run);
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [kind, target] = positional;
  const format = (flags.get('format') ?? 'md') as ExportFormat;

  if (!kind || !target || !['run', 'file'].includes(kind) || !EXPORT_FORMATS.includes(format)) {
    console.error(
      'Usage: npm run export -- run <run id> [--format md|csv|docx] [--out file] [--title text] [--author name]\n' +
        '       npm run export -- file <pipeline-result.json> [--format md|csv|docx] [--out file] [--title text]',
    );
    process.exitCode = 1;
    return;
  }

  const author = flags.get('author');
  let run: ExportRun;

  if (kind === 'file') {
    const result = JSON.parse(await readFile(target, 'utf8')) as PipelineResult;
    run = fromPipelineResult(result, {
      title: flags.get('title') ?? 'Test cases',
      source: target,
      ...(author && { author }),
    });
  } else {
    const config = loadConfig();
    if (!config.databaseUrl) {
      console.error('Set DATABASE_URL in .env to export a saved run.');
      process.exitCode = 1;
      return;
    }
    const db = await openDatabase(config.databaseUrl);
    try {
      await migrate(db);
      const stored = await new Repository(db).getRun(target);
      if (!stored) {
        console.error(`There is no run with the id ${target}.`);
        process.exitCode = 1;
        return;
      }
      run = fromStoredRun(stored, {
        title: flags.get('title') ?? `Test cases for ${stored.inputValue}`,
        ...(author && { author }),
      });
    } finally {
      await db.close();
    }
  }

  const out = flags.get('out') ?? `test-cases.${format}`;
  await writeFile(out, await render(run, format));
  const live = run.cases.filter((c) => c.state !== 'deleted').length;
  console.log(`Wrote ${out} (${live} case(s), ${format}).`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
});
