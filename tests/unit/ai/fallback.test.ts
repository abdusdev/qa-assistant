import { describe, expect, it, vi } from 'vitest';
import { AIError } from '../../../src/ai/errors.js';
import { FallbackProvider, type ModelSwitch } from '../../../src/ai/fallback.js';
import type { AIProvider, AIRequest, AIResponse } from '../../../src/ai/types.js';

const HOUR = 3_600_000;

function model(label: string, behaviour: () => AIResponse | Error) {
  const generate = vi.fn(async (_request: AIRequest): Promise<AIResponse> => {
    const result = behaviour();
    if (result instanceof Error) throw result;
    return result;
  });
  const provider: AIProvider = { name: 'gemini', generate };
  return { label, provider, generate };
}

const answer = (text: string, modelName: string): AIResponse => ({
  text,
  model: modelName,
  truncated: false,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

const quota = (retryAfterMs?: number) =>
  new AIError('quota_exhausted', 'The daily request limit has been reached.', 429, retryAfterMs);

describe('FallbackProvider', () => {
  it('uses the first model while it works', async () => {
    const a = model('model-a', () => answer('from a', 'model-a'));
    const b = model('model-b', () => answer('from b', 'model-b'));
    const provider = new FallbackProvider([a, b]);

    const response = await provider.generate({ prompt: 'q' });

    expect(response.text).toBe('from a');
    expect(b.generate).not.toHaveBeenCalled();
    expect(provider.switches).toEqual([]);
  });

  it('switches to the next model when the first has used its daily limit', async () => {
    const a = model('model-a', () => quota(10 * HOUR));
    const b = model('model-b', () => answer('from b', 'model-b'));
    const provider = new FallbackProvider([a, b]);

    const response = await provider.generate({ prompt: 'q' });

    expect(response).toMatchObject({ text: 'from b', model: 'model-b' });
    expect(a.generate).toHaveBeenCalledTimes(1);
  });

  it('remembers an exhausted model and does not try it again', async () => {
    const a = model('model-a', () => quota(10 * HOUR));
    const b = model('model-b', () => answer('from b', 'model-b'));
    const provider = new FallbackProvider([a, b]);

    await provider.generate({ prompt: 'one' });
    await provider.generate({ prompt: 'two' });
    await provider.generate({ prompt: 'three' });

    expect(a.generate).toHaveBeenCalledTimes(1);
    expect(b.generate).toHaveBeenCalledTimes(3);
    expect(provider.currentModel).toBe('model-b');
  });

  it('reports each switch once, naming both models', async () => {
    const events: ModelSwitch[] = [];
    const a = model('model-a', () => quota(10 * HOUR));
    const b = model('model-b', () => answer('from b', 'model-b'));
    const provider = new FallbackProvider([a, b], { onSwitch: (e) => events.push(e) });

    await provider.generate({ prompt: 'one' });
    await provider.generate({ prompt: 'two' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: 'model-a', to: 'model-b' });
    expect(events[0]?.reason).toContain('daily request limit');
    expect(provider.switches).toEqual(events);
  });

  it('reports a switch once even when parallel calls fail together', async () => {
    const events: ModelSwitch[] = [];
    const a = model('model-a', () => quota(10 * HOUR));
    const b = model('model-b', () => answer('from b', 'model-b'));
    const provider = new FallbackProvider([a, b], { onSwitch: (e) => events.push(e) });

    const results = await Promise.all(
      ['1', '2', '3'].map((prompt) => provider.generate({ prompt })),
    );

    expect(results.every((r) => r.text === 'from b')).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('walks through several models in order', async () => {
    const a = model('model-a', () => quota(10 * HOUR));
    const b = model('model-b', () => quota(10 * HOUR));
    const c = model('model-c', () => answer('from c', 'model-c'));
    const provider = new FallbackProvider([a, b, c]);

    const response = await provider.generate({ prompt: 'q' });

    expect(response.text).toBe('from c');
    expect(provider.switches.map((s) => [s.from, s.to])).toEqual([
      ['model-a', 'model-b'],
      ['model-b', 'model-c'],
    ]);
  });

  it('goes back to the first model after its reset time', async () => {
    let now = 1_000_000;
    let aExhausted = true;
    const a = model('model-a', () => (aExhausted ? quota(2 * HOUR) : answer('from a', 'model-a')));
    const b = model('model-b', () => answer('from b', 'model-b'));
    const provider = new FallbackProvider([a, b], { now: () => now });

    expect((await provider.generate({ prompt: 'q' })).text).toBe('from b');

    now += HOUR; // not yet reset
    expect((await provider.generate({ prompt: 'q' })).text).toBe('from b');

    now += 2 * HOUR; // past the reset
    aExhausted = false;
    expect((await provider.generate({ prompt: 'q' })).text).toBe('from a');
    expect(provider.currentModel).toBe('model-a');
  });

  it('skips a model for a default time when the provider gives no reset time', async () => {
    let now = 0;
    const a = model('model-a', () => quota());
    const b = model('model-b', () => answer('from b', 'model-b'));
    const provider = new FallbackProvider([a, b], { now: () => now, defaultCooldownMs: HOUR });

    await provider.generate({ prompt: 'q' });
    now += HOUR / 2;
    await provider.generate({ prompt: 'q' });
    expect(a.generate).toHaveBeenCalledTimes(1);

    now += HOUR;
    await provider.generate({ prompt: 'q' });
    expect(a.generate).toHaveBeenCalledTimes(2);
  });

  it('fails clearly when every model is out, naming them and the wait', async () => {
    const a = model('model-a', () => quota(5 * HOUR));
    const b = model('model-b', () => quota(3 * HOUR));
    const provider = new FallbackProvider([a, b], { now: () => 0 });

    const error = await provider.generate({ prompt: 'q' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AIError);
    expect(error).toMatchObject({ kind: 'quota_exhausted', retryAfterMs: 3 * HOUR });
    expect((error as Error).message).toContain('model-a');
    expect((error as Error).message).toContain('model-b');
  });

  it('does not call a model again while every model is out', async () => {
    const a = model('model-a', () => quota(5 * HOUR));
    const provider = new FallbackProvider([a], { now: () => 0 });

    await provider.generate({ prompt: 'q' }).catch(() => undefined);
    await provider.generate({ prompt: 'q' }).catch(() => undefined);

    expect(a.generate).toHaveBeenCalledTimes(1);
  });

  it.each(['unauthorized', 'server_error', 'rate_limited', 'network', 'invalid_request'] as const)(
    'does not switch models for a %s error',
    async (kind) => {
      const a = model('model-a', () => new AIError(kind, 'failed'));
      const b = model('model-b', () => answer('from b', 'model-b'));
      const provider = new FallbackProvider([a, b]);

      await expect(provider.generate({ prompt: 'q' })).rejects.toMatchObject({ kind });
      expect(b.generate).not.toHaveBeenCalled();
      expect(provider.currentModel).toBe('model-a');
    },
  );

  it('is not broken by a switch listener that throws', async () => {
    const a = model('model-a', () => quota(HOUR));
    const b = model('model-b', () => answer('from b', 'model-b'));
    const provider = new FallbackProvider([a, b], {
      onSwitch: () => {
        throw new Error('listener bug');
      },
    });

    expect((await provider.generate({ prompt: 'q' })).text).toBe('from b');
  });

  it('needs at least one model', () => {
    expect(() => new FallbackProvider([])).toThrow(/At least one model/);
  });

  it('names itself after the main provider', () => {
    const a = model('model-a', () => answer('x', 'model-a'));
    expect(new FallbackProvider([a]).name).toBe('gemini');
  });
});
