import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../src/server/app.js';

describe('createApp', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(): Promise<string> {
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('answers the health check', async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('does not reveal the framework in headers', async () => {
    const base = await start();
    const response = await fetch(`${base}/health`);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });
});
