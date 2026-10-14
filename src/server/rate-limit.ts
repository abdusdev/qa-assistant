import type express from 'express';

export interface RateLimitOptions {
  /** Length of one window. */
  windowMs: number;
  /** Requests allowed per key in one window. */
  max: number;
  /** Who is counted. Defaults to the bearer token when one is sent, otherwise the address. */
  key?: (req: express.Request) => string;
  /** Replaceable in tests. */
  now?: () => number;
  /** What the 429 answer says. */
  message?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Counts requests in fixed windows. Held in memory: it resets when the server restarts. */
export function rateLimit(options: RateLimitOptions): express.RequestHandler {
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();
  const keyOf =
    options.key ??
    ((req: express.Request) => {
      const auth = req.header('authorization');
      return auth?.startsWith('Bearer ') ? `token:${auth.slice(7)}` : `ip:${req.ip ?? 'unknown'}`;
    });

  const sweep = (at: number) => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  };

  return (req, res, next) => {
    const at = now();
    if (buckets.size > 10_000) sweep(at);

    const key = keyOf(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= at) {
      bucket = { count: 0, resetAt: at + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, options.max - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - at) / 1000));
    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (bucket.count > options.max) {
      res.setHeader('Retry-After', String(resetSeconds));
      res.status(429).json({
        error: {
          code: 'rate_limited',
          message:
            options.message ??
            `Too many requests. Try again in ${resetSeconds} second${resetSeconds === 1 ? '' : 's'}.`,
        },
      });
      return;
    }
    next();
  };
}
