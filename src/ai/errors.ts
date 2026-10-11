export type AIErrorKind =
  | 'invalid_request'
  | 'unauthorized'
  | 'model_not_found'
  | 'rate_limited'
  /** A daily limit is used up. Waiting a minute does not help: use another model or wait for the reset. */
  | 'quota_exhausted'
  | 'blocked'
  | 'server_error'
  | 'network'
  | 'invalid_response';

/**
 * Typed error for every AI failure. Messages are safe to log:
 * they never contain the API key or the prompt.
 */
export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly status: number | undefined;
  /** For quota and rate-limit errors: how long until the limit resets, when the provider says. */
  readonly retryAfterMs: number | undefined;

  constructor(kind: AIErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'AIError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
