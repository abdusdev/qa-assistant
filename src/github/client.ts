import { z } from 'zod';
import { GitHubError } from './errors.js';
import type {
  ChangedFile,
  ChangedFiles,
  FileStatus,
  GitHubSource,
  PullRequest,
  TreeEntry,
} from './types.js';

export interface GitHubClientConfig {
  /** A read-only, fine-grained token that can read contents and pull requests of the listed repos. */
  token: string;
  /** Replaceable for GitHub Enterprise. */
  apiUrl?: string;
}

export interface GitHubClientOptions {
  /** Replaceable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Retries after the first attempt, for rate limits, 5xx and network errors. */
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_RETRY_AFTER_MS = 30_000;
const PAGE_SIZE = 100;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const prSchema = z.looseObject({
  number: z.number(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  state: z.string(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  html_url: z.string().nullish(),
  updated_at: z.string().nullish(),
  head: z.looseObject({ ref: z.string().nullish() }).nullish(),
  base: z.looseObject({ ref: z.string().nullish() }).nullish(),
  changed_files: z.number().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
});

const fileSchema = z.looseObject({
  filename: z.string(),
  status: z.string(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  patch: z.string().nullish(),
  previous_filename: z.string().nullish(),
});

const searchSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      number: z.number(),
      title: z.string().nullish(),
      body: z.string().nullish(),
      state: z.string(),
      html_url: z.string().nullish(),
      updated_at: z.string().nullish(),
      pull_request: z.looseObject({ merged_at: z.string().nullish() }).nullish(),
    }),
  ),
});

const KNOWN_STATUSES: FileStatus[] = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'changed',
  'unchanged',
];

export function assertRepo(repo: string): string {
  if (!REPO_PATTERN.test(repo)) {
    throw new GitHubError(
      'invalid_input',
      `"${repo.slice(0, 80)}" is not a repository in the form owner/name.`,
    );
  }
  return repo;
}

export class GitHubClient implements GitHubSource {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: GitHubClientConfig, options: GitHubClientOptions = {}) {
    this.token = config.token;
    this.apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Verifies the token and says which of the repositories it can read. */
  async checkConnection(
    repos: string[],
  ): Promise<{ login: string; repos: { repo: string; accessible: boolean }[] }> {
    const me = z
      .looseObject({ login: z.string() })
      .safeParse(await this.json('/user', 'your account'));
    if (!me.success) {
      throw new GitHubError(
        'invalid_response',
        'GitHub returned an unexpected answer for "who am I".',
      );
    }

    const results: { repo: string; accessible: boolean }[] = [];
    for (const repo of repos) {
      try {
        await this.json(`/repos/${assertRepo(repo)}`, repo);
        results.push({ repo, accessible: true });
      } catch (error) {
        if (
          error instanceof GitHubError &&
          (error.kind === 'not_found' || error.kind === 'forbidden')
        ) {
          results.push({ repo, accessible: false });
        } else {
          throw error;
        }
      }
    }
    return { login: me.data.login, repos: results };
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    const body = await this.json(
      `/repos/${assertRepo(repo)}/pulls/${this.positive(number)}`,
      `${repo}#${number}`,
    );
    return this.toPullRequest(body, repo);
  }

  async listPullRequestFiles(repo: string, number: number, maxFiles = 300): Promise<ChangedFiles> {
    assertRepo(repo);
    this.positive(number);
    const files: ChangedFile[] = [];
    let truncated = false;

    for (let page = 1; ; page++) {
      const body = await this.json(
        `/repos/${repo}/pulls/${number}/files?per_page=${PAGE_SIZE}&page=${page}`,
        `${repo}#${number}`,
      );
      const parsed = z.array(fileSchema).safeParse(body);
      if (!parsed.success) {
        throw new GitHubError(
          'invalid_response',
          `GitHub returned an unexpected file list for ${repo}#${number}.`,
        );
      }

      for (const file of parsed.data) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push({
          path: file.filename,
          status: (KNOWN_STATUSES as string[]).includes(file.status)
            ? (file.status as FileStatus)
            : 'changed',
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          ...(file.patch != null && { patch: file.patch }),
          ...(file.previous_filename != null && { previousPath: file.previous_filename }),
        });
      }
      if (truncated || parsed.data.length < PAGE_SIZE) break;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
    return { files, truncated };
  }

  async searchPullRequests(repo: string, term: string, limit = 10): Promise<PullRequest[]> {
    assertRepo(repo);
    const cleaned = term.replace(/[^A-Za-z0-9_.-]/g, ' ').trim();
    if (cleaned === '') {
      throw new GitHubError('invalid_input', 'A search term is needed to look for pull requests.');
    }
    const query = new URLSearchParams({
      q: `repo:${repo} is:pr ${cleaned}`,
      per_page: String(Math.min(Math.max(1, limit), PAGE_SIZE)),
    });
    const parsed = searchSchema.safeParse(await this.json(`/search/issues?${query}`, 'the search'));
    if (!parsed.success) {
      throw new GitHubError('invalid_response', 'GitHub returned an unexpected search response.');
    }

    return parsed.data.items.map((item) => ({
      repo,
      number: item.number,
      title: item.title ?? '',
      body: item.body ?? '',
      state: item.state === 'open' ? 'open' : 'closed',
      merged: Boolean(item.pull_request?.merged_at),
      headRef: '',
      baseRef: '',
      url: item.html_url ?? `https://github.com/${repo}/pull/${item.number}`,
      updatedAt: item.updated_at ?? '',
    }));
  }

  async listRecentPullRequests(repo: string, pages = 3): Promise<PullRequest[]> {
    assertRepo(repo);
    const found: PullRequest[] = [];
    for (let page = 1; page <= Math.max(1, pages); page++) {
      const body = await this.json(
        `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
        repo,
      );
      const parsed = z.array(z.unknown()).safeParse(body);
      if (!parsed.success) {
        throw new GitHubError(
          'invalid_response',
          `GitHub returned an unexpected list for ${repo}.`,
        );
      }
      found.push(...parsed.data.map((item) => this.toPullRequest(item, repo)));
      if (parsed.data.length < PAGE_SIZE) break;
    }
    return found;
  }

  /** Every file path in a branch with its size, for the codebase digest. */
  async listFiles(
    repo: string,
    ref: string,
  ): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    assertRepo(repo);
    const body = await this.json(
      `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      `${repo}@${ref}`,
    );
    const parsed = z
      .looseObject({
        tree: z.array(
          z.looseObject({ path: z.string(), type: z.string(), size: z.number().nullish() }),
        ),
        truncated: z.boolean().nullish(),
      })
      .safeParse(body);
    if (!parsed.success) {
      throw new GitHubError(
        'invalid_response',
        `GitHub returned an unexpected file tree for ${repo}.`,
      );
    }
    return {
      entries: parsed.data.tree
        .filter((entry) => entry.type === 'blob')
        .map((entry) => ({ path: entry.path, size: entry.size ?? 0 })),
      truncated: parsed.data.truncated === true,
    };
  }

  /** The text of one file. Undefined when it does not exist on that branch. */
  async getFile(repo: string, path: string, ref: string): Promise<string | undefined> {
    assertRepo(repo);
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    try {
      return await this.request(
        `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        `${repo}:${path}`,
        'application/vnd.github.raw+json',
      );
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not_found') return undefined;
      throw error;
    }
  }

  private positive(number: number): number {
    if (!Number.isInteger(number) || number < 1) {
      throw new GitHubError('invalid_input', `"${number}" is not a pull request number.`);
    }
    return number;
  }

  private toPullRequest(body: unknown, repo: string): PullRequest {
    const parsed = prSchema.safeParse(body);
    if (!parsed.success) {
      throw new GitHubError(
        'invalid_response',
        `GitHub returned an unexpected pull request for ${repo}.`,
      );
    }
    const pr = parsed.data;
    return {
      repo,
      number: pr.number,
      title: pr.title ?? '',
      body: pr.body ?? '',
      state: pr.state === 'open' ? 'open' : 'closed',
      merged: pr.merged === true || Boolean(pr.merged_at),
      headRef: pr.head?.ref ?? '',
      baseRef: pr.base?.ref ?? '',
      url: pr.html_url ?? `https://github.com/${repo}/pull/${pr.number}`,
      updatedAt: pr.updated_at ?? '',
      ...(pr.changed_files != null && { changedFiles: pr.changed_files }),
      ...(pr.additions != null && { additions: pr.additions }),
      ...(pr.deletions != null && { deletions: pr.deletions }),
    };
  }

  private async json(path: string, what: string): Promise<unknown> {
    const text = await this.request(path, what, 'application/vnd.github+json');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GitHubError(
        'invalid_response',
        `GitHub returned a response for ${what} that is not JSON.`,
      );
    }
  }

  private async request(path: string, what: string, accept: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.maxRetries;

      let response: Response;
      try {
        response = await this.fetchFn(`${this.apiUrl}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: accept,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'qa-assistant',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (canRetry) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw new GitHubError(
          'network',
          `Could not reach GitHub: ${this.describeNetworkError(cause)}`,
        );
      }

      if (response.ok) return response.text();

      const limited = await this.isRateLimited(response);
      const retryable = limited === 'secondary' || response.status >= 500;
      if (retryable && canRetry) {
        await this.sleep(this.retryDelay(response, attempt));
        continue;
      }
      throw await this.errorFor(response, what, limited !== undefined);
    }
  }

  /**
   * GitHub answers a limit with 429 or 403. "primary" means the hourly allowance is used up
   * (waiting a few seconds will not help); "secondary" is a short burst limit that retrying fixes.
   */
  private async isRateLimited(response: Response): Promise<'primary' | 'secondary' | undefined> {
    if (response.status === 429) {
      return response.headers.get('x-ratelimit-remaining') === '0' ? 'primary' : 'secondary';
    }
    if (response.status !== 403) return undefined;
    if (response.headers.get('x-ratelimit-remaining') === '0') return 'primary';
    const message = (await this.readMessage(response.clone())).toLowerCase();
    if (message.includes('secondary rate limit') || message.includes('abuse')) return 'secondary';
    if (message.includes('rate limit')) return 'primary';
    return undefined;
  }

  private retryDelay(response: Response, attempt: number): number {
    const header = response.headers.get('retry-after');
    const seconds = Number(header);
    if (header !== null && Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
    return this.baseDelayMs * 2 ** attempt;
  }

  private describeNetworkError(cause: unknown): string {
    if (cause instanceof Error) {
      if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
        return 'the request timed out';
      }
      return this.redact(cause.message).slice(0, 200);
    }
    return 'unknown network error';
  }

  private async errorFor(
    response: Response,
    what: string,
    rateLimited: boolean,
  ): Promise<GitHubError> {
    const status = response.status;
    if (rateLimited) {
      return new GitHubError(
        'rate_limited',
        `GitHub rate limit reached (${status}). Try again later.`,
        status,
      );
    }
    const detail = this.redact(await this.readMessage(response)).slice(0, 200);
    const suffix = detail ? ` ${detail}` : '';

    if (status === 401) {
      return new GitHubError(
        'unauthorized',
        'GitHub rejected the token (401). Check GITHUB_TOKEN: it may be wrong or expired.',
        status,
      );
    }
    if (status === 403) {
      return new GitHubError(
        'forbidden',
        `GitHub denied access to ${what} (403). The token needs read access to the repository's ` +
          `contents and pull requests.${suffix}`,
        status,
      );
    }
    if (status === 404) {
      return new GitHubError(
        'not_found',
        `${what} was not found, or the token cannot see it (404).`,
        status,
      );
    }
    if (status >= 500) {
      return new GitHubError('server_error', `GitHub is unavailable (${status}).${suffix}`, status);
    }
    return new GitHubError(
      'bad_request',
      `GitHub rejected the request for ${what} (${status}).${suffix}`,
      status,
    );
  }

  private async readMessage(response: Response): Promise<string> {
    try {
      const data: unknown = await response.json();
      const message = (data as { message?: unknown })?.message;
      return typeof message === 'string' ? message : '';
    } catch {
      return '';
    }
  }

  private redact(text: string): string {
    return this.token ? text.split(this.token).join('[redacted]') : text;
  }
}
