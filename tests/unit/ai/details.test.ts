import { describe, expect, it } from 'vitest';
import { unbackedDetails } from '../../../src/ai/grounding.js';

const kinds = (text: string, evidence: string) =>
  unbackedDetails(text, evidence).map((d) => `${d.kind}:${d.detail}`);

describe('unbackedDetails', () => {
  describe('status codes', () => {
    it('flags a status code the sources never mention', () => {
      expect(kinds('The API returns a 409 Conflict error', 'Rates must be fetched again.')).toEqual(
        ['status code:409'],
      );
    });

    it('reads several ways of writing a status code', () => {
      expect(kinds('Responds with 422', '')).toEqual(['status code:422']);
      expect(kinds('HTTP 503 is returned', '')).toEqual(['status code:503']);
      expect(kinds('status code: 404', '')).toEqual(['status code:404']);
      expect(kinds('Conflict (409) is shown', '')).toEqual(['status code:409']);
    });

    it('accepts a status code that is in the evidence', () => {
      expect(kinds('The API returns 409', 'Refuses (409) while a label is in flight')).toEqual([]);
    });

    it('does not take a part of a longer number as a match', () => {
      expect(kinds('The API returns 409', 'order 14095 was shipped')).toEqual(['status code:409']);
    });
  });

  describe('endpoints', () => {
    it('flags a path that is not in the sources', () => {
      expect(kinds('Send a request to /api/v1/labels', 'The label is created.')).toEqual([
        'endpoint:/api/v1/labels',
      ]);
    });

    it('accepts a path that is in the sources, in any letter case', () => {
      expect(kinds('POST /api/v1/Labels', 'route /api/v1/labels creates one')).toEqual([]);
    });

    it('ignores "and/or" and similar words', () => {
      expect(kinds('Save and/or cancel the form', '')).toEqual([]);
    });

    it('ignores a trailing full stop', () => {
      expect(kinds('Open /settings/rates.', '')).toEqual(['endpoint:/settings/rates']);
    });
  });

  describe('numbers', () => {
    it('flags a number of 10 or more that is not in the sources', () => {
      expect(kinds('Select 50 orders and click Ship', 'Select several orders.')).toEqual([
        'number:50',
      ]);
    });

    it('accepts a number that is in the sources', () => {
      expect(kinds('Select 100 orders', 'A batch has at most 100 orders.')).toEqual([]);
    });

    it('accepts a boundary one above or below a number in the sources', () => {
      expect(kinds('Select 101 orders', 'The limit is 100 orders.')).toEqual([]);
      expect(kinds('Select 99 orders', 'The limit is 100 orders.')).toEqual([]);
      expect(kinds('Select 102 orders', 'The limit is 100 orders.')).toEqual(['number:102']);
    });

    it('leaves single digits and ticket keys alone', () => {
      expect(kinds('Select 3 orders for SHP-4103', 'Select several orders.')).toEqual([]);
    });
  });

  it('lists each detail once', () => {
    expect(kinds('Returns 409 and again returns 409', '')).toEqual(['status code:409']);
  });
});
