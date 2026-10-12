import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Db, QueryResult } from './types.js';

type Queryable = Pick<PGlite, 'query' | 'exec'>;

function wrap(client: Queryable, owner?: PGlite): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await client.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await client.exec(sql);
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      if (!owner) {
        // Already inside a transaction: PGlite does not nest, so join the outer one.
        return fn(wrap(client));
      }
      return owner.transaction((tx) => fn(wrap(tx)));
    },
    async close(): Promise<void> {
      await owner?.close();
    },
  };
}

/**
 * A real Postgres running inside this process. With no folder it lives in memory (used by
 * tests, so they need no database server); with a folder it is saved there between runs.
 */
export async function openPglite(dataDir?: string): Promise<Db> {
  // PGlite does not create parent folders, so a path like ./.data/db would otherwise fail.
  if (dataDir) await mkdir(path.resolve(dataDir), { recursive: true });
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.waitReady;
  return wrap(client, client);
}
