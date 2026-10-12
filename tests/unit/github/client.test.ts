import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../../../src/github/client.js';
import { GitHubError } from '../../../src/github/errors.js';

const TOKEN = 'ghp_thisIsATestTokenValue1234567890abcdef';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

async function rejection(promise: Promise<unknown>): Promise<GitHubError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof GitHubError)) {
    throw new Error('Expected the promise to reject with a GitHubError');
  }
  return outcome;
}

const rawPr = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  title: `Fix thing (SHP-${number})`,
  body: 'Description',
  state: 'open',
  merged: false,
  html_url: `https://github.com/acme/shop/pull/${number}`,
  updated_at: '2026-10-11T09:00:00Z',
  head: { ref: `fix/SHP-${number}-thing` },
  base: { ref: 'develop' },
  changed_files: 3,
  additions: 20,
  deletions: 4,
  ...overrides,
});

describe('GitHubClient', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  const makeClient = (config: { apiUrl?: string } = {}) =>
    new GitHubClient({ token: TOKEN, ...config }, { fetch: fetchMock, sleep });

  const urlOf = (call: number) => String(fetchMock.mock.calls[call]?.[0]);

  beforeEach(() => {
    fetchMock.mockReset();
    sleep.mockClear();
  });

  describe('requests', () => {
    it('sends the token, a version and a user agent, and only reads', async () => {
      fetchMock.mockImplementation(async () => json(rawPr(7)));

      await makeClient().getPullRequest('acme/shop', 7);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(url).toBe('https://api.github.com/repos/acme/shop/pulls/7');
      expect(init.method).toBe('GET');
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers['X-GitHub-Api-Version']).toBeDefined();
      expect(headers['User-Agent']).toBeTruthy();
    });

    it('can use another API address', async () => {
      fetchMock.mockImplementation(async () => json(rawPr(7)));

      await makeClient({ apiUrl: 'https://github.example.com/api/v3/' }).getPullRequest(
        'acme/shop',
        7,
      );

      expect(urlOf(0)).toBe('https://github.example.com/api/v3/repos/acme/shop/pulls/7');
    });

    it('refuses a repository or a number that is not valid, without calling GitHub', async () => {
      const client = makeClient();

      expect((await rejection(client.getPullRequest('not a repo', 1))).kind).toBe('invalid_input');
      expect((await rejection(client.getPullRequest('a/b/c', 1))).kind).toBe('invalid_input');
      expect((await rejection(client.getPullRequest('acme/shop', 0))).kind).toBe('invalid_input');
      expect((await rejection(client.searchPullRequests('acme/shop', '  '))).kind).toBe(
        'invalid_input',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('getPullRequest', () => {
    it('maps the answer', async () => {
      fetchMock.mockImplementation(async () => json(rawPr(3203, { merged: true })));

      const pr = await makeClient().getPullRequest('acme/shop', 3203);

      expect(pr).toEqual({
        repo: 'acme/shop',
        number: 3203,
        title: 'Fix thing (SHP-3203)',
        body: 'Description',
        state: 'open',
        merged: true,
        headRef: 'fix/SHP-3203-thing',
        baseRef: 'develop',
        url: 'https://github.com/acme/shop/pull/3203',
        updatedAt: '2026-10-11T09:00:00Z',
        changedFiles: 3,
        additions: 20,
        deletions: 4,
      });
    });

    it('treats a missing description as empty and a merged_at as merged', async () => {
      fetchMock.mockImplementation(async () =>
        json(rawPr(5, { body: null, merged: undefined, merged_at: '2026-10-01T00:00:00Z' })),
      );

      const pr = await makeClient().getPullRequest('acme/shop', 5);

      expect(pr.body).toBe('');
      expect(pr.merged).toBe(true);
    });

    it('reports an unexpected answer', async () => {
      fetchMock.mockImplementation(async () => json({ unexpected: true }));

      expect((await rejection(makeClient().getPullRequest('acme/shop', 1))).kind).toBe(
        'invalid_response',
      );
    });

    it('reports an answer that is not JSON', async () => {
      fetchMock.mockImplementation(async () => new Response('<html>', { status: 200 }));

      expect((await rejection(makeClient().getPullRequest('acme/shop', 1))).kind).toBe(
        'invalid_response',
      );
    });
  });

  describe('listPullRequestFiles', () => {
    const rawFile = (name: string, extra: Record<string, unknown> = {}) => ({
      filename: name,
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-a\n+b',
      ...extra,
    });

    it('maps files, including a missing patch and a rename', async () => {
      fetchMock.mockImplementation(async () =>
        json([
          rawFile('a.ts'),
          rawFile('b.png', { patch: undefined, status: 'added' }),
          rawFile('c.ts', { status: 'renamed', previous_filename: 'old.ts' }),
          rawFile('d.ts', { status: 'something-new' }),
        ]),
      );

      const { files, truncated } = await makeClient().listPullRequestFiles('acme/shop', 9);

      expect(truncated).toBe(false);
      expect(files).toHaveLength(4);
      expect(files[0]).toEqual({
        path: 'a.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-a\n+b',
      });
      expect(files[1]).not.toHaveProperty('patch');
      expect(files[2]).toMatchObject({ status: 'renamed', previousPath: 'old.ts' });
      expect(files[3]?.status).toBe('changed');
    });

    it('reads the next page when a page is full', async () => {
      const page = Array.from({ length: 100 }, (_, i) => rawFile(`f${i}.ts`));
      fetchMock.mockResolvedValueOnce(json(page)).mockResolvedValueOnce(json([rawFile('last.ts')]));

      const { files } = await makeClient().listPullRequestFiles('acme/shop', 9);

      expect(files).toHaveLength(101);
      expect(urlOf(0)).toContain('page=1');
      expect(urlOf(1)).toContain('page=2');
    });

    it('stops at the limit and says the list was cut', async () => {
      const page = Array.from({ length: 100 }, (_, i) => rawFile(`f${i}.ts`));
      fetchMock.mockImplementation(async () => json(page));

      const { files, truncated } = await makeClient().listPullRequestFiles('acme/shop', 9, 150);

      expect(files).toHaveLength(150);
      expect(truncated).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('says the list was cut when the limit is exactly the end of a page', async () => {
      const page = Array.from({ length: 100 }, (_, i) => rawFile(`f${i}.ts`));
      fetchMock.mockImplementation(async () => json(page));

      const { truncated } = await makeClient().listPullRequestFiles('acme/shop', 9, 100);

      expect(truncated).toBe(true);
    });
  });

  describe('searchPullRequests', () => {
    it('searches the repository for pull requests and maps the items', async () => {
      fetchMock.mockImplementation(async () =>
        json({
          items: [
            {
              number: 3203,
              title: 'fix (SHP-4103)',
              body: null,
              state: 'open',
              html_url: 'https://github.com/acme/shop/pull/3203',
              updated_at: '2026-10-11T09:00:00Z',
              pull_request: { merged_at: null },
            },
            {
              number: 3100,
              title: 'older',
              body: 'mentions SHP-4103',
              state: 'closed',
              pull_request: { merged_at: '2026-09-01T00:00:00Z' },
            },
          ],
        }),
      );

      const found = await makeClient().searchPullRequests('acme/shop', 'SHP-4103');

      const url = new URL(urlOf(0));
      expect(url.pathname).toBe('/search/issues');
      expect(url.searchParams.get('q')).toBe('repo:acme/shop is:pr SHP-4103');
      expect(found.map((p) => [p.number, p.state, p.merged])).toEqual([
        [3203, 'open', false],
        [3100, 'closed', true],
      ]);
      expect(found[1]?.url).toBe('https://github.com/acme/shop/pull/3100');
    });

    it('strips characters that could change the search', async () => {
      fetchMock.mockImplementation(async () => json({ items: [] }));

      await makeClient().searchPullRequests('acme/shop', 'SHP-1 repo:other/secret');

      expect(new URL(urlOf(0)).searchParams.get('q')).toBe(
        'repo:acme/shop is:pr SHP-1 repo other secret',
      );
    });
  });

  describe('listRecentPullRequests', () => {
    it('reads pages until one is short, newest first', async () => {
      const full = Array.from({ length: 100 }, (_, i) => rawPr(1000 - i));
      fetchMock
        .mockResolvedValueOnce(json(full))
        .mockResolvedValueOnce(json([rawPr(900), rawPr(899)]));

      const found = await makeClient().listRecentPullRequests('acme/shop');

      expect(found).toHaveLength(102);
      expect(urlOf(0)).toContain('sort=updated&direction=desc');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stops at the number of pages asked for', async () => {
      const full = Array.from({ length: 100 }, (_, i) => rawPr(1000 - i));
      fetchMock.mockImplementation(async () => json(full));

      const found = await makeClient().listRecentPullRequests('acme/shop', 2);

      expect(found).toHaveLength(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('files of a branch', () => {
    it('lists only files, with sizes, and says when GitHub cut the list', async () => {
      fetchMock.mockImplementation(async () =>
        json({
          truncated: true,
          tree: [
            { path: 'src', type: 'tree' },
            { path: 'src/a.ts', type: 'blob', size: 120 },
            { path: 'src/b.ts', type: 'blob' },
          ],
        }),
      );

      const { entries, truncated } = await makeClient().listFiles('acme/shop', 'develop');

      expect(entries).toEqual([
        { path: 'src/a.ts', size: 120 },
        { path: 'src/b.ts', size: 0 },
      ]);
      expect(truncated).toBe(true);
      expect(urlOf(0)).toContain('/git/trees/develop?recursive=1');
    });

    it('reads one file as text and encodes its path', async () => {
      fetchMock.mockImplementation(async () => new Response('export const a = 1', { status: 200 }));

      const text = await makeClient().getFile('acme/shop', 'src/my dir/a#1.ts', 'feature/x');

      expect(text).toBe('export const a = 1');
      expect(urlOf(0)).toBe(
        'https://api.github.com/repos/acme/shop/contents/src/my%20dir/a%231.ts?ref=feature%2Fx',
      );
      const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers.Accept).toBe('application/vnd.github.raw+json');
    });

    it('returns nothing for a file that is not on that branch', async () => {
      fetchMock.mockImplementation(async () => json({ message: 'Not Found' }, { status: 404 }));

      expect(await makeClient().getFile('acme/shop', 'gone.ts', 'develop')).toBeUndefined();
    });
  });

  describe('checkConnection', () => {
    it('says who the token belongs to and which repositories it can read', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ login: 'abdusdev' }))
        .mockResolvedValueOnce(json({ full_name: 'acme/shop' }))
        .mockResolvedValueOnce(json({ message: 'Not Found' }, { status: 404 }));

      const status = await makeClient().checkConnection(['acme/shop', 'acme/hidden']);

      expect(status).toEqual({
        login: 'abdusdev',
        repos: [
          { repo: 'acme/shop', accessible: true },
          { repo: 'acme/hidden', accessible: false },
        ],
      });
    });

    it('lets a rejected token surface', async () => {
      fetchMock.mockImplementation(async () =>
        json({ message: 'Bad credentials' }, { status: 401 }),
      );

      expect((await rejection(makeClient().checkConnection(['acme/shop']))).kind).toBe(
        'unauthorized',
      );
    });
  });

  describe('errors', () => {
    it('names a rejected token without repeating it', async () => {
      fetchMock.mockImplementation(async () =>
        json({ message: `Bad credentials ${TOKEN}` }, { status: 401 }),
      );

      const error = await rejection(makeClient().getPullRequest('acme/shop', 1));

      expect(error.kind).toBe('unauthorized');
      expect(error.status).toBe(401);
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).toContain('GITHUB_TOKEN');
    });

    it('explains a missing permission', async () => {
      fetchMock.mockImplementation(async () =>
        json({ message: 'Resource not accessible by personal access token' }, { status: 403 }),
      );

      const error = await rejection(makeClient().getPullRequest('acme/shop', 1));

      expect(error.kind).toBe('forbidden');
      expect(error.message).toContain('read access');
    });

    it('treats an empty allowance as a rate limit and does not retry it', async () => {
      fetchMock.mockImplementation(async () =>
        json(
          { message: 'API rate limit exceeded' },
          { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
        ),
      );

      const error = await rejection(makeClient().getPullRequest('acme/shop', 1));

      expect(error.kind).toBe('rate_limited');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a secondary limit after the time GitHub gives', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(
            { message: 'You have exceeded a secondary rate limit.' },
            { status: 403, headers: { 'retry-after': '2' } },
          ),
        )
        .mockResolvedValueOnce(json(rawPr(1)));

      const pr = await makeClient().getPullRequest('acme/shop', 1);

      expect(pr.number).toBe(1);
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('retries a 429 and then gives up as rate limited', async () => {
      fetchMock.mockImplementation(async () => json({ message: 'slow down' }, { status: 429 }));

      const error = await rejection(makeClient().getPullRequest('acme/shop', 1));

      expect(error.kind).toBe('rate_limited');
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('retries a server error and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(json({}, { status: 502 }))
        .mockResolvedValueOnce(json(rawPr(1)));

      expect((await makeClient().getPullRequest('acme/shop', 1)).number).toBe(1);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('does not retry a missing pull request', async () => {
      fetchMock.mockImplementation(async () => json({ message: 'Not Found' }, { status: 404 }));

      const error = await rejection(makeClient().getPullRequest('acme/shop', 1));

      expect(error.kind).toBe('not_found');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a rejected request with the reason from GitHub', async () => {
      fetchMock.mockImplementation(async () =>
        json({ message: 'Validation Failed' }, { status: 422 }),
      );

      const error = await rejection(makeClient().searchPullRequests('acme/shop', 'SHP-1'));

      expect(error.kind).toBe('bad_request');
      expect(error.message).toContain('Validation Failed');
    });

    it('reports a network failure after retrying, without the token', async () => {
      fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED using ${TOKEN}`));

      const error = await rejection(makeClient().getPullRequest('acme/shop', 1));

      expect(error.kind).toBe('network');
      expect(error.message).not.toContain(TOKEN);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('reports a timeout in plain words', async () => {
      const timeout = new Error('timed out');
      timeout.name = 'TimeoutError';
      fetchMock.mockRejectedValue(timeout);

      const error = await rejection(makeClient().getPullRequest('acme/shop', 1));

      expect(error.message).toContain('timed out');
    });
  });
});
