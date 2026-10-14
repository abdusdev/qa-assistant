import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIError } from '../../../src/ai/errors.js';
import { OpenAIFamilyProvider, type OpenAIFamilyName } from '../../../src/ai/openai.js';
import { createProvider, FallbackProvider } from '../../../src/ai/index.js';

const KEY = 'sk-secret-key-value-123456';
const MODEL = 'test-model-1';

const answer = (
  text: string,
  extras: {
    status?: string;
    incompleteReason?: string;
    usage?: Record<string, number>;
    model?: string;
  } = {},
) => ({
  id: 'resp_1',
  status: extras.status ?? 'completed',
  ...(extras.incompleteReason && { incomplete_details: { reason: extras.incompleteReason } }),
  model: extras.model ?? MODEL,
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  ],
  usage: extras.usage ?? { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const apiError = (status: number, message: string, extras: Record<string, string> = {}) =>
  json({ error: { message, type: 'error', ...extras } }, { status });

async function rejection(promise: Promise<unknown>): Promise<AIError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof AIError)) throw new Error('Expected an AIError');
  return outcome;
}

describe.each<[OpenAIFamilyName, string]>([
  ['openai', 'https://api.openai.com/v1/responses'],
  ['grok', 'https://api.x.ai/v1/responses'],
])('OpenAIFamilyProvider (%s)', (name, endpoint) => {
  const fetchMock = vi.fn<typeof fetch>();
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

  const makeProvider = (config: { maxOutputTokens?: number; model?: string } = {}) =>
    new OpenAIFamilyProvider(
      { name, apiKey: KEY, model: MODEL, ...config },
      { fetch: fetchMock, sleep },
    );

  const requestBody = (call = 0) =>
    JSON.parse(String(fetchMock.mock.calls[call]![1]?.body)) as Record<string, unknown>;

  beforeEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
  });

  describe('request', () => {
    it('posts to the responses endpoint with the key as a bearer token, not in the URL', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('hello')));

      await makeProvider().generate({ prompt: 'Say hello' });

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(endpoint);
      expect(String(url)).not.toContain(KEY);
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      expect(init?.method).toBe('POST');
    });

    it('sends the system text and the prompt as separate messages, and the model', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('ok')));

      await makeProvider().generate({ system: 'Be brief.', prompt: 'Hello' });

      expect(requestBody()).toMatchObject({
        model: MODEL,
        input: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello' },
        ],
      });
    });

    it('leaves the system message out when there is none', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('ok')));

      await makeProvider().generate({ prompt: 'Hello' });

      expect(requestBody().input).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('asks the provider not to keep the ticket text', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('ok')));

      await makeProvider().generate({ prompt: 'Hello' });

      expect(requestBody().store).toBe(false);
    });

    it('caps the output at the configured limit even when the request asks for more', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('ok')));

      await makeProvider({ maxOutputTokens: 1000 }).generate({
        prompt: 'x',
        maxOutputTokens: 50_000,
      });

      expect(requestBody().max_output_tokens).toBe(1000);
    });

    it('sends the temperature when one is given', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('ok')));

      await makeProvider().generate({ prompt: 'x', temperature: 0.2 });

      expect(requestBody().temperature).toBe(0.2);
    });

    it('rejects an empty prompt without a call', async () => {
      const error = await rejection(makeProvider().generate({ prompt: '   ' }));

      expect(error.kind).toBe('invalid_request');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a model id that is not shaped like one', () => {
      expect(
        () =>
          new OpenAIFamilyProvider(
            { name, apiKey: KEY, model: 'bad model; rm' },
            { fetch: fetchMock },
          ),
      ).toThrow(AIError);
    });
  });

  describe('response', () => {
    it('returns the answer text, the token usage and the model', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('{"a":1}', { model: 'served-model' })));

      const result = await makeProvider().generate({ prompt: 'x' });

      expect(result).toEqual({
        text: '{"a":1}',
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        model: 'served-model',
        truncated: false,
      });
    });

    it('joins several text parts and ignores reasoning items', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          status: 'completed',
          output: [
            { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
            {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Hello ' },
                { type: 'output_text', text: 'world' },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
      );

      const result = await makeProvider().generate({ prompt: 'x' });

      expect(result.text).toBe('Hello world');
      expect(result.usage.totalTokens).toBe(3);
    });

    it('does not return text that sits inside a reasoning item', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          status: 'completed',
          output: [
            { type: 'reasoning', content: [{ type: 'output_text', text: 'PRIVATE THINKING' }] },
            { type: 'message', content: [{ type: 'output_text', text: 'the answer' }] },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );

      const result = await makeProvider().generate({ prompt: 'x' });

      expect(result.text).toBe('the answer');
    });

    it('marks an answer cut off by the output limit as truncated', async () => {
      fetchMock.mockResolvedValueOnce(
        json(answer('{"a":', { status: 'incomplete', incompleteReason: 'max_output_tokens' })),
      );

      const result = await makeProvider().generate({ prompt: 'x' });

      expect(result.truncated).toBe(true);
      expect(result.text).toBe('{"a":');
    });

    it('returns a truncated answer with no text instead of failing', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [{ type: 'reasoning', summary: [] }],
          usage: { input_tokens: 10, output_tokens: 8192 },
        }),
      );

      const result = await makeProvider().generate({ prompt: 'x' });

      expect(result).toMatchObject({ text: '', truncated: true });
    });

    it('treats a refusal as blocked', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help' }] }],
        }),
      );

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('blocked');
    });

    it('treats a content-filter stop as blocked', async () => {
      fetchMock.mockResolvedValueOnce(
        json(answer('', { status: 'incomplete', incompleteReason: 'content_filter' })),
      );

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('blocked');
    });

    it('turns a failed response into a server error carrying the reason', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ status: 'failed', error: { message: 'model overloaded' } }),
      );

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('server_error');
      expect(error.message).toContain('model overloaded');
    });

    it('rejects an empty completed answer', async () => {
      fetchMock.mockResolvedValueOnce(json({ status: 'completed', output: [] }));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('invalid_response');
    });

    it('rejects a body that is not the expected shape', async () => {
      fetchMock.mockResolvedValueOnce(json({ output: 'nope' }));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('invalid_response');
    });

    it('rejects a response that is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('invalid_response');
    });
  });

  describe('parameters a model refuses', () => {
    it('drops the temperature and asks again when the model does not take one', async () => {
      fetchMock
        .mockResolvedValueOnce(
          apiError(400, "Unsupported value: 'temperature' does not support 0.2 with this model."),
        )
        .mockResolvedValueOnce(json(answer('fine')));

      const result = await makeProvider().generate({ prompt: 'x', temperature: 0.2 });

      expect(result.text).toBe('fine');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requestBody(0)).toHaveProperty('temperature', 0.2);
      expect(requestBody(1)).not.toHaveProperty('temperature');
      expect(requestBody(1)).toHaveProperty('store', false);
    });

    it('drops the store flag and asks again when the API does not know it', async () => {
      fetchMock
        .mockResolvedValueOnce(apiError(400, "Unknown parameter: 'store'."))
        .mockResolvedValueOnce(json(answer('fine')));

      await makeProvider().generate({ prompt: 'x' });

      expect(requestBody(1)).not.toHaveProperty('store');
    });

    it('drops each parameter at most once, then reports the error', async () => {
      fetchMock
        .mockResolvedValueOnce(apiError(400, "'temperature' is not supported"))
        .mockResolvedValueOnce(apiError(400, "'temperature' is still a problem"));

      const error = await rejection(makeProvider().generate({ prompt: 'x', temperature: 0.2 }));

      expect(error.kind).toBe('invalid_request');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports a 400 that names no droppable parameter without a second call', async () => {
      fetchMock.mockResolvedValueOnce(apiError(400, 'Invalid input: model is required'));

      const error = await rejection(makeProvider().generate({ prompt: 'x', temperature: 0.2 }));

      expect(error.kind).toBe('invalid_request');
      expect(error.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not mistake a longer word for the parameter', async () => {
      fetchMock.mockResolvedValueOnce(apiError(400, 'The restore point is invalid'));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('invalid_request');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('errors', () => {
    it('maps 401 to unauthorized without calling again', async () => {
      fetchMock.mockResolvedValueOnce(apiError(401, 'Incorrect API key provided'));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('unauthorized');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps 403 to unauthorized and keeps the provider message', async () => {
      fetchMock.mockResolvedValueOnce(apiError(403, 'The team has no credits'));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('unauthorized');
      expect(error.message).toContain('no credits');
    });

    it('maps 404 to model_not_found and names the model', async () => {
      fetchMock.mockResolvedValueOnce(apiError(404, 'The model does not exist'));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('model_not_found');
      expect(error.message).toContain(MODEL);
    });

    it('does not retry a used-up balance and reports quota_exhausted', async () => {
      fetchMock.mockResolvedValueOnce(
        apiError(429, 'You exceeded your current quota, check your plan and billing details.', {
          code: 'insufficient_quota',
        }),
      );

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('quota_exhausted');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads the xAI error shape, where the error is a plain string', async () => {
      fetchMock.mockResolvedValueOnce(
        json(
          { code: 'credits', error: 'Your team has run out of credits. Add credits to continue.' },
          { status: 429 },
        ),
      );

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('quota_exhausted');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a rate limit with the Retry-After delay, then succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(
            { error: { message: 'Rate limit reached' } },
            { status: 429, headers: { 'retry-after': '7' } },
          ),
        )
        .mockResolvedValueOnce(json(answer('ok')));

      const result = await makeProvider().generate({ prompt: 'x' });

      expect(result.text).toBe('ok');
      expect(sleep).toHaveBeenCalledWith(7000);
    });

    it('retries a server error with doubling delays, and gives up after the retries', async () => {
      fetchMock.mockImplementation(async () => apiError(503, 'Overloaded'));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('server_error');
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
    });

    it('retries a network failure and then reports it without the key', async () => {
      fetchMock.mockImplementation(async () => {
        throw new Error(`connect ECONNREFUSED while using ${KEY}`);
      });

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.kind).toBe('network');
      expect(error.message).not.toContain(KEY);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('never puts the API key in an error message', async () => {
      fetchMock.mockResolvedValueOnce(apiError(400, `Invalid request for key ${KEY}`));

      const error = await rejection(makeProvider().generate({ prompt: 'x' }));

      expect(error.message).not.toContain(KEY);
      expect(error.message).toContain('[redacted]');
    });
  });
});

describe('createProvider with OpenAI and Grok', () => {
  it.each<[OpenAIFamilyName]>([['openai'], ['grok']])('builds the %s provider', (name) => {
    const provider = createProvider({
      provider: name,
      apiKey: 'key',
      model: 'some-model',
      maxOutputTokens: 4096,
      fallbackModels: [],
    });

    expect(provider).toBeInstanceOf(OpenAIFamilyProvider);
    expect(provider.name).toBe(name);
  });

  it('switches models on a daily quota when fallback models are configured', () => {
    const provider = createProvider({
      provider: 'grok',
      apiKey: 'key',
      model: 'model-a',
      maxOutputTokens: 4096,
      fallbackModels: ['model-b'],
    });

    expect(provider).toBeInstanceOf(FallbackProvider);
  });

  it('says which provider is missing its key or model', () => {
    expect(() =>
      createProvider({ provider: 'openai', maxOutputTokens: 4096, fallbackModels: [] }),
    ).toThrow('OpenAI needs AI_API_KEY and AI_MODEL');
    expect(() =>
      createProvider({ provider: 'grok', apiKey: 'k', maxOutputTokens: 4096, fallbackModels: [] }),
    ).toThrow('Grok (xAI) needs AI_API_KEY and AI_MODEL');
  });
});
