import { migrate } from '../../../src/db/migrate.js';
import { openPg } from '../../../src/db/pg.js';
import { openPglite } from '../../../src/db/pglite.js';
import { Repository } from '../../../src/db/repository.js';
import type { Db } from '../../../src/db/types.js';
import type { PipelineResult } from '../../../src/pipeline/run.js';
import { runPipeline } from '../../../src/pipeline/run.js';
import { makeTicket, scriptedAI, type ScriptOptions } from '../pipeline/support.js';

export interface Backend {
  name: string;
  /** Opens a connection. Called once per test file. */
  open: () => Promise<Db>;
}

/**
 * The in-process Postgres always. A real Postgres server too, when TEST_DATABASE_URL is set
 * (CI sets it).
 */
export function backends(): Backend[] {
  const list: Backend[] = [{ name: 'in-process Postgres', open: () => openPglite() }];

  const url = process.env.TEST_DATABASE_URL;
  if (url) list.push({ name: 'Postgres server', open: async () => openPg(url) });
  return list;
}

/** Empties the database. Much faster than opening a new one for every test. */
export async function resetDatabase(db: Db): Promise<void> {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

/** A migrated, empty database and a repository on it. */
export async function openRepository(db: Db): Promise<{ db: Db; repo: Repository }> {
  await resetDatabase(db);
  await migrate(db);
  return { db, repo: new Repository(db) };
}

/** A genuine pipeline result, made by running the real pipeline against a scripted AI. */
export async function sampleResult(
  options: ScriptOptions & { keys?: string[] } = {},
): Promise<PipelineResult> {
  const keys = options.keys ?? ['SHP-1', 'SHP-2'];
  return runPipeline(
    scriptedAI({ casesPerTicket: 2, ...options }),
    keys.map((key) => makeTicket(key)),
    { pricing: { inputPerMillion: 1, outputPerMillion: 4 } },
  );
}
