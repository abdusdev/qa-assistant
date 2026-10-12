import { migrations as defaultMigrations, type Migration } from './migrations.js';
import type { Db } from './types.js';

export interface MigrationStatus {
  applied: number[];
  pending: number[];
}

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

function assertOrdered(list: Migration[]): void {
  list.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migrations must be numbered 1, 2, 3... without gaps (found ${migration.version} at position ${index + 1}).`,
      );
    }
  });
}

async function appliedVersions(db: Db): Promise<number[]> {
  await db.exec(TABLE_SQL);
  const { rows } = await db.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return rows.map((row) => row.version);
}

export async function migrationStatus(
  db: Db,
  list: Migration[] = defaultMigrations,
): Promise<MigrationStatus> {
  assertOrdered(list);
  const applied = await appliedVersions(db);
  return {
    applied,
    pending: list.map((m) => m.version).filter((version) => !applied.includes(version)),
  };
}

/** Applies every pending migration, each in its own transaction. Safe to run again. */
export async function migrate(
  db: Db,
  list: Migration[] = defaultMigrations,
): Promise<{ applied: number[] }> {
  assertOrdered(list);
  const done = new Set(await appliedVersions(db));
  const applied: number[] = [];

  for (const migration of list) {
    if (done.has(migration.version)) continue;

    await db.transaction(async (tx) => {
      await tx.exec(migration.up);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    });
    applied.push(migration.version);
  }
  return { applied };
}

/** Undoes the most recent migrations, newest first. */
export async function rollback(
  db: Db,
  steps = 1,
  list: Migration[] = defaultMigrations,
): Promise<{ reverted: number[] }> {
  assertOrdered(list);
  const applied = await appliedVersions(db);
  const reverted: number[] = [];

  for (const version of [...applied].reverse().slice(0, Math.max(0, steps))) {
    const migration = list.find((m) => m.version === version);
    if (!migration)
      throw new Error(`Migration ${version} is applied but unknown to this version of the app.`);

    await db.transaction(async (tx) => {
      await tx.exec(migration.down);
      await tx.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
    });
    reverted.push(version);
  }
  return { reverted };
}
