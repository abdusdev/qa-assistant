import { describe, expect, it } from 'vitest';
import { parseBaseline, parseCsv } from '../../../src/pilot/baseline.js';

describe('parseCsv', () => {
  it('reads quoted cells with commas, doubled quotes and line breaks', () => {
    expect(parseCsv('a,"b,c","say ""hi""","line\nbreak"\r\nd,e,f,g')).toEqual([
      ['a', 'b,c', 'say "hi"', 'line\nbreak'],
      ['d', 'e', 'f', 'g'],
    ]);
  });

  it('ignores a byte order mark and blank lines', () => {
    expect(parseCsv('﻿a,b\n\n,\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseBaseline', () => {
  const header = 'ticket,manual_minutes,review_minutes,missed_cases,notes';

  it('reads every column', () => {
    const result = parseBaseline(`${header}\nshp-4107,45,15,2,"Tax rule, not in ticket"\n`);

    expect(result.problems).toEqual([]);
    expect(result.entries).toEqual([
      {
        ticket: 'SHP-4107',
        manualMinutes: 45,
        reviewMinutes: 15,
        missedCases: 2,
        notes: 'Tax rule, not in ticket',
      },
    ]);
  });

  it('allows the optional columns to be absent or empty', () => {
    const result = parseBaseline(
      'ticket,manual_minutes\nSHP-1,30\nSHP-2,\n'.replace('SHP-2,\n', ''),
    );
    expect(result.entries).toEqual([
      { ticket: 'SHP-1', manualMinutes: 30, reviewMinutes: null, missedCases: null, notes: '' },
    ]);

    const empty = parseBaseline(`${header}\nSHP-1,30,,,\n`);
    expect(empty.entries[0]).toMatchObject({ reviewMinutes: null, missedCases: null });
  });

  it('reads a semicolon file and a decimal comma, as a spreadsheet may save them', () => {
    const result = parseBaseline('ticket;manual_minutes;review_minutes\r\nSHP-1;37,5;12\r\n');

    expect(result.problems).toEqual([]);
    expect(result.entries[0]).toMatchObject({ manualMinutes: 37.5, reviewMinutes: 12 });
  });

  it('names the row and the reason for each problem and keeps the good rows', () => {
    const result = parseBaseline(
      [
        header,
        'SHP-1,30,10,,',
        'not a key,30,10,,',
        'SHP-2,abc,10,,',
        'SHP-3,-5,10,,',
        'SHP-4,30,2000,,',
        'SHP-5,30,10,1.5,',
        'SHP-1,40,10,,',
        'SHP-6,,10,,',
      ].join('\n'),
    );

    expect(result.entries.map((e) => e.ticket)).toEqual(['SHP-1']);
    expect(result.problems).toEqual([
      'Row 3: "not a key" is not a ticket key such as SHP-4107.',
      'Row 4: manual_minutes must be a number of minutes from 0 to 1440, got "abc".',
      'Row 5: manual_minutes must be a number of minutes from 0 to 1440, got "-5".',
      'Row 6: review_minutes must be a number of minutes from 0 to 1440, got "2000".',
      'Row 7: missed_cases must be a whole number, got "1.5".',
      'Row 8: SHP-1 appears twice.',
      'Row 9: SHP-6 has no manual_minutes.',
    ]);
  });

  it('rejects a file with a missing required column or an unknown one', () => {
    expect(parseBaseline('ticket,minutes\nSHP-1,5').problems).toEqual([
      'The header has no "manual_minutes" column.',
      'Unknown column: minutes. Use: ticket, manual_minutes, review_minutes, missed_cases, notes.',
    ]);
    expect(parseBaseline('').problems).toEqual(['The file is empty.']);
    expect(parseBaseline(`${header}\n`).problems).toEqual(['The file has no rows.']);
  });
});
