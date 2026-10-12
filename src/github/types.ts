/** A pull request, as far as the list and search endpoints describe it. */
export interface PullRequest {
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  /** The branch the change was made on. Teams often put the ticket key in it. */
  headRef: string;
  baseRef: string;
  url: string;
  updatedAt: string;
  /** Only known after getPullRequest: the list and search endpoints do not return them. */
  changedFiles?: number;
  additions?: number;
  deletions?: number;
}

export type FileStatus =
  'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface ChangedFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** The unified diff. GitHub leaves it out for binary files and very large changes. */
  patch?: string;
  previousPath?: string;
}

export interface ChangedFiles {
  files: ChangedFile[];
  /** True when the pull request has more files than were read. */
  truncated: boolean;
}

export interface TreeEntry {
  path: string;
  size: number;
}

/** What the code context needs from GitHub. The real client and test fakes both provide it. */
export interface GitHubSource {
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  listPullRequestFiles(repo: string, number: number, maxFiles?: number): Promise<ChangedFiles>;
  /** Pull requests whose title or description mentions the term. */
  searchPullRequests(repo: string, term: string, limit?: number): Promise<PullRequest[]>;
  /** The most recently updated pull requests, newest first. */
  listRecentPullRequests(repo: string, pages?: number): Promise<PullRequest[]>;
}
