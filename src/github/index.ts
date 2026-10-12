export { GitHubClient, assertRepo } from './client.js';
export type { GitHubClientConfig, GitHubClientOptions } from './client.js';
export {
  CodeContextProvider,
  buildPullRequestDigest,
  compressPatch,
  matchPullRequest,
} from './code-context.js';
export type {
  CodeContext,
  CodeContextOptions,
  CodeMeta,
  CodePullRequestMeta,
  MatchedIn,
  PullRequestDigest,
  PullRequestMatch,
} from './code-context.js';
export {
  buildDigestPrompt,
  generateDigest,
  renderDigestNote,
  selectDigestFiles,
} from './digest.js';
export type {
  DigestFile,
  DigestRequest,
  DigestResult,
  DigestSource,
  FileChoice,
  RenderInput,
  SelectOptions,
} from './digest.js';
export { GitHubError } from './errors.js';
export type { GitHubErrorKind } from './errors.js';
export { classifyFile, rankFiles } from './filter.js';
export { decideCodeContext } from './settings.js';
export type { CodeContextDecision, CodeContextRequest } from './settings.js';
export type { FileKind } from './filter.js';
export { REDACTED, isSensitivePath, redactSecrets } from './redact.js';
export type { RedactionResult } from './redact.js';
export type {
  ChangedFile,
  ChangedFiles,
  FileStatus,
  GitHubSource,
  PullRequest,
  TreeEntry,
} from './types.js';
