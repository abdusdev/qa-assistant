/** The few database operations the app needs. Postgres and the in-process test database both fit. */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs several statements, without parameters. Used for migrations. */
  exec(sql: string): Promise<void>;
  /** Runs the function in one transaction: all of it is saved, or none of it. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
