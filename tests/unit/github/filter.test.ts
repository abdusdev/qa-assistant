import { describe, expect, it } from 'vitest';
import { classifyFile, rankFiles } from '../../../src/github/filter.js';
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
