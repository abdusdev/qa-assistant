import { describe, expect, it } from 'vitest';
import { AIError } from '../../../src/ai/errors.js';
import { FakeAIProvider } from '../../../src/ai/fake.js';
import { UsageTracker } from '../../../src/ai/types.js';

describe('FakeAIProvider', () => {
  it('returns its prepared replies in order', async () => {
    const ai = new FakeAIProvider({ replies: ['first', 'second'] });

    expect((await ai.generate({ prompt: 'a' })).text).toBe('first');
    expect((await ai.generate({ prompt: 'b' })).text).toBe('second');
  });

  it('records every request it receives', async () => {
    const ai = new FakeAIProvider({ fallback: 'ok' });

    await ai.generate({ system: 'be brief', prompt: 'ticket text', json: true });

    expect(ai.calls).toEqual([{ system: 'be brief', prompt: 'ticket text', json: true }]);
  });

  it('can compute a reply from the request', async () => {
    const ai = new FakeAIProvider({
      replies: [(request) => JSON.stringify({ echo: request.prompt })],
    });

    const response = await ai.generate({ prompt: 'SHP-1' });

    expect(JSON.parse(response.text)).toEqual({ echo: 'SHP-1' });
  });

  it('throws a prepared error', async () => {
    const ai = new FakeAIProvider({
      replies: [new AIError('rate_limited', 'slow down'), 'recovered'],
    });

    await expect(ai.generate({ prompt: 'a' })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect((await ai.generate({ prompt: 'a' })).text).toBe('recovered');
  });

  it('uses the fallback once the replies run out', async () => {
    const ai = new FakeAIProvider({ replies: ['one'], fallback: 'always' });

    await ai.generate({ prompt: 'a' });

    expect((await ai.generate({ prompt: 'a' })).text).toBe('always');
    expect((await ai.generate({ prompt: 'a' })).text).toBe('always');
  });

  it('fails clearly when it runs out of replies and has no fallback', async () => {
    const ai = new FakeAIProvider({ replies: ['only one'] });
    await ai.generate({ prompt: 'a' });

    await expect(ai.generate({ prompt: 'a' })).rejects.toThrow(/no more prepared replies/);
  });

  it('reports token usage and never claims truncation', async () => {
    const ai = new FakeAIProvider({ fallback: 'x'.repeat(40) });

    const response = await ai.generate({ system: 'y'.repeat(20), prompt: 'z'.repeat(20) });

    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 10, totalTokens: 20 });
    expect(response.truncated).toBe(false);
    expect(response.model).toBe('fake');
  });

  it('can simulate a slow answer', async () => {
    const ai = new FakeAIProvider({ fallback: 'late', delayMs: 20 });
    const started = Date.now();

    await ai.generate({ prompt: 'a' });

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe('UsageTracker', () => {
  it('adds up usage over several calls', () => {
    const tracker = new UsageTracker();

    tracker.add({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    tracker.add({ inputTokens: 50, outputTokens: 10, totalTokens: 60 });

    expect(tracker.total).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });
    expect(tracker.calls).toBe(2);
  });

  it('starts at zero and hands out copies', () => {
    const tracker = new UsageTracker();
    expect(tracker.total).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

    tracker.total.totalTokens = 999;

    expect(tracker.total.totalTokens).toBe(0);
  });
});
