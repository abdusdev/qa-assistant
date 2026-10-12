import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { openDatabase } from '../../../src/db/open.js';
import { Repository } from '../../../src/db/repository.js';

describe('openDatabase', () => {
  let folder: string | undefined;
  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
    folder = undefined;
  });

  it('keeps a pglite:// database in its folder between opens', { timeout: 60_000 }, async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'qa-assistant-db-'));
    const url = `pglite://${folder.replace(/\\/g, '/')}`;

    const first = await openDatabase(url);
    await migrate(first);
    const runId = await new Repository(first).createRun({
      mode: 'ticket',
      value: 'SHP-1',
      promptVersion: 'v2',
    });
    await first.close();

    const second = await openDatabase(url);
    const run = await new Repository(second).getRun(runId);
    await second.close();

    expect(run).toMatchObject({ id: runId, inputValue: 'SHP-1', status: 'running' });
  });

  it('creates the missing parent folders of a relative path', { timeout: 60_000 }, async () => {
    folder = path.resolve('.data', `test-${Date.now()}`, 'nested');

    const db = await openDatabase(`pglite://./.data/${path.basename(path.dirname(folder))}/nested`);
    await migrate(db);
    await db.close();

    const reopened = await openDatabase(`pglite://${folder.split(path.sep).join('/')}`);
    expect(await new Repository(reopened).listRuns()).toEqual([]);
    await reopened.close();
    folder = path.dirname(folder);
  });

  it('asks for a folder when the pglite:// url has none', async () => {
    await expect(openDatabase('pglite://')).rejects.toThrow(/needs a folder/);
  });
});
