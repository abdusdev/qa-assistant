import pino, { type DestinationStream, type Logger } from 'pino';
import { redactSecrets } from '../github/redact.js';

export type { Logger };

export const REMOVED = '[removed]';

/** Names whose value is a credential. Matched in any letter case, wherever they sit in an object. */
const SECRET_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'apitoken',
  'api_token',
  'apikey',
  'api_key',
  'password',
  'secret',
  'x-goog-api-key',
  'x-api-key',
]);

/** Names that hold ticket, case or code text. Never logged: a key and a count are enough. */
const CONTENT_NAMES = new Set([
  'description',
  'comments',
  'acceptancecriteria',
  'body',
  'prompt',
  'system',
  'steps',
  'expected',
  'preconditions',
  'assumptions',
  'codechanges',
  'modulenotes',
  'productknowledge',
  'pastcases',
  'diff',
  'patch',
]);

const MAX_DEPTH = 6;

/** Removes secret-looking text from a string. */
export const scrubText = (text: string): string => redactSecrets(text).text;

/**
 * Makes a value safe to log: values under secret or content names are removed, error messages and
 * strings are scrubbed for token-shaped text, and depth is limited.
 */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[too deep]';

  if (value instanceof Error) {
    return {
      type: value.name,
      message: scrubText(value.message),
      ...(value.stack && { stack: scrubText(value.stack) }),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubValue(item, depth + 1));

  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (SECRET_NAMES.has(name) || CONTENT_NAMES.has(name)) clean[key] = REMOVED;
    else clean[key] = scrubValue(item, depth + 1);
  }
  return clean;
}

export interface LoggerOptions {
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Where lines are written. Defaults to standard output. Replaceable in tests. */
  destination?: DestinationStream;
}

/**
 * The server's logger: one JSON line per event. Whatever is logged is scrubbed first, so a token
 * or the text of a ticket cannot reach the log by accident.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      name: 'qa-assistant',
      level: options.level ?? 'info',
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        log: (object) => scrubValue(object) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const cleaned = args.map((arg) =>
            typeof arg === 'string' ? scrubText(arg) : scrubValue(arg),
          );
          return method.apply(this, cleaned as Parameters<typeof method>);
        },
      },
    },
    options.destination,
  );
}
