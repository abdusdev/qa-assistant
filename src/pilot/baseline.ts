/**
 * The manual baseline of a pilot: for each ticket, how long QA took to write its cases the
 * normal way, and (once the tool has run) how long they took to review the AI's draft.
 *
 *   ticket,manual_minutes,review_minutes,missed_cases,notes
 *   SHP-4107,45,15,1,Tax rule was not in the ticket
 */

export interface BaselineEntry {
  ticket: string;
  /** Minutes QA took to write the cases without the tool. */
  manualMinutes: number;
  /** Minutes QA took to review and edit the AI's draft. Null until measured. */
  reviewMinutes: number | null;
  /** Cases QA wrote that the tool did not cover, as QA counted them. Null if not counted. */
  missedCases: number | null;
  notes: string;
}

export interface BaselineResult {
  entries: BaselineEntry[];
  /** One line per problem, each naming the row. Empty when the file is usable. */
  problems: string[];
}

const COLUMNS = ['ticket', 'manual_minutes', 'review_minutes', 'missed_cases', 'notes'] as const;
const TICKET = /^[A-Z][A-Z0-9]*-\d+$/;

/** Splits CSV text into rows of cells. Handles quotes, doubled quotes, CRLF and a BOM. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < source.length; i++) {
    const char = source[i] as string;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function minutes(value: string, column: string, line: number, problems: string[]): number | null {
  const text = value.trim();
  if (text === '') return null;
  const number = Number(text.replace(',', '.'));
  if (!Number.isFinite(number) || number < 0 || number > 24 * 60) {
    problems.push(
      `Row ${line}: ${column} must be a number of minutes from 0 to 1440, got "${text}".`,
    );
    return null;
  }
  return number;
}

export function parseBaseline(text: string): BaselineResult {
  const problems: string[] = [];
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  // Excel in many locales saves with semicolons.
  const delimiter = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows = parseCsv(text, delimiter);
  const header = rows.shift()?.map((h) => h.trim().toLowerCase());

  if (!header) return { entries: [], problems: ['The file is empty.'] };
  for (const column of ['ticket', 'manual_minutes']) {
    if (!header.includes(column)) problems.push(`The header has no "${column}" column.`);
  }
  const unknown = header.filter((h) => !(COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0) {
    problems.push(
      `Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Use: ${COLUMNS.join(', ')}.`,
    );
  }
  if (problems.length > 0) return { entries: [], problems };

  const at = (cells: string[], column: string) => cells[header.indexOf(column)] ?? '';
  const entries: BaselineEntry[] = [];
  const seen = new Set<string>();

  rows.forEach((cells, index) => {
    const line = index + 2;
    const ticket = at(cells, 'ticket').trim().toUpperCase();
    if (!TICKET.test(ticket)) {
      problems.push(
        `Row ${line}: "${at(cells, 'ticket').trim()}" is not a ticket key such as SHP-4107.`,
      );
      return;
    }
    if (seen.has(ticket)) {
      problems.push(`Row ${line}: ${ticket} appears twice.`);
      return;
    }
    seen.add(ticket);

    const before = problems.length;
    const manual = minutes(at(cells, 'manual_minutes'), 'manual_minutes', line, problems);
    const review = minutes(at(cells, 'review_minutes'), 'review_minutes', line, problems);
    if (manual === null && problems.length === before) {
      problems.push(`Row ${line}: ${ticket} has no manual_minutes.`);
    }

    let missed: number | null = null;
    const missedText = at(cells, 'missed_cases').trim();
    if (missedText !== '') {
      const value = Number(missedText);
      if (!Number.isInteger(value) || value < 0 || value > 1000) {
        problems.push(`Row ${line}: missed_cases must be a whole number, got "${missedText}".`);
      } else {
        missed = value;
      }
    }
    // One bad value drops the whole row: a row half understood is worse than a row named.
    if (manual === null || problems.length > before) return;
    entries.push({
      ticket,
      manualMinutes: manual,
      reviewMinutes: review,
      missedCases: missed,
      notes: at(cells, 'notes').trim(),
    });
  });

  if (entries.length === 0 && problems.length === 0) problems.push('The file has no rows.');
  return { entries, problems };
}
