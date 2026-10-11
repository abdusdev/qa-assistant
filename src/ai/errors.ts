export type AIErrorKind =
  | 'invalid_request'
  | 'unauthorized'
  | 'model_not_found'
  | 'rate_limited'
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

  constructor(kind: AIErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AIError';
    this.kind = kind;
    this.status = status;
  }
}
