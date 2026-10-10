import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JiraClient } from '../../../src/jira/client.js';
import { JiraError } from '../../../src/jira/errors.js';

const BASE_URL = 'https://example.atlassian.net';
const EMAIL = 'qa-bot@example.com';
const TOKEN = 'secret-token-value-123';

const adf = (value: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
});

const issueBody = (overrides: Record<string, unknown> = {}) => ({
  key: 'SHP-4085',
  fields: {
    summary: 'Analysis of AI-assisted test case generation',
    description: adf('Describe the approach.'),
    status: { name: 'In Progress' },
    issuetype: { name: 'Story' },
    parent: { key: 'SHP-4084' },
    labels: ['qa', 'ai'],
    fixVersions: [{ name: '2.14.0' }],
    comment: {
      comments: [
        {
          author: { displayName: 'Safiuddin' },
          created: '2026-10-01T10:00:00.000+0100',
          body: adf('Please include limits.'),
        },
      ],
    },
    ...overrides,
  },
});

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

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

describe('JiraClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

  const makeClient = (config: { acceptanceCriteriaField?: string; baseUrl?: string } = {}) =>
    new JiraClient(
      { baseUrl: config.baseUrl ?? BASE_URL, email: EMAIL, apiToken: TOKEN, ...config },
      { fetch: fetchMock, sleep },
    );

  beforeEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
  });

  describe('getIssue', () => {
    it('requests the issue with basic auth and the fields we need', async () => {
      fetchMock.mockResolvedValueOnce(json(issueBody()));

      await makeClient().getIssue('SHP-4085');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      const requested = new URL(String(url));
      expect(requested.origin + requested.pathname).toBe(`${BASE_URL}/rest/api/3/issue/SHP-4085`);
      expect(requested.searchParams.get('fields')).toBe(
        'summary,description,status,issuetype,parent,labels,fixVersions,comment',
      );

      const headers = init?.headers as Record<string, string>;
      const expectedAuth = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
      expect(headers.Authorization).toBe(expectedAuth);
      expect(headers.Accept).toBe('application/json');
    });

    it('returns a normalized ticket with rich text converted to plain text', async () => {
      fetchMock.mockResolvedValueOnce(json(issueBody()));

      const ticket = await makeClient().getIssue('SHP-4085');

      expect(ticket).toEqual({
        key: 'SHP-4085',
        url: `${BASE_URL}/browse/SHP-4085`,
        summary: 'Analysis of AI-assisted test case generation',
        type: 'Story',
        status: 'In Progress',
        description: 'Describe the approach.',
        parentKey: 'SHP-4084',
        labels: ['qa', 'ai'],
        fixVersions: ['2.14.0'],
        comments: [
          {
            author: 'Safiuddin',
            created: '2026-10-01T10:00:00.000+0100',
            body: 'Please include limits.',
          },
        ],
      });
    });

    it('reads acceptance criteria from the configured custom field', async () => {
      fetchMock.mockResolvedValueOnce(
        json(issueBody({ customfield_10042: adf('Shows 10 orders per page') })),
      );

      const ticket = await makeClient({ acceptanceCriteriaField: 'customfield_10042' }).getIssue(
        'SHP-4085',
      );

      expect(ticket.acceptanceCriteria).toBe('Shows 10 orders per page');
      const requested = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(requested.searchParams.get('fields')).toContain('customfield_10042');
    });

    it('leaves acceptance criteria out when the field is empty', async () => {
      fetchMock.mockResolvedValueOnce(json(issueBody({ customfield_10042: null })));

      const ticket = await makeClient({ acceptanceCriteriaField: 'customfield_10042' }).getIssue(
        'SHP-4085',
      );

      expect(ticket).not.toHaveProperty('acceptanceCriteria');
    });

    it('fills safe defaults when optional fields are missing', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ key: 'SHP-1', fields: { summary: null, description: null } }),
      );

      const ticket = await makeClient().getIssue('SHP-1');

      expect(ticket).toEqual({
        key: 'SHP-1',
        url: `${BASE_URL}/browse/SHP-1`,
        summary: '',
        type: '',
        status: '',
        description: '',
        labels: [],
        fixVersions: [],
        comments: [],
      });
    });

    it('labels comments without an author as Unknown', async () => {
      fetchMock.mockResolvedValueOnce(
        json(issueBody({ comment: { comments: [{ body: adf('anonymous note') }] } })),
      );

      const ticket = await makeClient().getIssue('SHP-4085');

      expect(ticket.comments).toEqual([{ author: 'Unknown', created: '', body: 'anonymous note' }]);
    });

    it('accepts lowercase keys and surrounding spaces', async () => {
      fetchMock.mockResolvedValueOnce(json(issueBody()));

      await makeClient().getIssue('  shp-4085 ');

      expect(String(fetchMock.mock.calls[0]![0])).toContain('/issue/SHP-4085?');
    });

    it('works when the base URL has a trailing slash', async () => {
      fetchMock.mockResolvedValueOnce(json(issueBody()));

      await makeClient({ baseUrl: `${BASE_URL}/` }).getIssue('SHP-4085');

      expect(String(fetchMock.mock.calls[0]![0])).toMatch(
        /^https:\/\/example\.atlassian\.net\/rest\/api\/3\/issue\/SHP-4085\?/,
      );
    });

    it.each(['', 'hello', 'SHP', '4085', 'SHP-', 'SHP-1/../../x', 'SHP-1?expand=names'])(
      'rejects the invalid key %j without calling Jira',
      async (key) => {
        await expect(makeClient().getIssue(key)).rejects.toMatchObject({
          name: 'JiraError',
          kind: 'invalid_key',
        });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
  });

  describe('failures that are not retried', () => {
    it.each([
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [400, 'bad_request'],
    ])('maps HTTP %i to %s and calls Jira once', async (status, kind) => {
      fetchMock.mockResolvedValueOnce(json({ errorMessages: ['nope'] }, { status }));

      const error = await makeClient()
        .getIssue('SHP-1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(JiraError);
      expect(error).toMatchObject({ kind, status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('names the setting to check when the credentials are rejected', async () => {
      fetchMock.mockResolvedValueOnce(json({}, { status: 401 }));

      await expect(makeClient().getIssue('SHP-1')).rejects.toThrow(/JIRA_API_TOKEN/);
    });

    it('names the ticket when it is not found', async () => {
      fetchMock.mockResolvedValueOnce(json({}, { status: 404 }));

      await expect(makeClient().getIssue('SHP-999')).rejects.toThrow(/SHP-999.*not found/);
    });
  });

  describe('retries', () => {
    it('waits for Retry-After on 429 and then succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(json(issueBody()));

      const ticket = await makeClient().getIssue('SHP-4085');

      expect(ticket.key).toBe('SHP-4085');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
    });

    it('uses exponential backoff when Jira gives no Retry-After', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(new Response('', { status: 503 }))
        .mockResolvedValueOnce(json(issueBody()));

      await makeClient().getIssue('SHP-4085');

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
    });

    it('caps a very long Retry-After at 30 seconds', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
        )
        .mockResolvedValueOnce(json(issueBody()));

      await makeClient().getIssue('SHP-4085');

      expect(sleep).toHaveBeenCalledExactlyOnceWith(30_000);
    });

    it('gives up after the retry limit on repeated server errors', async () => {
      fetchMock.mockImplementation(async () => new Response('', { status: 500 }));

      const error = await makeClient()
        .getIssue('SHP-1')
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ kind: 'server_error', status: 500 });
      expect(fetchMock).toHaveBeenCalledTimes(4); // first attempt + 3 retries
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000]);
    });

    it('reports a rate limit that never clears as rate_limited', async () => {
      fetchMock.mockImplementation(async () => new Response('', { status: 429 }));

      await expect(makeClient().getIssue('SHP-1')).rejects.toMatchObject({ kind: 'rate_limited' });
    });

    it('retries network errors and recovers', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(json(issueBody()));

      const ticket = await makeClient().getIssue('SHP-4085');

      expect(ticket.key).toBe('SHP-4085');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports a network failure after retries', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(makeClient().getIssue('SHP-1')).rejects.toMatchObject({
        kind: 'network',
        message: expect.stringContaining('fetch failed') as string,
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('reports a timeout in plain words', async () => {
      const timeout = new DOMException('The operation timed out.', 'TimeoutError');
      fetchMock.mockRejectedValue(timeout);

      await expect(makeClient().getIssue('SHP-1')).rejects.toThrow(/timed out/);
    });
  });

  describe('bad responses', () => {
    it('rejects a 200 response that is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(new Response('<html>login</html>', { status: 200 }));

      await expect(makeClient().getIssue('SHP-1')).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    });

    it('rejects JSON that is not an issue', async () => {
      fetchMock.mockResolvedValueOnce(json({ unexpected: true }));

      await expect(makeClient().getIssue('SHP-1')).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    });
  });

  describe('secrets', () => {
    it('never puts the token or auth header in any error message', async () => {
      const basic = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
      fetchMock
        .mockResolvedValueOnce(json({ errorMessages: [`bad creds ${TOKEN}`] }, { status: 403 }))
        .mockRejectedValueOnce(new Error(`connect failed Basic ${basic}`))
        .mockRejectedValueOnce(new Error(`connect failed ${TOKEN}`))
        .mockRejectedValueOnce(new Error(`connect failed ${TOKEN}`))
        .mockRejectedValueOnce(new Error(`connect failed ${TOKEN}`));

      const forbidden = await rejection(makeClient().getIssue('SHP-1'));
      const network = await rejection(makeClient().getIssue('SHP-1'));

      for (const error of [forbidden, network]) {
        expect(error.message).not.toContain(TOKEN);
        expect(error.message).not.toContain(basic);
      }
      expect(forbidden.message).toContain('[redacted]');
    });
  });
});
