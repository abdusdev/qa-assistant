import type { ChangedFile } from './types.js';

export type FileKind = 'source' | 'test' | 'config' | 'docs' | 'noise';

const LOCKFILES =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|pubspec\.lock|[^/]+\.lock)$/;

const NOISE_PATTERNS: RegExp[] = [
  LOCKFILES,
  /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|\.vscode|\.idea)\//,
  /(^|\/)__snapshots__\//,
  /\.snap$/,
  /\.min\.(js|css)$/,
  /\.(map|log)$/,
  /(^|\/)(generated|__generated__)\//,
  /\.generated\./,
  /\.pb\.(go|ts|js)$/,
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|svg|pdf|zip|gz|tgz|tar|7z|rar|mp[34]|mov|woff2?|ttf|otf|eot|jar|exe|dll|so|dylib|bin|wasm)$/i,
  /(^|\/)CHANGELOG(\.[a-z]+)?$/i,
  /(^|\/)\.github\//,
];

const TEST_PATTERNS: RegExp[] = [
  /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|cypress|playwright)\//i,
  /\.(test|spec|cy|e2e)\.[a-z0-9]+$/i,
];

const DOC_PATTERNS: RegExp[] = [/\.(md|mdx|txt|rst)$/i, /(^|\/)docs?\//i];

const CONFIG_PATTERNS: RegExp[] = [
  /\.(json|ya?ml|toml|ini|cfg|conf)$/i,
  /(^|\/)(Dockerfile|docker-compose[^/]*|Makefile|\.[a-z]+rc(\.[a-z]+)?)$/i,
];

/** What a file is, so the most useful ones are shown first and the useless ones are left out. */
export function classifyFile(path: string): FileKind {
  if (NOISE_PATTERNS.some((pattern) => pattern.test(path))) return 'noise';
  if (TEST_PATTERNS.some((pattern) => pattern.test(path))) return 'test';
  if (DOC_PATTERNS.some((pattern) => pattern.test(path))) return 'docs';
  if (CONFIG_PATTERNS.some((pattern) => pattern.test(path))) return 'config';
  return 'source';
}

/** Higher is shown first. Tests rank high because they state the intended behaviour. */
const RANK: Record<FileKind, number> = { source: 4, test: 3, config: 2, docs: 1, noise: 0 };

const STOP_WORDS = new Set(
  (
    'that this with from have will when then than they them their there these those been being ' +
    'into onto over under after before while where which what whose should would could must ' +
    'does done also only same such each both more most some any all not but and the for are was ' +
    'were can may might user users order orders ticket expected actual result steps step shown ' +
    'show shows ship shipped shipping'
  ).split(' '),
);

/** The words of a ticket that point at code: longer words, not the common ones. */
export function ticketTerms(text: string, max = 40): string[] {
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word) && !/^[0-9]+$/.test(word));
  return [...new Set(words)].slice(0, max);
}

const wordsIn = (text: string) =>
  new Set(
    text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/**
 * How much a changed file has to do with the ticket: a ticket word in its path counts double,
 * one in its changed lines counts once. Capped, so one very wordy file cannot take over.
 */
export function relevanceOf(file: ChangedFile, terms: string[]): number {
  if (terms.length === 0) return 0;
  const inPath = wordsIn(file.path);
  const changed = (file.patch ?? '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') || line.startsWith('-'))
    .join(' ');
  const inLines = wordsIn(changed);
  let score = 0;
  for (const term of terms) {
    if (inPath.has(term)) score += 2;
    else if (inLines.has(term)) score += 1;
  }
  return Math.min(score, 8);
}

/**
 * Most useful first: the kind of file sets the base, and each point of relevance to the ticket
 * adds half a point, so a relevant test file can come before an unrelated source file.
 */
export function rankFiles(files: ChangedFile[], terms: string[] = []): ChangedFile[] {
  const score = (file: ChangedFile) =>
    RANK[classifyFile(file.path)] * 2 + relevanceOf(file, terms) * 0.5;
  return [...files].sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    const bySize = b.additions + b.deletions - (a.additions + a.deletions);
    return bySize !== 0 ? bySize : a.path.localeCompare(b.path);
  });
}
