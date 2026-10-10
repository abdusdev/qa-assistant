/** A complete Jira ticket key such as SHP-4103. */
export const KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

const KEY_IN_TEXT = /\b[A-Z][A-Z0-9_]*-\d+\b/g;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isTicketKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

export interface ExtractOptions {
  /**
   * When set, keys of this project are also recognised in lowercase (shp-4103).
   * Other projects must be uppercase, so words like "utf-8" are not mistaken for tickets.
   */
  projectKey?: string;
}

/**
 * Finds ticket keys in free text: commas, spaces, new lines, URLs and sentences all work.
 * Returns unique keys in the order they first appear.
 */
export function extractKeys(text: string, options: ExtractOptions = {}): string[] {
  const found: { index: number; key: string }[] = [];

  for (const match of text.matchAll(KEY_IN_TEXT)) {
    found.push({ index: match.index, key: match[0] });
  }

  if (options.projectKey) {
    const project = escapeRegExp(options.projectKey.trim());
    const lowercaseProject = new RegExp(`\\b${project}-\\d+\\b`, 'gi');
    for (const match of text.matchAll(lowercaseProject)) {
      found.push({ index: match.index, key: match[0].toUpperCase() });
    }
  }

  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map((item) => item.key))];
}
