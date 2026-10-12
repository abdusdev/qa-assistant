import { describe, expect, it } from 'vitest';
import {
  CodeContextProvider,
  buildPullRequestDigest,
  compressPatch,
  matchPullRequest,
} from '../../../src/github/code-context.js';
import { GitHubError } from '../../../src/github/errors.js';
import { makeTicket } from '../pipeline/support.js';
import { REPO, fakeGitHub, file, pr } from './support.js';

describe('matchPullRequest', () => {
  it('finds the key in the title, the branch and the description', () => {
    const match = matchPullRequest(
      pr(1, {
        title: 'fix(shipments): quote (SHP-4103)',
        headRef: 'fix/SHP-4103-quote',
        body: 'Closes SHP-4103',
      }),
      'SHP-4103',
    );

    expect(match?.matchedIn).toEqual(['title', 'branch', 'body']);
  });

  it('finds a lowercase key, which some branch names use', () => {
    const match = matchPullRequest(pr(1, { headRef: 't3/shp-4108' }), 'SHP-4108');

    expect(match?.matchedIn).toEqual(['branch']);
  });

  it('does not match a longer number or another prefix', () => {
    expect(matchPullRequest(pr(1, { title: 'SHP-41030 something' }), 'SHP-4103')).toBeUndefined();
    expect(matchPullRequest(pr(1, { title: 'SHP-410 something' }), 'SHP-4103')).toBeUndefined();
    expect(matchPullRequest(pr(1, { title: 'XSHP-4103 something' }), 'SHP-4103')).toBeUndefined();
    expect(matchPullRequest(pr(1, { title: 'nothing relevant' }), 'SHP-4103')).toBeUndefined();
  });

  it('matches a key at the end of a sentence or in brackets', () => {
    expect(matchPullRequest(pr(1, { body: 'See (SHP-4103).' }), 'SHP-4103')?.matchedIn).toEqual([
      'body',
    ]);
  });
});

describe('compressPatch', () => {
  it('keeps hunk headers and changed lines, and drops unchanged and blank ones', () => {
    const patch = [
      '@@ -1,6 +1,6 @@ function a() {',
      ' const kept = true',
      '-const old = 1',
      '+const fresh = 2',
      '+',
      ' return kept',
      '\\ No newline at end of file',
    ].join('\n');

    expect(compressPatch(patch)).toBe(
      ['@@ -1,6 +1,6 @@ function a() {', '-const old = 1', '+const fresh = 2'].join('\n'),
    );
  });
});

describe('buildPullRequestDigest', () => {
  const base = pr(3203, {
    title: 'fix(shipments): invalidate the quote (SHP-4103)',
    body: '## Summary\n- Saving a new Ship To clears the stored quote.\n<!-- reviewer note -->\n![shot](http://x/y.png)',
    state: 'open',
    merged: false,
    headRef: 'fix/SHP-4103-quote',
    changedFiles: 6,
    additions: 40,
    deletions: 5,
  });

  const files = [
    file('app/src/Drawer.tsx', { patch: '@@ -1 +1 @@\n-old\n+const MESSAGE = "Address changed"' }),
    file('app/src/__tests__/Drawer.test.tsx'),
    file('pnpm-lock.yaml', { additions: 900 }),
    file('assets/logo.png', { patch: undefined }),
    file('.env.production', { patch: '+SECRET_KEY=abc' }),
    file('CHANGELOG.md'),
  ];

  it('describes the pull request, lists real files and shows what changed', () => {
    const { text, meta } = buildPullRequestDigest(base, files, 6_000);

    expect(text).toContain(`Pull request ${REPO}#3203 (open): fix(shipments)`);
    expect(text).toContain('Branch: fix/SHP-4103-quote -> develop | 6 files | +40 -5');
    expect(text).toContain('Saving a new Ship To clears the stored quote.');
    expect(text).toContain('M app/src/Drawer.tsx (+3 -1)');
    expect(text).toContain(
      '### app/src/Drawer.tsx\n@@ -1 +1 @@\n-old\n+const MESSAGE = "Address changed"',
    );
    expect(meta).toMatchObject({ files: 6, filesShown: 2, filesLeftOut: 4, state: 'open' });
  });

  it('leaves out lockfiles, images, changelogs and private files completely', () => {
    const { text } = buildPullRequestDigest(base, files, 6_000);

    expect(text).not.toContain('pnpm-lock');
    expect(text).not.toContain('logo.png');
    expect(text).not.toContain('CHANGELOG');
    expect(text).not.toContain('.env.production');
    expect(text).not.toContain('SECRET_KEY');
    expect(text).toContain('4 more left out');
  });

  it('removes comments and images from the description', () => {
    const { text } = buildPullRequestDigest(base, files, 6_000);

    expect(text).not.toContain('reviewer note');
    expect(text).not.toContain('shot');
  });

  it('replaces secrets in the title, the description and the changes, and counts them', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const secretPr = pr(5, { title: `Use token ${token}`, body: 'password = "hunter2hunter2"' });

    const { text, meta } = buildPullRequestDigest(
      secretPr,
      [file('src/a.ts', { patch: `@@ -1 +1 @@\n+const key = "AKIA${'ABCDEFGHIJKLMNOP'}"` })],
      6_000,
    );

    expect(text).not.toContain(token);
    expect(text).not.toContain('hunter2hunter2');
    expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(meta.secretsRedacted).toBe(3);
  });

  it('never exceeds the size limit and keeps the most useful files', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      file(`src/module${i}/service.ts`, {
        additions: 100 - i,
        patch: `@@ -1 +1 @@\n${'+const value = "x";\n'.repeat(80)}`,
      }),
    );

    const { text, meta } = buildPullRequestDigest(pr(1), many, 4_000);

    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(meta.filesShown).toBeGreaterThan(0);
    expect(meta.filesShown).toBeLessThan(30);
    expect(text).toContain('### src/module0/service.ts');
    expect(text).not.toContain('### src/module29/service.ts');
  });

  it('shows source before tests, and never cuts a changed line in half', () => {
    const { text } = buildPullRequestDigest(
      pr(1),
      [
        file('src/__tests__/a.test.ts', { additions: 80 }),
        file('src/a.ts', {
          additions: 5,
          patch: `@@ -1 +1 @@\n${'+const alpha = "beta gamma delta";\n'.repeat(60)}`,
        }),
      ],
      2_000,
    );

    expect(text.indexOf('### src/a.ts')).toBeLessThan(text.indexOf('### src/__tests__/a.test.ts'));
    for (const line of text.split('\n').filter((l) => l.startsWith('+const alpha'))) {
      expect(line).toBe('+const alpha = "beta gamma delta";');
    }
    expect(text).toContain('[... cut]');
  });

  it('copes with files that have no diff and with no files at all', () => {
    const noPatch = buildPullRequestDigest(
      pr(1),
      [file('src/big.ts', { patch: undefined })],
      2_000,
    );
    const empty = buildPullRequestDigest(pr(1), [], 2_000);

    expect(noPatch.text).toContain('M src/big.ts');
    expect(noPatch.text).not.toContain('Changed lines');
    expect(empty.meta.files).toBe(0);
  });

  it('lists at most 25 files and says how many more there are', () => {
    const many = Array.from({ length: 40 }, (_, i) => file(`src/f${i}.ts`, { patch: undefined }));

    const { text } = buildPullRequestDigest(pr(1), many, 20_000);

    expect(text).toContain('... and 15 more files');
  });
});

describe('CodeContextProvider', () => {
  const ticket = makeTicket('SHP-4103');
  const changed = [
    file('src/a.ts', { patch: '@@ -1 +1 @@\n-a\n+const LABEL = "Fetch new rates"' }),
  ];

  const provider = (
    options: Parameters<typeof fakeGitHub>[0],
    extra: Partial<ConstructorParameters<typeof CodeContextProvider>[1]> = {},
  ) => {
    const source = fakeGitHub(options);
    return { source, provider: new CodeContextProvider(source, { repos: [REPO], ...extra }) };
  };

  it('finds a pull request by its branch and puts its changes in the context', async () => {
    const found = pr(10, { title: 'Quote invalidation', headRef: 'fix/SHP-4103-quote' });
    const { provider: p } = provider({ recent: [pr(1), found], files: { 10: changed } });

    const context = await p.contextFor(ticket);

    expect(context.meta.status).toBe('found');
    expect(context.meta.pullRequests).toMatchObject([
      { number: 10, matchedIn: ['branch'], filesShown: 1 },
    ]);
    expect(context.codeChanges).toContain('Pull request acme/shop#10');
    expect(context.codeChanges).toContain('+const LABEL = "Fetch new rates"');
    expect(context.warnings).toBeUndefined();
  });

  it('does not search when the recent pull requests already name the ticket', async () => {
    const { source, provider: p } = provider({
      recent: [pr(10, { title: 'Quote (SHP-4103)' })],
      files: { 10: changed },
    });

    await p.contextFor(ticket);

    expect(source.calls.search).toEqual([]);
  });

  it('searches for an older pull request that is not among the recent ones', async () => {
    const old = pr(5, { title: 'Quote (SHP-4103)' });
    const { source, provider: p } = provider({
      recent: [pr(1)],
      search: [old],
      files: { 5: changed },
    });

    const context = await p.contextFor(ticket);

    expect(source.calls.search).toEqual([`${REPO}:SHP-4103`]);
    expect(context.meta.pullRequests.map((x) => x.number)).toEqual([5]);
  });

  it('reads the list of recent pull requests once for many tickets', async () => {
    const { source, provider: p } = provider({
      recent: [pr(10, { title: 'A (SHP-1)' }), pr(11, { title: 'B (SHP-2)' })],
      files: { 10: changed, 11: changed },
    });

    await Promise.all([
      p.contextFor(makeTicket('SHP-1')),
      p.contextFor(makeTicket('SHP-2')),
      p.contextFor(makeTicket('SHP-3')),
    ]);

    expect(source.calls.recent).toHaveLength(1);
  });

  it('shows the files that are about the ticket first, and reports which ones', async () => {
    const lines = (count: number, text: string) => Array.from({ length: count }, () => text);
    const big = (name: string, text: string) =>
      file(name, {
        additions: 60,
        patch: ['@@ -1 +1 @@', ...lines(40, text)].join(String.fromCharCode(10)),
      });
    const files = [
      ...Array.from({ length: 12 }, (_, i) =>
        big('src/billing/module' + i + '.ts', '+const unrelatedValue = "x";'),
      ),
      file('src/rates/invalidateQuote.ts', {
        additions: 3,
        patch: ['@@ -1 +1 @@', '+export const STALE = "quote is stale";'].join(
          String.fromCharCode(10),
        ),
      }),
    ];
    const { provider: p } = provider(
      { recent: [pr(90, { title: 'Quote (SHP-4103)' })], files: { 90: files } },
      { maxChars: 5_000 },
    );
    const quoteTicket = makeTicket('SHP-4103', {
      summary: 'Invalidate the quote when the address changes',
      description: 'The stale quote must be cleared when the ship to address changes.',
    });

    const context = await p.contextFor(quoteTicket);

    expect(context.meta.pullRequests[0]?.shownFiles[0]).toBe('src/rates/invalidateQuote.ts');
    expect(context.codeChanges).toContain('### src/rates/invalidateQuote.ts');
  });

  it('uses several pull requests of one ticket, merged ones first, and splits the room', async () => {
    const { provider: p } = provider(
      {
        recent: [
          pr(20, {
            title: 'Part 2 (SHP-4103)',
            merged: false,
            state: 'open',
            updatedAt: '2026-10-20T10:00:00Z',
          }),
          pr(21, { title: 'Part 1 (SHP-4103)', merged: true, updatedAt: '2026-10-01T10:00:00Z' }),
        ],
        files: { 20: changed, 21: changed },
      },
      { maxChars: 6_000 },
    );

    const context = await p.contextFor(ticket);

    expect(context.meta.pullRequests.map((x) => x.number)).toEqual([21, 20]);
    expect(context.codeChanges).toContain('---');
    expect(context.codeChanges?.length).toBeLessThanOrEqual(6_100);
  });

  it('uses at most the configured number of pull requests', async () => {
    const recent = [1, 2, 3, 4, 5].map((n) => pr(30 + n, { title: `Piece ${n} (SHP-4103)` }));
    const files = Object.fromEntries(recent.map((p) => [p.number, changed]));
    const { provider: p } = provider({ recent, files }, { maxPullRequests: 2 });

    const context = await p.contextFor(ticket);

    expect(context.meta.pullRequests).toHaveLength(2);
  });

  it('prefers title and branch matches over a pull request that only mentions the key', async () => {
    const { provider: p } = provider({
      recent: [
        pr(40, { title: 'Release 2.14', body: 'Includes SHP-4103' }),
        pr(41, { title: 'Quote (SHP-4103)' }),
      ],
      files: { 40: changed, 41: changed },
    });

    const context = await p.contextFor(ticket);

    expect(context.meta.pullRequests.map((x) => x.number)).toEqual([41]);
  });

  it('uses a description-only mention when nothing better exists and few tickets are listed', async () => {
    const { provider: p } = provider({
      recent: [pr(50, { title: 'Cleanup', body: 'Part of SHP-4103' })],
      files: { 50: changed },
    });

    const context = await p.contextFor(ticket);

    expect(context.meta.pullRequests).toMatchObject([{ number: 50, matchedIn: ['body'] }]);
  });

  it('ignores a release pull request that lists many tickets', async () => {
    const { provider: p } = provider({
      recent: [
        pr(60, {
          title: 'Release 2.14',
          body: 'SHP-4103 SHP-4104 SHP-4105 SHP-4106 SHP-4107',
        }),
      ],
      files: { 60: changed },
    });

    const context = await p.contextFor(ticket);

    expect(context.meta.status).toBe('none');
    expect(context.codeChanges).toBeUndefined();
  });

  it('says so, and does not fail, when no pull request is found', async () => {
    const { provider: p } = provider({ recent: [pr(1)] });

    const context = await p.contextFor(ticket);

    expect(context.meta).toEqual({ status: 'none', pullRequests: [] });
    expect(context.codeChanges).toBeUndefined();
    expect(context.warnings?.[0]).toContain('SHP-4103: no pull request mentions this ticket');
  });

  it('looks in every configured repository', async () => {
    const source = fakeGitHub({
      recent: [pr(10, { title: 'Quote (SHP-4103)' })],
      files: { 10: changed },
    });
    const both = new CodeContextProvider(source, { repos: [REPO, 'acme/other'] });

    await both.contextFor(ticket);

    expect(source.calls.recent).toEqual([REPO, 'acme/other']);
  });

  it('reports a configuration without repositories', async () => {
    const source = fakeGitHub();
    const none = new CodeContextProvider(source, { repos: [] });

    const context = await none.contextFor(ticket);

    expect(context.meta.status).toBe('unavailable');
    expect(context.warnings?.[0]).toContain('GITHUB_REPOS');
    expect(source.calls.recent).toEqual([]);
  });

  describe('when GitHub fails', () => {
    it('keeps going with the ticket text when a lookup fails for one repository', async () => {
      const { provider: p } = provider({
        fail: { recent: new GitHubError('server_error', 'GitHub is unavailable (502).') },
      });

      const context = await p.contextFor(ticket);

      expect(context.meta.status).toBe('none');
      expect(context.warnings?.join(' ')).toContain('could not look in acme/shop');
    });

    it('stops asking after a rejected token, and says why once per ticket', async () => {
      const { source, provider: p } = provider({
        fail: { recent: new GitHubError('unauthorized', 'GitHub rejected the token (401).') },
      });

      const first = await p.contextFor(makeTicket('SHP-1'));
      const second = await p.contextFor(makeTicket('SHP-2'));

      expect(first.meta.status).toBe('unavailable');
      expect(first.warnings?.[0]).toContain('rejected the token');
      expect(second.meta.status).toBe('unavailable');
      expect(second.meta.note).toContain('rejected the token');
      expect(source.calls.recent).toHaveLength(1);
    });

    it('stops asking after the rate limit is reached', async () => {
      const { source, provider: p } = provider({
        recent: [pr(10, { title: 'A (SHP-1)' })],
        fail: { files: new GitHubError('rate_limited', 'GitHub rate limit reached (403).') },
      });

      const first = await p.contextFor(makeTicket('SHP-1'));
      const second = await p.contextFor(makeTicket('SHP-2'));

      expect(first.meta.status).toBe('unavailable');
      expect(second.meta.status).toBe('unavailable');
      expect(source.calls.files).toHaveLength(1);
    });

    it('keeps the pull requests that could be read when another one fails', async () => {
      const { provider: p } = provider({
        recent: [pr(70, { title: 'A (SHP-4103)' }), pr(71, { title: 'B (SHP-4103)' })],
        files: { 70: changed, 71: changed },
        fail: { details: { 71: new GitHubError('not_found', 'gone', 404) } },
      });

      const context = await p.contextFor(ticket);

      expect(context.meta.status).toBe('found');
      expect(context.meta.pullRequests.map((x) => x.number)).toEqual([70]);
      expect(context.warnings?.join(' ')).toContain('could not read acme/shop#71');
    });

    it('is unavailable when no pull request could be read', async () => {
      const { provider: p } = provider({
        recent: [pr(70, { title: 'A (SHP-4103)' })],
        fail: { files: new GitHubError('server_error', 'down', 500) },
      });

      const context = await p.contextFor(ticket);

      expect(context.meta.status).toBe('unavailable');
      expect(context.codeChanges).toBeUndefined();
    });

    it('warns when a pull request has more files than were read', async () => {
      const { provider: p } = provider({
        recent: [pr(80, { title: 'Big (SHP-4103)' })],
        files: { 80: changed },
        filesTruncated: [80],
      });

      const context = await p.contextFor(ticket);

      expect(context.meta.status).toBe('found');
      expect(context.warnings?.join(' ')).toContain('more files than were read');
    });
  });
});
