import { MAX_CODE_CHARS, type PromptContext } from '../ai/prompt.js';
import type { Ticket } from '../jira/ticket.js';
import { classifyFile, rankFiles, ticketTerms } from './filter.js';
import { GitHubError } from './errors.js';
import { isSensitivePath, redactSecrets } from './redact.js';
import type { ChangedFile, GitHubSource, PullRequest } from './types.js';

export type MatchedIn = 'title' | 'branch' | 'body';

export interface PullRequestMatch {
  pr: PullRequest;
  matchedIn: MatchedIn[];
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Keys of other tickets mentioned in a text, to recognise release and umbrella pull requests. */
function otherKeys(text: string, key: string): number {
  const found = new Set(
    (text.match(/(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]+-\d+(?![0-9])/g) ?? []).map((k) =>
      k.toUpperCase(),
    ),
  );
  found.delete(key.toUpperCase());
  return found.size;
}

/** Does this pull request belong to the ticket? Looks in the title, the branch and the description. */
export function matchPullRequest(pr: PullRequest, key: string): PullRequestMatch | undefined {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegex(key)}(?![0-9])`, 'i');
  const matchedIn: MatchedIn[] = [];
  if (pattern.test(pr.title)) matchedIn.push('title');
  if (pattern.test(pr.headRef)) matchedIn.push('branch');
  if (pattern.test(pr.body)) matchedIn.push('body');
  return matchedIn.length > 0 ? { pr, matchedIn } : undefined;
}

export interface CodeContextOptions {
  /** owner/name of every repository to look in. */
  repos: string[];
  /** Most pull requests used for one ticket. Default 3. */
  maxPullRequests?: number;
  /** Size limit for all code text of one ticket. Default is the prompt's limit. */
  maxChars?: number;
  /** Pages of recent pull requests scanned for the key in branch names. Default 3. */
  recentPages?: number;
  /** Most files read per pull request. Default 300. */
  maxFiles?: number;
  /** A pull request that only mentions the key in its description is used only if it mentions few tickets. */
  maxKeysInBodyMatch?: number;
}

export interface CodePullRequestMeta {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'merged' | 'closed';
  matchedIn: MatchedIn[];
  files: number;
  filesShown: number;
  /** The files whose changed lines were included, in the order shown. */
  shownFiles: string[];
  filesLeftOut: number;
  secretsRedacted: number;
}

/** What code was found for a ticket. For QA and the logs: never put into the prompt. */
export interface CodeMeta {
  status: 'found' | 'none' | 'unavailable';
  pullRequests: CodePullRequestMeta[];
  note?: string;
}

export interface CodeContext extends Pick<PromptContext, 'codeChanges' | 'warnings'> {
  meta: CodeMeta;
}

const PER_FILE_CHARS = 1_500;
const MAX_LISTED_FILES = 25;
const MAX_BODY_CHARS = 1_200;
const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  renamed: 'R',
  copied: 'C',
  changed: 'M',
  unchanged: '-',
};

function describeState(pr: PullRequest): CodePullRequestMeta['state'] {
  if (pr.merged) return 'merged';
  return pr.state === 'open' ? 'open' : 'closed';
}

/** Only what changed: hunk headers, added and removed lines. Unchanged context lines are dropped. */
export function compressPatch(patch: string): string {
  return patch
    .split(/\r?\n/)
    .filter((line) => line.startsWith('@@') || line.startsWith('+') || line.startsWith('-'))
    .filter((line) => line.replace(/^[+-]/, '').trim() !== '')
    .join('\n');
}

/** Shortens text at the end of a line, so a changed line is never shown half. */
const cap = (text: string, max: number) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max));
  const lastLine = cut.lastIndexOf('\n');
  return `${(lastLine > max / 2 ? cut.slice(0, lastLine) : cut).trimEnd()}\n[... cut]`;
};

function tidyDescription(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PullRequestDigest {
  text: string;
  meta: Omit<CodePullRequestMeta, 'matchedIn'>;
}

export interface DigestOptions {
  /** Words of the ticket, used to put the most relevant files first. */
  terms?: string[];
}

/**
 * Turns one pull request into compact text for the prompt: the title, a short description, the list
 * of changed files and the changed lines of the most useful ones, within a size limit. Secrets are
 * replaced and files that must not be read are never included.
 */
export function buildPullRequestDigest(
  pr: PullRequest,
  files: ChangedFile[],
  maxChars: number,
  options: DigestOptions = {},
): PullRequestDigest {
  let secrets = 0;
  const clean = (value: string): string => {
    const result = redactSecrets(value);
    secrets += result.count;
    return result.text;
  };

  const title = clean(pr.title);
  const usable = files.filter((f) => !isSensitivePath(f.path) && classifyFile(f.path) !== 'noise');
  const ranked = rankFiles(usable, options.terms);
  const leftOut = files.length - usable.length;

  const totals =
    pr.additions !== undefined && pr.deletions !== undefined
      ? ` | +${pr.additions} -${pr.deletions}`
      : '';
  const lines: string[] = [
    `Pull request ${pr.repo}#${pr.number} (${describeState(pr)}): ${title}`,
    `Branch: ${clean(pr.headRef || 'unknown')}${pr.baseRef ? ` -> ${pr.baseRef}` : ''} | ` +
      `${pr.changedFiles ?? files.length} files${totals}`,
  ];

  const description = cap(clean(tidyDescription(pr.body)), MAX_BODY_CHARS);
  if (description !== '') lines.push('Description:', description);

  lines.push(
    `Files (${ranked.length}${leftOut > 0 ? `, ${leftOut} more left out as generated, binary or private` : ''}):`,
  );
  for (const file of ranked.slice(0, MAX_LISTED_FILES)) {
    lines.push(
      `${STATUS_LETTER[file.status]} ${file.path} (+${file.additions} -${file.deletions})`,
    );
  }
  if (ranked.length > MAX_LISTED_FILES) {
    lines.push(`... and ${ranked.length - MAX_LISTED_FILES} more files`);
  }

  // Changed lines of the best files, until the size limit is reached.
  const header = lines.join('\n');
  let remaining = maxChars - header.length - 40;
  const sections: string[] = [];
  const shownFiles: string[] = [];
  let shown = 0;

  for (const file of ranked) {
    if (remaining < 200) break;
    if (!file.patch) continue;
    const changes = compressPatch(file.patch);
    if (changes.trim() === '') continue;

    const body = cap(clean(changes), Math.min(PER_FILE_CHARS, remaining - file.path.length - 10));
    const section = `### ${file.path}\n${body}`;
    if (section.length > remaining) break;
    sections.push(section);
    shownFiles.push(file.path);
    remaining -= section.length + 2;
    shown++;
  }

  const text = [
    header,
    ...(sections.length > 0
      ? ['Changed lines (- removed, + added; unchanged lines are left out):', ...sections]
      : []),
  ].join('\n');

  return {
    text: cap(text, maxChars),
    meta: {
      repo: pr.repo,
      number: pr.number,
      title: title,
      url: pr.url,
      state: describeState(pr),
      files: files.length,
      filesShown: shown,
      shownFiles,
      filesLeftOut: leftOut,
      secretsRedacted: secrets,
    },
  };
}

const STOPPING_KINDS = new Set(['unauthorized', 'rate_limited']);

/**
 * Finds the pull requests of a ticket and turns their changes into the "code changes" context.
 * A ticket with no pull request, or a GitHub problem, never fails: the result says what happened
 * and the ticket is generated from its own text.
 */
export class CodeContextProvider {
  private readonly recent = new Map<string, Promise<PullRequest[]>>();
  private stopped: string | undefined;

  constructor(
    private readonly source: GitHubSource,
    private readonly options: CodeContextOptions,
  ) {}

  async contextFor(ticket: Ticket): Promise<CodeContext> {
    if (this.stopped) {
      return {
        meta: { status: 'unavailable', pullRequests: [], note: this.stopped },
      };
    }
    if (this.options.repos.length === 0) {
      return {
        meta: { status: 'unavailable', pullRequests: [], note: 'No repositories are configured.' },
        warnings: ['Code context is on, but GITHUB_REPOS is empty, so no code was looked up.'],
      };
    }

    const warnings: string[] = [];
    const matches = new Map<string, PullRequestMatch>();
    const add = (match: PullRequestMatch | undefined) => {
      if (!match) return;
      const id = `${match.pr.repo}#${match.pr.number}`;
      const known = matches.get(id);
      matches.set(
        id,
        known
          ? { pr: known.pr.headRef ? known.pr : match.pr, matchedIn: merge(known, match) }
          : match,
      );
    };

    for (const repo of this.options.repos) {
      try {
        const recent = await this.recentFor(repo);
        for (const pr of recent) add(matchPullRequest(pr, ticket.key));

        const hasStrong = [...matches.values()].some(
          (m) => m.pr.repo === repo && m.matchedIn.some((where) => where !== 'body'),
        );
        if (!hasStrong) {
          for (const pr of await this.source.searchPullRequests(repo, ticket.key)) {
            add(matchPullRequest(pr, ticket.key));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof GitHubError && STOPPING_KINDS.has(error.kind)) {
          this.stopped = `GitHub is not available for this run: ${message}`;
          return {
            meta: { status: 'unavailable', pullRequests: [], note: this.stopped },
            warnings: [`${ticket.key}: ${this.stopped} Cases are written from the ticket alone.`],
          };
        }
        warnings.push(`${ticket.key}: could not look in ${repo}: ${message}`);
      }
    }

    const chosen = this.choose([...matches.values()], ticket.key);
    if (chosen.length === 0) {
      return {
        meta: { status: 'none', pullRequests: [] },
        warnings: [
          ...warnings,
          `${ticket.key}: no pull request mentions this ticket, so the cases are written from the ` +
            'ticket alone.',
        ],
      };
    }

    const perPr = Math.floor((this.options.maxChars ?? MAX_CODE_CHARS) / chosen.length);
    const terms = ticketTerms(
      [ticket.summary, ticket.description, ticket.acceptanceCriteria ?? ''].join(' '),
    );
    const digests: string[] = [];
    const pullRequests: CodePullRequestMeta[] = [];

    for (const match of chosen) {
      try {
        const [full, changed] = await Promise.all([
          this.source.getPullRequest(match.pr.repo, match.pr.number),
          this.source.listPullRequestFiles(
            match.pr.repo,
            match.pr.number,
            this.options.maxFiles ?? 300,
          ),
        ]);
        const digest = buildPullRequestDigest(full, changed.files, perPr, { terms });
        digests.push(digest.text);
        pullRequests.push({ ...digest.meta, matchedIn: match.matchedIn });
        if (changed.truncated) {
          warnings.push(
            `${ticket.key}: ${match.pr.repo}#${match.pr.number} has more files than were read.`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof GitHubError && STOPPING_KINDS.has(error.kind)) {
          this.stopped = `GitHub is not available for this run: ${message}`;
        }
        warnings.push(
          `${ticket.key}: could not read ${match.pr.repo}#${match.pr.number}: ${message}`,
        );
      }
    }

    if (digests.length === 0) {
      return { meta: { status: 'unavailable', pullRequests: [] }, warnings };
    }

    return {
      codeChanges: digests.join('\n\n---\n\n'),
      meta: { status: 'found', pullRequests },
      ...(warnings.length > 0 && { warnings }),
    };
  }

  private recentFor(repo: string): Promise<PullRequest[]> {
    let pending = this.recent.get(repo);
    if (!pending) {
      pending = this.source.listRecentPullRequests(repo, this.options.recentPages ?? 3);
      this.recent.set(repo, pending);
      // A failed lookup is tried again for the next ticket instead of being remembered.
      pending.catch(() => this.recent.delete(repo));
    }
    return pending;
  }

  /**
   * Pull requests named in the title or branch come first. One that only mentions the key in its
   * description is used only when there is nothing better and it does not list many tickets (a
   * release pull request would otherwise bring in unrelated changes).
   */
  private choose(matches: PullRequestMatch[], key: string): PullRequestMatch[] {
    const strong = matches.filter((m) => m.matchedIn.some((where) => where !== 'body'));
    const pool =
      strong.length > 0
        ? strong
        : matches.filter(
            (m) =>
              otherKeys(`${m.pr.title}\n${m.pr.body}`, key) <=
              (this.options.maxKeysInBodyMatch ?? 3),
          );

    return pool
      .sort(
        (a, b) =>
          Number(b.pr.merged) - Number(a.pr.merged) ||
          b.pr.updatedAt.localeCompare(a.pr.updatedAt) ||
          a.pr.number - b.pr.number,
      )
      .slice(0, this.options.maxPullRequests ?? 3);
  }
}

function merge(a: PullRequestMatch, b: PullRequestMatch): MatchedIn[] {
  return [...new Set([...a.matchedIn, ...b.matchedIn])];
}
