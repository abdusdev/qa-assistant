/**
 * Database commands.
 *   npm run db -- migrate        create or update the tables (safe to run again)
 *   npm run db -- status         which migrations are applied and pending
 *   npm run db -- rollback [n]   undo the last n migrations (default 1)
 *   npm run db -- purge [days]   delete runs and cached results older than the retention
 *   npm run db -- runs           the latest runs
 */
import { ConfigError, loadConfig } from '../config/env.js';
import { migrate, migrationStatus, rollback } from './migrate.js';
import { openDatabase } from './open.js';
import { Repository } from './repository.js';

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  const config = loadConfig();

  if (!command || !['migrate', 'status', 'rollback', 'purge', 'runs'].includes(command)) {
    console.error('Usage: npm run db -- <migrate | status | rollback [n] | purge [days] | runs>');
    process.exitCode = 1;
    return;
  }
  if (!config.databaseUrl) {
    console.error('Set DATABASE_URL in .env first (see .env.example).');
    process.exitCode = 1;
    return;
  }

  const db = await openDatabase(config.databaseUrl);
  try {
    if (command === 'migrate') {
      const { applied } = await migrate(db);
      console.log(
        applied.length > 0 ? `Applied migrations: ${applied.join(', ')}` : 'Already up to date.',
      );
    } else if (command === 'status') {
      const status = await migrationStatus(db);
      console.log(`Applied: ${status.applied.join(', ') || 'none'}`);
      console.log(`Pending: ${status.pending.join(', ') || 'none'}`);
    } else if (command === 'rollback') {
      const steps = argument ? Number(argument) : 1;
      const { reverted } = await rollback(db, steps);
      console.log(
        reverted.length > 0 ? `Reverted migrations: ${reverted.join(', ')}` : 'Nothing to revert.',
      );
    } else if (command === 'purge') {
      const days = argument ? Number(argument) : config.databaseRetentionDays;
      const result = await new Repository(db).purgeOlderThan(days);
      console.log(
        `Deleted ${result.runs} run(s) and ${result.cacheEntries} cached result(s) older than ${days} days.`,
      );
    } else {
      for (const run of await new Repository(db).listRuns(20)) {
        console.log(
          `${run.createdAt.toISOString()}  ${run.status.padEnd(10)} ${String(run.caseCount).padStart(3)} cases  ` +
            `${run.inputMode} ${run.inputValue.slice(0, 40)}  ${run.id}`,
        );
      }
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
});
