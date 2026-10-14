import type express from 'express';

export interface SecurityOptions {
  /** Tell browsers to use HTTPS only. Turn on only when the server is reached over HTTPS. */
  hsts?: boolean;
}

/**
 * The page and the API are served by one origin and load nothing from elsewhere, so the policy can
 * be strict: only this origin may supply scripts, styles, images and connections.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers that make browsers treat the page more safely. Sent on every answer. */
export function securityHeaders(options: SecurityOptions = {}): express.RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (options.hsts) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}
