import { describe, expect, it } from 'vitest';
import { classifyFile, rankFiles, relevanceOf, ticketTerms } from '../../../src/github/filter.js';
import { file } from './support.js';

describe('classifyFile', () => {
  it.each([
    'pnpm-lock.yaml',
    'package-lock.json',
    'services/orders/yarn.lock',
    'app_2/CHANGELOG.md',
    'dist/index.js',
    'app_2/node_modules/x/index.js',
    'src/__snapshots__/a.test.ts.snap',
    'public/logo.png',
    'public/icons/arrow.svg',
    'bundle.min.js',
    'src/api/client.generated.ts',
    '.github/workflows/ci.yml',
    'fonts/Inter.woff2',
  ])('treats %s as noise', (path) => {
    expect(classifyFile(path)).toBe('noise');
  });

  it('tells tests, docs, config and source apart', () => {
    expect(classifyFile('app_2/src/components/__tests__/Drawer.test.tsx')).toBe('test');
    expect(classifyFile('services/orders/src/a/b.spec.ts')).toBe('test');
    expect(classifyFile('cypress/e2e/ship.cy.ts')).toBe('test');
    expect(classifyFile('README.md')).toBe('docs');
    expect(classifyFile('docs/design.txt')).toBe('docs');
    expect(classifyFile('tsconfig.json')).toBe('config');
    expect(classifyFile('docker-compose.prod.yml')).toBe('config');
    expect(classifyFile('services/orders/src/shipment.service.ts')).toBe('source');
  });
});

describe('rankFiles', () => {
  it('puts source first, then tests, config and docs, and bigger changes first', () => {
    const ranked = rankFiles([
      file('docs/a.md'),
      file('a.config.json'),
      file('src/__tests__/a.test.ts', { additions: 50 }),
      file('src/small.ts', { additions: 1, deletions: 0 }),
      file('src/big.ts', { additions: 40, deletions: 10 }),
    ]);

    expect(ranked.map((f) => f.path)).toEqual([
      'src/big.ts',
      'src/small.ts',
      'src/__tests__/a.test.ts',
      'a.config.json',
      'docs/a.md',
    ]);
  });

  it('does not change the list it is given', () => {
    const files = [file('b.md'), file('a.ts')];

    rankFiles(files);

    expect(files.map((f) => f.path)).toEqual(['b.md', 'a.ts']);
  });
});

describe('ticketTerms', () => {
  it('keeps the longer, specific words of a ticket once each', () => {
    const terms = ticketTerms(
      'Invalidate the Ship To quote when the shipToAddress changes. Quote is stale; QUOTE again.',
    );

    expect(terms).toContain('invalidate');
    expect(terms).toContain('quote');
    expect(terms).toContain('address');
    expect(terms.filter((t) => t === 'quote')).toHaveLength(1);
  });

  it('leaves out common words, short words and numbers', () => {
    const terms = ticketTerms('When the user ships orders with 2024 items and the rate is set');

    expect(terms).not.toContain('when');
    expect(terms).not.toContain('user');
    expect(terms).not.toContain('2024');
    expect(terms).not.toContain('the');
  });

  it('is limited in length', () => {
    const many = Array.from(
      { length: 100 },
      (_, i) => `word${String.fromCharCode(97 + (i % 26))}x${i}`,
    ).join(' ');

    expect(ticketTerms(many, 10)).toHaveLength(10);
  });
});

describe('relevanceOf', () => {
  const terms = ['quote', 'invalidate', 'address'];

  it('counts a word in the path double and a word in the changed lines once', () => {
    const inPath = file('src/address/invalidateQuote.ts', { patch: '@@ -1 +1 @@\n+const a = 1' });
    const inLines = file('src/other.ts', { patch: '@@ -1 +1 @@\n+// the quote is cleared' });

    expect(relevanceOf(inPath, terms)).toBe(6);
    expect(relevanceOf(inLines, terms)).toBe(1);
  });

  it('ignores unchanged lines', () => {
    const unchanged = file('src/other.ts', {
      patch: '@@ -1 +1 @@\n the quote is here\n+const a = 1',
    });

    expect(relevanceOf(unchanged, terms)).toBe(0);
  });

  it('is capped and is zero without terms', () => {
    const many = file('src/quote/address/invalidate.ts');

    expect(relevanceOf(many, ['quote', 'address', 'invalidate', 'src'])).toBe(8);
    expect(relevanceOf(many, [])).toBe(0);
  });
});

describe('rankFiles with the words of a ticket', () => {
  it('puts a relevant test file before an unrelated source file', () => {
    const ranked = rankFiles(
      [
        file('src/billing/invoice.ts', { additions: 80 }),
        file('src/address/__tests__/invalidateQuote.test.ts', { additions: 5 }),
      ],
      ['quote', 'invalidate', 'address'],
    );

    expect(ranked[0]?.path).toBe('src/address/__tests__/invalidateQuote.test.ts');
  });

  it('puts a relevant source file before a bigger unrelated one', () => {
    const ranked = rankFiles(
      [
        file('src/billing/invoice.ts', { additions: 80 }),
        file('src/address/invalidateQuote.ts', { additions: 2 }),
      ],
      ['quote', 'invalidate'],
    );

    expect(ranked[0]?.path).toBe('src/address/invalidateQuote.ts');
  });

  it('is the same as before when there are no words', () => {
    const files = [file('docs/a.md'), file('src/a.ts')];

    expect(rankFiles(files).map((f) => f.path)).toEqual(['src/a.ts', 'docs/a.md']);
  });
});
