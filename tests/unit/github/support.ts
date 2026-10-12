import { GitHubError } from '../../../src/github/errors.js';
import type {
  ChangedFile,
  ChangedFiles,
  GitHubSource,
  PullRequest,
} from '../../../src/github/types.js';

export const REPO = 'acme/shop';

export const pr = (number: number, overrides: Partial<PullRequest> = {}): PullRequest => ({
  repo: REPO,
  number,
  title: `Change number ${number}`,
  body: '',
  state: 'closed',
  merged: true,
  headRef: `feature/change-${number}`,
  baseRef: 'develop',
  url: `https://github.com/${REPO}/pull/${number}`,
  updatedAt: `2026-10-${String(10 + (number % 15)).padStart(2, '0')}T10:00:00Z`,
  ...overrides,
});

export const file = (path: string, overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'modified',
  additions: 3,
  deletions: 1,
  patch: '@@ -1,3 +1,5 @@ function x() {\n unchanged line\n-old line\n+new line\n+another new line',
  ...overrides,
});

export interface FakeGitHubOptions {
  /** Pull requests returned by the "recent" listing. */
  recent?: PullRequest[];
  /** Pull requests returned by the search. */
  search?: PullRequest[];
  /** Files per pull request number. */
  files?: Record<number, ChangedFile[]>;
  /** Full details per number. Defaults to the pull request from the lists. */
  details?: Record<number, PullRequest>;
  filesTruncated?: number[];
  /** Calls to these methods throw this error. */
  fail?: Partial<
    Record<'recent' | 'search' | 'details' | 'files', GitHubError | Record<number, GitHubError>>
  >;
}

export interface FakeGitHub extends GitHubSource {
  readonly calls: {
    recent: string[];
    search: string[];
    details: number[];
    files: number[];
  };
}

/** A GitHub stand-in that counts calls, so tests can see what was looked up and how often. */
export function fakeGitHub(options: FakeGitHubOptions = {}): FakeGitHub {
  const calls: FakeGitHub['calls'] = { recent: [], search: [], details: [], files: [] };

  const failure = (
    key: 'recent' | 'search' | 'details' | 'files',
    number?: number,
  ): GitHubError | undefined => {
    const entry = options.fail?.[key];
    if (!entry) return undefined;
    if (entry instanceof GitHubError) return entry;
    return number === undefined ? undefined : entry[number];
  };

  const known = () => [...(options.recent ?? []), ...(options.search ?? [])];

  return {
    calls,
    async listRecentPullRequests(repo) {
      calls.recent.push(repo);
      const error = failure('recent');
      if (error) throw error;
      return options.recent ?? [];
    },
    async searchPullRequests(repo, term) {
      calls.search.push(`${repo}:${term}`);
      const error = failure('search');
      if (error) throw error;
      return options.search ?? [];
    },
    async getPullRequest(_repo, number) {
      calls.details.push(number);
      const error = failure('details', number) ?? failure('details');
      if (error) throw error;
      const found = options.details?.[number] ?? known().find((p) => p.number === number);
      if (!found) throw new GitHubError('not_found', `#${number} was not found`, 404);
      return found;
    },
    async listPullRequestFiles(_repo, number): Promise<ChangedFiles> {
      calls.files.push(number);
      const error = failure('files', number) ?? failure('files');
      if (error) throw error;
      return {
        files: options.files?.[number] ?? [],
        truncated: options.filesTruncated?.includes(number) ?? false,
      };
    },
  };
}
