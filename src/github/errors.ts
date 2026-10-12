export type GitHubErrorKind =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'bad_request'
  | 'server_error'
  | 'network'
  | 'invalid_response';

/**
 * Typed error for every GitHub failure. Messages are safe to log:
 * they never contain the token or the Authorization header.
 */
export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status: number | undefined;

  constructor(kind: GitHubErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
  }
}
