import { openPg } from './pg.js';
import { openPglite } from './pglite.js';
import type { Db } from './types.js';

const PGLITE_PREFIX = 'pglite://';

/**
 * Opens the database named by DATABASE_URL.
 * - postgres://user:pass@host:5432/name  a Postgres server
 * - pglite://./.data/qa-assistant        a Postgres kept in a local folder, no server to install
 * - pglite://memory                      a Postgres in memory, gone when the process ends
 */
export async function openDatabase(url: string): Promise<Db> {
  if (url.startsWith(PGLITE_PREFIX)) {
    const folder = url.slice(PGLITE_PREFIX.length);
    if (folder === '')
      throw new Error('A pglite:// database needs a folder, for example pglite://./.data/db');
    return folder === 'memory' ? openPglite() : openPglite(folder);
  }
  return openPg(url);
}
