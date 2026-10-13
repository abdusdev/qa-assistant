import { describe, expect, it } from 'vitest';
import {
  createProvider,
  DemoAIProvider,
  FallbackProvider,
  GeminiProvider,
  type ModelSwitch,
} from '../../../src/ai/index.js';

describe('createProvider', () => {
  it('returns the offline demo provider for AI_PROVIDER=fake', async () => {
    const provider = createProvider({
      provider: 'fake',
      maxOutputTokens: 8192,
      fallbackModels: [],
    });

    expect(provider).toBeInstanceOf(DemoAIProvider);
    expect(provider.name).toBe('fake');
    expect(JSON.parse((await provider.generate({ prompt: 'anything' })).text)).toHaveProperty(
      'steps',
    );
  });

  it('returns the Gemini provider when the key and model are set', () => {
    const provider = createProvider({
      provider: 'gemini',
      apiKey: 'key',
      model: 'some-model',
      maxOutputTokens: 4096,
      fallbackModels: [],
    });

    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.name).toBe('gemini');
  });

  it('returns a provider that switches models when fallback models are configured', () => {
    const provider = createProvider({
      provider: 'gemini',
      apiKey: 'key',
      model: 'model-a',
      maxOutputTokens: 4096,
      fallbackModels: ['model-b', 'model-c'],
    });

    expect(provider).toBeInstanceOf(FallbackProvider);
    expect((provider as FallbackProvider).currentModel).toBe('model-a');
  });

  it('ignores a fallback model that repeats the main model', () => {
    const provider = createProvider({
      provider: 'gemini',
      apiKey: 'key',
      model: 'model-a',
      maxOutputTokens: 4096,
      fallbackModels: ['model-a'],
    });

    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it('hands the switch listener to the fallback provider', async () => {
    const events: ModelSwitch[] = [];
    const provider = createProvider(
      {
        provider: 'gemini',
        apiKey: 'key',
        model: 'model-a',
        maxOutputTokens: 4096,
        fallbackModels: ['model-b'],
      },
      { onSwitch: (event) => events.push(event) },
    );

    expect(provider).toBeInstanceOf(FallbackProvider);
    expect(events).toEqual([]);
  });

  it.each([
    [
      'no key',
      { provider: 'gemini' as const, model: 'm', maxOutputTokens: 8192, fallbackModels: [] },
    ],
    [
      'no model',
      { provider: 'gemini' as const, apiKey: 'k', maxOutputTokens: 8192, fallbackModels: [] },
    ],
  ])('refuses Gemini with %s', (_label, config) => {
    expect(() => createProvider(config)).toThrow(/AI_API_KEY and AI_MODEL/);
  });
});
