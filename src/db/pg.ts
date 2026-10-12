import pg from 'pg';
import type { Db, QueryResult } from './types.js';

type Runner = Pick<pg.Pool | pg.PoolClient, 'query'>;

function wrap(runner: Runner, pool?: pg.Pool): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await runner.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await runner.query(sql);
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
      if (!pool) return fn(wrap(runner)); // already inside a transaction

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool?.end();
    },
  };
}

/** Connects to a Postgres server. */
export function openPg(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return wrap(pool, pool);
}
