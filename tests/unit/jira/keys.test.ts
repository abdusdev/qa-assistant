import { describe, expect, it } from 'vitest';
import { extractKeys, isTicketKey } from '../../../src/jira/keys.js';

describe('extractKeys', () => {
  it('finds a single key', () => {
    expect(extractKeys('SHP-4103')).toEqual(['SHP-4103']);
  });

  it('finds keys separated by commas, spaces and new lines', () => {
    expect(extractKeys('SHP-1, SHP-2\nSHP-3 SHP-4')).toEqual(['SHP-1', 'SHP-2', 'SHP-3', 'SHP-4']);
  });

  it('finds keys inside URLs', () => {
    const text = 'https://99technologies.atlassian.net/browse/SHP-4103?focusedCommentId=1';
    expect(extractKeys(text)).toEqual(['SHP-4103']);
  });

  it('finds keys inside sentences and brackets', () => {
    expect(extractKeys('Please test SHP-12 and (SHP-13).')).toEqual(['SHP-12', 'SHP-13']);
  });

  it('removes duplicates and keeps the order of first appearance', () => {
    expect(extractKeys('SHP-2 SHP-1 SHP-2 SHP-1 SHP-3')).toEqual(['SHP-2', 'SHP-1', 'SHP-3']);
  });

  it('accepts keys from several projects', () => {
    expect(extractKeys('ABC-1 SHP-2')).toEqual(['ABC-1', 'SHP-2']);
  });

  it('returns nothing for text without keys', () => {
    expect(extractKeys('no tickets here, just utf-8 and SHP- and 4103')).toEqual([]);
    expect(extractKeys('')).toEqual([]);
  });

  it('ignores lowercase keys unless the project is named', () => {
    expect(extractKeys('shp-1 and SHP-2')).toEqual(['SHP-2']);
  });

  it('recognises lowercase keys of the named project, in text order', () => {
    expect(extractKeys('shp-1, SHP-2, abc-3, Shp-4', { projectKey: 'SHP' })).toEqual([
      'SHP-1',
      'SHP-2',
      'SHP-4',
    ]);
  });

  it('treats the project key literally, not as a pattern', () => {
    expect(extractKeys('axb-1 a.b-2', { projectKey: 'A.B' })).toEqual(['A.B-2']);
  });
});

describe('isTicketKey', () => {
  it.each(['SHP-1', 'SHP-4103', 'AB2-10', 'A_B-5'])('accepts %s', (key) => {
    expect(isTicketKey(key)).toBe(true);
  });

  it.each(['shp-1', 'SHP', 'SHP-', '-1', '4103', 'SHP-1 ', 'SHP-1,SHP-2', '1SHP-1'])(
    'rejects %j',
    (key) => {
      expect(isTicketKey(key)).toBe(false);
    },
  );
});
