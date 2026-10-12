export const REDACTED = '[REDACTED]';

/** Files whose content must never be read or sent, whatever they contain. */
const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)[^/]*\.env(\.[^/]*)?\.json$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(secrets?|credentials?)(\/|\.|$)/i,
  /\.tfstate(\.backup)?$/i,
  /\.tfvars$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Words that, as a name, mean the value next to them is a secret. */
const SECRET_NAME =
  '(?:pass(?:word|wd|phrase)?|pwd|secret(?:[_-]?key)?|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|' +
  'client[_-]?secret|authorization|auth[_-]?(?:token|key)|credentials?|signing[_-]?key|encryption[_-]?key)';

interface Rule {
  pattern: RegExp;
  /** Replacement text. Group references are allowed. */
  replace: string;
}

const RULES: Rule[] = [
  // Whole private key blocks, which span several lines of a diff.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: REDACTED,
  },
  // Well-known token formats.
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: REDACTED },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED },
  { pattern: /\bATATT[A-Za-z0-9_=-]{20,}/g, replace: REDACTED },
  { pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // Authorization headers.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: `$1 ${REDACTED}` },
  // user:password@host inside a URL.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/'"]+:[^\s@/'"]+@/gi, replace: `$1${REDACTED}@` },
  // name = "value" and name: 'value' in code and JSON. Only quoted literals, so a type such as
  // `token: string` is left alone.
  {
    pattern: new RegExp(
      `(\\b[A-Za-z0-9_.-]*${SECRET_NAME}["']?\\s*[:=]\\s*)(["'\`])(?!\\[REDACTED\\])[^"'\`\\r\\n]{6,}\\2`,
      'gi',
    ),
    replace: `$1$2${REDACTED}$2`,
  },
  // NAME=value lines of an env or shell file, with or without the diff marker.
  {
    pattern: new RegExp(
      `^([+\\- ]?[ \\t]*(?:export[ \\t]+)?[A-Z0-9_]*${SECRET_NAME.toUpperCase()}=[ \\t]*)(?!\\[REDACTED\\])[^\\s'"\`]\\S*`,
      'gm',
    ),
    replace: `$1${REDACTED}`,
  },
];

export interface RedactionResult {
  text: string;
  /** How many places were replaced, for the report. */
  count: number;
}

/** Replaces anything that looks like a secret. Applied to everything before it can reach the AI. */
export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  let result = text;
  for (const rule of RULES) {
    count += result.match(rule.pattern)?.length ?? 0;
    result = result.replace(rule.pattern, rule.replace);
  }
  return { text: result, count };
}
