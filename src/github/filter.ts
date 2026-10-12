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

export function rankFiles(files: ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => {
    const byKind = RANK[classifyFile(b.path)] - RANK[classifyFile(a.path)];
    if (byKind !== 0) return byKind;
    const bySize = b.additions + b.deletions - (a.additions + a.deletions);
    return bySize !== 0 ? bySize : a.path.localeCompare(b.path);
  });
}
