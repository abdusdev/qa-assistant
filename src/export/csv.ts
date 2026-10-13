import {
  GROUNDING_LABEL,
  REVIEW_STATUS,
  SOURCE_LABEL,
  groupByFlow,
  type ExportRun,
} from './model.js';

const BOM = String.fromCharCode(0xfeff);

/** A CSV field: quoted when it holds a comma, a quote or a line break, with quotes doubled. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Spreadsheets run text that starts with these characters as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
const safe = (value: string) => (FORMULA_START.test(value) ? `'${value}` : value);

export const CSV_COLUMNS = [
  'Review status',
  'ID',
  'Ticket',
  'Flow step',
  'Title',
  'Type',
  'Priority',
  'Preconditions',
  'Steps',
  'Expected result',
  'Based on',
  'To confirm',
  'Runs after',
] as const;

/**
 * The run as CSV for a spreadsheet: one row per case in flow order, UTF-8 with a byte order
 * mark so Excel reads it correctly. Every row carries its review status, so the "AI draft"
 * notice cannot be separated from the cases.
 */
export function toCsv(run: ExportRun): string {
  const rows: string[][] = [[...CSV_COLUMNS]];

  for (const { step, cases } of groupByFlow(run)) {
    for (const c of cases) {
      const sources = c.sources
        .filter((s) => s.from !== 'inferred' || s.quote !== '')
        .map((s) => `${SOURCE_LABEL[s.from]}${s.quote ? `: ${s.quote}` : ''}`);
      rows.push([
        REVIEW_STATUS[c.state],
        c.id,
        c.ticket,
        step.name,
        c.title,
        c.type,
        c.priority,
        c.preconditions.join('\n'),
        c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
        c.expected,
        [GROUNDING_LABEL[c.grounding], ...sources].join('\n'),
        c.assumptions.join('\n'),
        c.dependsOn.join(', '),
      ]);
    }
  }

  const body = rows
    .map((row, index) => row.map((cell) => csvField(index === 0 ? cell : safe(cell))).join(','))
    .join('\r\n');
  return `${BOM}${body}\r\n`;
}
