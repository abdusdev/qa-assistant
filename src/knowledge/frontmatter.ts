export type FrontMatterValue = string | string[];

export interface FrontMatter {
  data: Record<string, FrontMatterValue>;
  body: string;
}

const stripQuotes = (value: string) =>
  value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();

const countOf = (text: string, char: string) => text.split(char).length - 1;

/**
 * Puts each header entry on one line. Prettier wraps a long list over several lines, and may put
 * its "[" on the line after "key:", so both shapes are joined back together.
 */
function joinWrappedLists(lines: string[]): string[] {
  const joined: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let current = (lines[i] ?? '').trim();
    if (/^[A-Za-z_][\w -]*:$/.test(current) && (lines[i + 1] ?? '').trim().startsWith('[')) {
      current += ' ' + (lines[++i] ?? '').trim();
    }
    while (countOf(current, '[') > countOf(current, ']') && i + 1 < lines.length) {
      current += ' ' + (lines[++i] ?? '').trim();
    }
    joined.push(current);
  }
  return joined;
}

/**
 * Reads a small header at the top of a Markdown file:
 *
 *   ---
 *   name: Shipments
 *   components: [Shipments, Shipping]
 *   ---
 *
 * Only "key: value" and "key: [a, b, c]" are understood, which is all the notes need. A list
 * may continue over several lines, because Prettier wraps long ones.
 * A file without a header is returned whole as the body.
 */
export function parseFrontMatter(text: string): FrontMatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') return { data: {}, body: normalized.trim() };

  const end = lines.indexOf('---', 1);
  if (end === -1) return { data: {}, body: normalized.trim() };

  const data: Record<string, FrontMatterValue> = {};
  for (const line of joinWrappedLists(lines.slice(1, end))) {
    const match = /^([A-Za-z_][\w -]*):\s*(.*)$/.exec(line.trim());
    if (!match?.[1]) continue;

    const key = match[1].trim().toLowerCase();
    const raw = (match[2] ?? '').trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw
        .slice(1, -1)
        .split(',')
        .map(stripQuotes)
        .filter((item) => item !== '');
    } else {
      data[key] = stripQuotes(raw);
    }
  }

  return {
    data,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}

export const asList = (value: FrontMatterValue | undefined): string[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : value === '' ? [] : [value];
};

export const asText = (value: FrontMatterValue | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const text = Array.isArray(value) ? value.join(', ') : value;
  return text === '' ? undefined : text;
};
