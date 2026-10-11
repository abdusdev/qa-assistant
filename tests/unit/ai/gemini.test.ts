import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIError } from '../../../src/ai/errors.js';
import { GeminiProvider } from '../../../src/ai/gemini.js';

const KEY = 'AIza-secret-key-value-123';
const MODEL = 'test-model-1';

const answer = (
  text: string,
  extras: { finishReason?: string; usage?: Record<string, number>; modelVersion?: string } = {},
) => ({
  candidates: [
    {
      content: { role: 'model', parts: [{ text }] },
      finishReason: extras.finishReason ?? 'STOP',
    },
  ],
  usageMetadata: extras.usage ?? {
    promptTokenCount: 120,
    candidatesTokenCount: 30,
    totalTokenCount: 150,
  },
  ...(extras.modelVersion && { modelVersion: extras.modelVersion }),
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const googleError = (status: number, message: string, details: unknown[] = []) =>
  json({ error: { code: status, message, status: 'ERR', details } }, { status });

/** Awaits a promise that must reject, and returns the error. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) {
    throw new Error('Expected the promise to reject with an Error');
  }
  return outcome;
}

describe('GeminiProvider', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

  const makeProvider = (config: { maxOutputTokens?: number; model?: string } = {}) =>
    new GeminiProvider({ apiKey: KEY, model: MODEL, ...config }, { fetch: fetchMock, sleep });

  const requestBody = (call = 0) =>
    JSON.parse(String(fetchMock.mock.calls[call]![1]?.body)) as Record<string, unknown>;

  beforeEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
  });

  describe('request', () => {
    it('posts to the model endpoint with the key in a header, not in the URL', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('hello')));

      await makeProvider().generate({ prompt: 'Say hello' });

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      );
      expect(String(url)).not.toContain(KEY);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe(KEY);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('sends the prompt, the system instructions and the JSON setting', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('{}')));

      await makeProvider().generate({
        system: 'You are a QA engineer.',
        prompt: 'Ticket SHP-1',
        json: true,
        temperature: 0.2,
      });

      expect(requestBody()).toEqual({
        systemInstruction: { parts: [{ text: 'You are a QA engineer.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Ticket SHP-1' }] }],
        generationConfig: {
          maxOutputTokens: 8192,
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      });
    });

    it('leaves out system instructions and JSON mode when not asked for', async () => {
      fetchMock.mockResolvedValueOnce(json(answer('hi')));

      await makeProvider().generate({ prompt: 'hello' });

      const body = requestBody();
      expect(body).not.toHaveProperty('systemInstruction');
      expect(body.generationConfig).toEqual({ maxOutputTokens: 8192 });
    });

    it('never asks for more than the configured output cap', async () => {
      fetchMock.mockImplementation(async () => json(answer('x')));
      const provider = makeProvider({ maxOutputTokens: 2000 });

      await provider.generate({ prompt: 'a', maxOutputTokens: 50_000 });
      await provider.generate({ prompt: 'a', maxOutputTokens: 500 });
      await provider.generate({ prompt: 'a' });

      const limits = [0, 1, 2].map(
        (call) =>
          (requestBody(call).generationConfig as { maxOutputTokens: number }).maxOutputTokens,
      );
      expect(limits).toEqual([2000, 500, 2000]);
    });

    it('rejects an empty prompt without calling Google', async () => {
      await expect(makeProvider().generate({ prompt: '   ' })).rejects.toMatchObject({
        kind: 'invalid_request',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a model id that could change the request path', () => {
      expect(() => makeProvider({ model: 'good/../../bad' })).toThrow(AIError);
      expect(() => makeProvider({ model: 'model?key=x' })).toThrow(/AI_MODEL/);
    });
  });

  describe('response', () => {
    it('returns the text, the usage and the model', async () => {
      fetchMock.mockResolvedValueOnce(
        json(answer('The answer', { modelVersion: 'test-model-1-001' })),
      );

      const response = await makeProvider().generate({ prompt: 'q' });

      expect(response).toEqual({
        text: 'The answer',
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        model: 'test-model-1-001',
        truncated: false,
      });
    });

    it('joins an answer that comes in several parts', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          candidates: [
            { content: { parts: [{ text: '{"cases":' }, { text: '[]}' }] }, finishReason: 'STOP' },
          ],
        }),
      );

      const response = await makeProvider().generate({ prompt: 'q' });

      expect(response.text).toBe('{"cases":[]}');
    });

    it('counts thinking tokens as output', async () => {
      fetchMock.mockResolvedValueOnce(
        json(
          answer('ok', {
            usage: {
              promptTokenCount: 100,
              candidatesTokenCount: 20,
              thoughtsTokenCount: 300,
              totalTokenCount: 420,
            },
          }),
        ),
      );

      const response = await makeProvider().generate({ prompt: 'q' });

      expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 320, totalTokens: 420 });
    });

    it('reports zero usage when Google gives none', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      );

      const response = await makeProvider().generate({ prompt: 'q' });

      expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      expect(response.model).toBe(MODEL);
    });

    it('marks an answer that hit the output limit as truncated', async () => {
      fetchMock.mockResolvedValueOnce(
        json(answer('{"cases":[{"id":"TC-1"', { finishReason: 'MAX_TOKENS' })),
      );

      const response = await makeProvider().generate({ prompt: 'q' });

      expect(response.truncated).toBe(true);
    });

    it('returns an empty truncated answer when the limit was used up before any text', async () => {
      fetchMock.mockResolvedValueOnce(
        json({
          candidates: [{ finishReason: 'MAX_TOKENS' }],
          usageMetadata: { totalTokenCount: 8192 },
        }),
      );

      const response = await makeProvider().generate({ prompt: 'q' });

      expect(response).toMatchObject({ text: '', truncated: true });
    });

    it('reports a blocked prompt', async () => {
      fetchMock.mockResolvedValueOnce(json({ promptFeedback: { blockReason: 'SAFETY' } }));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toMatchObject({
        kind: 'blocked',
        message: expect.stringContaining('SAFETY') as string,
      });
    });

    it('reports a refused answer', async () => {
      fetchMock.mockResolvedValueOnce(json({ candidates: [{ finishReason: 'SAFETY' }] }));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toMatchObject({
        kind: 'blocked',
      });
    });

    it.each([
      ['no candidates', {}],
      ['an empty candidate list', { candidates: [] }],
      ['an empty answer', { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }],
      ['a wrong shape', { candidates: 'nope' }],
    ])('rejects %s', async (_label, body) => {
      fetchMock.mockResolvedValueOnce(json(body));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    });

    it('rejects a body that is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 200 }));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    });
  });

  describe('failures that are not retried', () => {
    it('maps a rejected key (Google answers 400) to unauthorized', async () => {
      fetchMock.mockResolvedValueOnce(
        googleError(400, 'API key not valid. Please pass a valid API key.'),
      );

      const error = await rejection(makeProvider().generate({ prompt: 'q' }));

      expect(error).toMatchObject({ kind: 'unauthorized', status: 400 });
      expect(error.message).toContain('AI_API_KEY');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403])('maps HTTP %i to unauthorized', async (status) => {
      fetchMock.mockResolvedValueOnce(googleError(status, 'denied'));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toMatchObject({
        kind: 'unauthorized',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('names AI_MODEL when the model does not exist', async () => {
      fetchMock.mockResolvedValueOnce(googleError(404, 'models/test-model-1 is not found'));

      const error = await rejection(makeProvider().generate({ prompt: 'q' }));

      expect(error).toMatchObject({ kind: 'model_not_found', status: 404 });
      expect(error.message).toContain('AI_MODEL');
      expect(error.message).toContain(MODEL);
    });

    it('maps other 400 errors to invalid_request and keeps the explanation', async () => {
      fetchMock.mockResolvedValueOnce(googleError(400, 'Request contains an invalid argument.'));

      const error = await rejection(makeProvider().generate({ prompt: 'q' }));

      expect(error).toMatchObject({ kind: 'invalid_request', status: 400 });
      expect(error.message).toContain('invalid argument');
    });
  });

  describe('retries', () => {
    it('waits for the delay Google reports, then succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(
          googleError(429, 'Quota exceeded', [{ '@type': 'RetryInfo', retryDelay: '23s' }]),
        )
        .mockResolvedValueOnce(json(answer('ok')));

      const response = await makeProvider().generate({ prompt: 'q' });

      expect(response.text).toBe('ok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(23_000);
    });

    it('prefers a Retry-After header', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '4' } }))
        .mockResolvedValueOnce(json(answer('ok')));

      await makeProvider().generate({ prompt: 'q' });

      expect(sleep).toHaveBeenCalledExactlyOnceWith(4000);
    });

    it('caps a long wait at one minute', async () => {
      fetchMock
        .mockResolvedValueOnce(
          googleError(429, 'Quota', [{ '@type': 'RetryInfo', retryDelay: '3600s' }]),
        )
        .mockResolvedValueOnce(json(answer('ok')));

      await makeProvider().generate({ prompt: 'q' });

      expect(sleep).toHaveBeenCalledExactlyOnceWith(60_000);
    });

    it('uses exponential backoff when no delay is given', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(json(answer('ok')));

      await makeProvider().generate({ prompt: 'q' });

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    });

    it('gives up after the retry limit on repeated server errors', async () => {
      fetchMock.mockImplementation(async () => new Response('', { status: 500 }));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toMatchObject({
        kind: 'server_error',
        status: 500,
      });
      expect(fetchMock).toHaveBeenCalledTimes(4); // first attempt + 3 retries
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
    });

    it('reports a quota that never clears as rate_limited', async () => {
      fetchMock.mockImplementation(async () => googleError(429, 'Quota exceeded'));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toMatchObject({
        kind: 'rate_limited',
      });
    });

    it('retries network errors and recovers', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(json(answer('ok')));

      const response = await makeProvider().generate({ prompt: 'q' });

      expect(response.text).toBe('ok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports a network failure after retries', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toMatchObject({
        kind: 'network',
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('reports a timeout in plain words', async () => {
      fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

      await expect(makeProvider().generate({ prompt: 'q' })).rejects.toThrow(/timed out/);
    });
  });

  describe('secrets', () => {
    it('never puts the API key in an error message', async () => {
      fetchMock
        .mockResolvedValueOnce(googleError(429, `Quota exceeded for key ${KEY}`))
        .mockResolvedValueOnce(googleError(429, `Quota exceeded for key ${KEY}`))
        .mockResolvedValueOnce(googleError(429, `Quota exceeded for key ${KEY}`))
        .mockResolvedValueOnce(googleError(429, `Quota exceeded for key ${KEY}`))
        .mockRejectedValueOnce(new Error(`connect failed for ${KEY}`))
        .mockRejectedValueOnce(new Error(`connect failed for ${KEY}`))
        .mockRejectedValueOnce(new Error(`connect failed for ${KEY}`))
        .mockRejectedValueOnce(new Error(`connect failed for ${KEY}`));

      const quota = await rejection(makeProvider().generate({ prompt: 'q' }));
      const network = await rejection(makeProvider().generate({ prompt: 'q' }));

      for (const error of [quota, network]) {
        expect(error.message).not.toContain(KEY);
      }
      expect(quota.message).toContain('[redacted]');
      expect(network.message).toContain('[redacted]');
    });

    it('does not include the prompt in errors', async () => {
      fetchMock.mockResolvedValueOnce(googleError(400, 'Request contains an invalid argument.'));

      const error = await rejection(
        makeProvider().generate({ prompt: 'CONFIDENTIAL TICKET TEXT' }),
      );

      expect(error.message).not.toContain('CONFIDENTIAL');
    });
  });
});
