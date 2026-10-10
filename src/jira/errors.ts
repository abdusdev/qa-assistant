export type JiraErrorKind =
  | 'invalid_key'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'invalid_response';

/**
 * Typed error for every Jira failure. Messages are safe to log:
 * they never contain the API token or the Authorization header.
 */
export class JiraError extends Error {
  readonly kind: JiraErrorKind;
  readonly status: number | undefined;

  constructor(kind: JiraErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'JiraError';
    this.kind = kind;
    this.status = status;
  }
}
