import { describe, expect, it } from 'vitest';
import { createProvider, FakeAIProvider, GeminiProvider } from '../../../src/ai/index.js';

describe('createProvider', () => {
  it('returns the fake provider for AI_PROVIDER=fake', async () => {
    const provider = createProvider({ provider: 'fake', maxOutputTokens: 8192 });

    expect(provider).toBeInstanceOf(FakeAIProvider);
    expect((await provider.generate({ prompt: 'anything' })).text).toBe('{}');
  });

  it('returns the Gemini provider when the key and model are set', () => {
    const provider = createProvider({
      provider: 'gemini',
      apiKey: 'key',
      model: 'some-model',
      maxOutputTokens: 4096,
    });

    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.name).toBe('gemini');
  });

  it.each([
    ['no key', { provider: 'gemini' as const, model: 'm', maxOutputTokens: 8192 }],
    ['no model', { provider: 'gemini' as const, apiKey: 'k', maxOutputTokens: 8192 }],
  ])('refuses Gemini with %s', (_label, config) => {
    expect(() => createProvider(config)).toThrow(/AI_API_KEY and AI_MODEL/);
  });
});
