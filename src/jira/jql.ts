import { JiraError } from './errors.js';
import { isTicketKey } from './keys.js';

export type SearchMode = 'sprint' | 'epic' | 'release';

export interface SearchFilters {
  /** Issue type names, for example Story, Bug, Task. */
  types?: string[];
  /** Status names, for example Done, "READY FOR QA". */
  statuses?: string[];
}

const MAX_VALUE_LENGTH = 255;

/** Replaces each run of control characters (new lines, tabs...) with one space. */
function stripControlCharacters(value: string): string {
  let result = '';
  let inRun = false;
  for (const char of value) {
    const isControl = char.charCodeAt(0) < 32;
    if (isControl) {
      if (!inRun) result += ' ';
    } else {
      result += char;
    }
    inRun = isControl;
  }
  return result;
}

/** Wraps a value as a JQL string literal, escaping backslashes and quotes. */
export function quoteJql(value: string, label = 'value'): string {
  const clean = stripControlCharacters(value).trim();

  if (clean === '') {
    throw new JiraError('invalid_input', `The ${label} is empty.`);
  }
  if (clean.length > MAX_VALUE_LENGTH) {
    throw new JiraError(
      'invalid_input',
      `The ${label} is too long (more than ${MAX_VALUE_LENGTH} characters).`,
    );
  }

  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function inClause(field: string, values: string[] | undefined, label: string): string | undefined {
  const cleaned = (values ?? []).map((value) => value.trim()).filter((value) => value !== '');
  if (cleaned.length === 0) return undefined;
  return `${field} in (${cleaned.map((value) => quoteJql(value, label)).join(', ')})`;
}

/** Builds the JQL for a sprint, epic or release, with optional type and status filters. */
export function buildJql(mode: SearchMode, value: string, filters: SearchFilters = {}): string {
  const clauses: string[] = [];

  switch (mode) {
    case 'sprint':
      clauses.push(`sprint = ${quoteJql(value, 'sprint name')}`);
      break;
    case 'release':
      clauses.push(`fixVersion = ${quoteJql(value, 'release version')}`);
      break;
    case 'epic': {
      const key = value.trim().toUpperCase();
      if (!isTicketKey(key)) {
        throw new JiraError('invalid_input', `"${value.slice(0, 40)}" is not a valid epic key.`);
      }
      clauses.push(`parent = ${key}`);
      break;
    }
  }

  const types = inClause('issuetype', filters.types, 'issue type');
  if (types) clauses.push(types);
  const statuses = inClause('status', filters.statuses, 'status');
  if (statuses) clauses.push(statuses);

  return `${clauses.join(' AND ')} ORDER BY key ASC`;
}
