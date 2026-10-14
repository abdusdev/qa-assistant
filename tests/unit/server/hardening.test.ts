import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager } from '../../../src/jobs/manager.js';
import type { JobRunner } from '../../../src/jobs/types.js';
import { createApp } from '../../../src/server/app.js';
import { REMOVED, createLogger, scrubText, scrubValue } from '../../../src/server/logger.js';
import { rateLimit } from '../../../src/server/rate-limit.js';
import { CONTENT_SECURITY_POLICY } from '../../../src/server/security.js';

const GITHUB_TOKEN = 'ghp_' + 'a'.repeat(36);

/** A logger that keeps its lines, so a test can read what was written. */
function captured(level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      done();
    },
  });
  return { logger: createLogger({ level, destination }), lines, text: () => lines.join('\n') };
}

describe('scrubbing what is logged', () => {
  it('removes the value of anything named like a credential, in any letter case', () => {
    const clean = scrubValue({
      Authorization: 'Bearer abc',
      apiToken: 'x',
      nested: { Password: 'hunter2', ok: 'fine' },
      list: [{ 'x-goog-api-key': 'k' }],
    });

    expect(clean).toEqual({
      Authorization: REMOVED,
      apiToken: REMOVED,
      nested: { Password: REMOVED, ok: 'fine' },
      list: [{ 'x-goog-api-key': REMOVED }],
    });
  });

  it('removes ticket and case text, whatever the field is nested in', () => {
    const clean = scrubValue({
      ticket: 'SHP-1',
      description: 'The seller cannot ship orders',
      comments: [{ body: 'a comment' }],
      result: { cases: [{ id: 'TC-1', steps: ['Open it'], expected: 'It opens' }] },
    }) as { ticket: string; description: string; result: { cases: Record<string, unknown>[] } };

    expect(clean.ticket).toBe('SHP-1');
    expect(clean.description).toBe(REMOVED);
    expect(clean.result.cases[0]).toEqual({ id: 'TC-1', steps: REMOVED, expected: REMOVED });
    expect(JSON.stringify(clean)).not.toContain('cannot ship');
  });

  it('scrubs token-shaped text inside strings and errors', () => {
    expect(scrubText(`failed with ${GITHUB_TOKEN} in the header`)).not.toContain(GITHUB_TOKEN);

    const clean = scrubValue(new Error(`bad token ${GITHUB_TOKEN}`)) as {
      type: string;
      message: string;
    };
    expect(clean.type).toBe('Error');
    expect(clean.message).not.toContain(GITHUB_TOKEN);
  });

  it('stops at a sensible depth and length', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    expect(JSON.stringify(scrubValue(deep))).toContain('[too deep]');
    expect((scrubValue(Array.from({ length: 500 }, (_, i) => i)) as number[]).length).toBe(50);
  });
});

describe('the logger', () => {
  it('writes one JSON line per event with the time and the level', () => {
    const { logger, lines } = captured();

    logger.info({ port: 3000 }, 'listening');

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({ msg: 'listening', port: 3000, level: 30 });
    expect(entry.time).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  it('never writes a token, a header value or ticket text', () => {
    const { logger, text } = captured();

    logger.info(
      {
        headers: { authorization: `Bearer ${GITHUB_TOKEN}` },
        ticket: 'SHP-4103',
        description: 'When the user changes the address the rates stay',
        err: new Error(`Jira said no for ${GITHUB_TOKEN}`),
      },
      `calling with ${GITHUB_TOKEN}`,
    );

    const written = text();
    expect(written).not.toContain(GITHUB_TOKEN);
    expect(written).not.toContain('rates stay');
    expect(written).toContain('SHP-4103');
  });

  it('does not write below its level', () => {
    const { logger, lines } = captured('warn');

    logger.info('quiet');
    logger.warn('loud');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('loud');
  });
});

describe('rateLimit', () => {
  async function serve(options: Parameters<typeof rateLimit>[0]) {
    const app = express();
    app.use(rateLimit(options));
    app.get('/', (_req, res) => {
      res.json({ ok: true });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      get: (headers: Record<string, string> = {}) => fetch(base, { headers }),
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('lets the allowed number through and then answers 429 with a wait time', async () => {
    const limited = await serve({ windowMs: 60_000, max: 2 });
    try {
      const first = await limited.get();
      const second = await limited.get();
      const third = await limited.get();

      expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
      expect(first.headers.get('ratelimit-limit')).toBe('2');
      expect(first.headers.get('ratelimit-remaining')).toBe('1');
      expect(third.headers.get('ratelimit-remaining')).toBe('0');
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await third.json()).toMatchObject({ error: { code: 'rate_limited' } });
    } finally {
      await limited.close();
    }
  });

  it('counts each client separately', async () => {
    const limited = await serve({ windowMs: 60_000, max: 1 });
    try {
      const a1 = await limited.get({ authorization: 'Bearer token-a' });
      const a2 = await limited.get({ authorization: 'Bearer token-a' });
      const b1 = await limited.get({ authorization: 'Bearer token-b' });

      expect([a1.status, a2.status, b1.status]).toEqual([200, 429, 200]);
    } finally {
      await limited.close();
    }
  });

  it('starts counting again when the window is over', async () => {
    let now = 1_000;
    const limited = await serve({ windowMs: 10_000, max: 1, now: () => now });
    try {
      expect((await limited.get()).status).toBe(200);
      expect((await limited.get()).status).toBe(429);

      now += 10_001;

      expect((await limited.get()).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('the app with its protections', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  const runner: JobRunner = async () => ({
    result: {
      cases: [],
      flow: { steps: [] },
      flowSource: 'none',
      tickets: [],
      warnings: [],
      grounding: { grounded: 0, partly: 0, assumed: 0 },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      calls: 0,
      durationMs: 1,
      promptVersion: 'test',
    },
    cancelled: false,
  });

  async function start(
    options: {
      apiToken?: string;
      limits?: { perMinute: number; generatePerMinute: number };
      ready?: () => Promise<unknown>;
      hsts?: boolean;
      logger?: ReturnType<typeof createLogger>;
    } = {},
  ) {
    const jobs = new JobManager(runner);
    const app = createApp(
      {
        jobs,
        ...(options.apiToken && { apiToken: options.apiToken }),
        ...(options.limits && { limits: options.limits }),
        ...(options.ready && { ready: options.ready }),
      },
      { hsts: options.hsts ?? false, ...(options.logger && { logger: options.logger }) },
    );
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    close = async () => {
      await jobs.whenIdle();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      get: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers }),
      post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
    };
  }

  describe('security headers', () => {
    it('sends them on the health check and on API answers', async () => {
      const app = await start();

      for (const path of ['/health', '/api/jobs']) {
        const response = await app.get(path);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('x-frame-options')).toBe('DENY');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
      }
      expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
      expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    });

    it('sends Strict-Transport-Security only when asked to', async () => {
      const off = await start({ hsts: false });
      const without = await off.get('/health');
      await close?.();

      const on = await start({ hsts: true });
      const withHsts = await on.get('/health');

      expect(without.headers.get('strict-transport-security')).toBeNull();
      expect(withHsts.headers.get('strict-transport-security')).toContain('max-age=');
    });

    it('stops a browser or proxy from keeping API answers', async () => {
      const app = await start();

      expect((await app.get('/api/jobs')).headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('readiness', () => {
    it('is ready when what it needs answers', async () => {
      const app = await start({ ready: async () => 1 });

      const response = await app.get('/ready');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ready' });
    });

    it('is unavailable, without saying why, when it does not', async () => {
      const app = await start({
        ready: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
        },
      });

      const response = await app.get('/ready');

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'unavailable' });
    });
  });

  describe('the session check', () => {
    it('says no token is needed when none is set', async () => {
      const app = await start();

      const response = await app.get('/api/session', { 'x-user': 'Tech' });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authRequired: false, user: 'Tech' });
    });

    it('answers 401 without the token, and 200 with it', async () => {
      const app = await start({ apiToken: 'a-long-enough-token' });

      const without = await app.get('/api/session');
      const wrong = await app.get('/api/session', { authorization: 'Bearer nope-nope-nope' });
      const right = await app.get('/api/session', {
        authorization: 'Bearer a-long-enough-token',
      });

      expect([without.status, wrong.status, right.status]).toEqual([401, 401, 200]);
      expect(await right.json()).toEqual({ authRequired: true, user: 'qa' });
    });
  });

  describe('limits', () => {
    it('refuses a client that reads too often', async () => {
      const app = await start({ limits: { perMinute: 3, generatePerMinute: 100 } });

      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await app.get('/api/jobs')).status);

      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    });

    it('limits starting runs more tightly than reading', async () => {
      const app = await start({ limits: { perMinute: 100, generatePerMinute: 2 } });
      const body = { mode: 'ticket', value: 'SHP-1' };

      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await app.post('/api/generate', body)).status);
      const read = await app.get('/api/jobs');

      expect(statuses).toEqual([202, 202, 429, 429]);
      expect(read.status).toBe(200);
    });

    it('answers in the same error shape as the rest of the API', async () => {
      const app = await start({ limits: { perMinute: 1, generatePerMinute: 1 } });
      await app.get('/api/jobs');

      const response = await app.get('/api/jobs');

      expect(response.status).toBe(429);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('rate_limited');
      expect(body.error.message).toContain('Try again');
    });

    it('has no limit when none is configured', async () => {
      const app = await start();

      const statuses = [];
      for (let i = 0; i < 10; i++) statuses.push((await app.get('/api/jobs')).status);

      expect(new Set(statuses)).toEqual(new Set([200]));
    });
  });

  describe('the request log', () => {
    it('records the method, path, status and time, and nothing from the request', async () => {
      const { logger, lines, text } = captured();
      const app = await start({ logger });

      await app.post(
        '/api/generate?secret=ghp_' + 'b'.repeat(36),
        { mode: 'list', value: 'SHP-1 and the text of a ticket that must not be logged' },
        { authorization: `Bearer ${GITHUB_TOKEN}` },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(lines.length).toBeGreaterThan(0);
      const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
      expect(entry).toMatchObject({ method: 'POST', path: '/api/generate', status: 202 });
      expect(typeof entry.ms).toBe('number');
      expect(text()).not.toContain('must not be logged');
      expect(text()).not.toContain(GITHUB_TOKEN);
      expect(text()).not.toContain('bbbbbbbb');
    });

    it('does not log the health check, and logs a refusal as a warning', async () => {
      const { logger, lines } = captured();
      const app = await start({ logger, apiToken: 'a-long-enough-token' });

      await app.get('/health');
      await app.get('/api/jobs');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toMatchObject({ status: 401, level: 40 });
    });
  });
});
