import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase, Repository } from '../../../src/db/index.js';
import { sampleResult } from '../db/support.js';

const run = promisify(execFile);

describe('npm run pilot, as a command', () => {
  let dir: string;
  let databaseUrl: string;
  let runId: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pilot-cli-'));
    // DATABASE_URL must parse as a URL, so no backslashes.
    databaseUrl = `pglite://${join(dir, 'db').replaceAll(String.fromCharCode(92), '/')}`;

    const db = await openDatabase(databaseUrl);
    await migrate(db);
    const repo = new Repository(db);
    const result = await sampleResult({
      keys: ['SHP-1', 'SHP-2'],
      casesFor: (key) =>
        [0, 1].map((i) => ({
          title: `Check alpha${key.slice(-1)}k${i} beta${key.slice(-1)}k${i} scenario`,
          expected: `Gamma${key.slice(-1)}k${i} delta${key.slice(-1)}k${i} holds`,
          flow_step: 'Happy path',
        })),
    });
    runId = await repo.createRun({
      mode: 'list',
      value: 'SHP-1 SHP-2',
      promptVersion: result.promptVersion,
    });
    await repo.saveResult(runId, result);
    const cases = (await repo.getRun(runId))!.cases;
    await repo.updateCase(cases[0]!.uid, { title: 'A clearer title for this case' }, 'asha');
    await repo.deleteCase(cases[1]!.uid, 'asha');
    await db.close();
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cli = (args: string[]) =>
    run(process.execPath, ['--import', 'tsx', 'src/pilot/cli.ts', ...args], {
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: databaseUrl },
      timeout: 90_000,
    }).then(
      (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
      (error: { code: number; stdout: string; stderr: string }) => ({
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      }),
    );

  it('writes the report for a run, with the baseline compared', async () => {
    const baseline = join(dir, 'baseline.csv');
    const out = join(dir, 'report.md');
    await writeFile(
      baseline,
      'ticket,manual_minutes,review_minutes,missed_cases\nSHP-1,60,20,1\nSHP-2,30,10,\nSHP-9,10,5,\n',
    );

    const result = await cli([
      'report',
      '--runs',
      runId,
      '--baseline',
      baseline,
      '--out',
      out,
      '--title',
      'CLI pilot',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Wrote');
    expect(result.stderr).toContain(
      'SHP-9 is in the baseline file but in none of the selected runs.',
    );
    const text = await readFile(out, 'utf8');
    expect(text).toContain('# CLI pilot');
    expect(text).toContain('| Time saved |');
    expect(text).toContain('on 2 tickets');
    expect(text).toContain('| SHP-1 | 2 |');
    expect(text).toContain('People recorded: asha.');
    expect(text).toContain('title (1)');
  }, 120_000);

  it('selects runs by date', async () => {
    const out = join(dir, 'by-date.md');

    const result = await cli(['report', '--since', '2020-01-01', '--out', out]);

    expect(result.code).toBe(0);
    expect(await readFile(out, 'utf8')).toContain('from 1 run and 2 tickets');
  }, 120_000);

  it('stops and names the row when the baseline file has a problem', async () => {
    const baseline = join(dir, 'bad.csv');
    await writeFile(baseline, 'ticket,manual_minutes\nSHP-1,lots\n');

    const result = await cli(['report', '--runs', runId, '--baseline', baseline]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Row 2: manual_minutes must be a number of minutes');
  }, 120_000);

  it('asks which runs, when none are named', async () => {
    const result = await cli(['report']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Say which runs to report on');
  }, 120_000);

  it('writes an empty baseline file that the report reads', async () => {
    const file = join(dir, 'template.csv');
    const made = await cli(['template', '--out', file]);
    expect(made.code).toBe(0);

    const out = join(dir, 'from-template.md');
    const result = await cli(['report', '--runs', runId, '--baseline', file, '--out', out]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('SHP-0000 is in the baseline file');
  }, 120_000);
});
