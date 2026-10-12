import { describe, expect, it } from 'vitest';
import {
  appearsIn,
  assessTicketDetail,
  buildEvidence,
  groundCase,
  mergeDetail,
  quotedTexts,
} from '../../../src/ai/grounding.js';
import type { TestCase } from '../../../src/ai/schemas.js';
import type { Ticket } from '../../../src/jira/ticket.js';

const ticket: Ticket = {
  key: 'SHP-1',
  url: 'https://example.atlassian.net/browse/SHP-1',
  summary: 'Require fresh rates after the Ship To address changes',
  type: 'Bug',
  status: 'Done',
  description:
    'When the seller changes the Ship To address, the old rates stay available. ' +
    'Shipping must be blocked until new rates are fetched. ' +
    'Suggested warning: "Ship To address has changed. Please fetch new rates before shipping."',
  labels: ['Regression'],
  fixVersions: [],
  acceptanceCriteria:
    '1. Changing the street marks rates as outdated.\n2. Phone changes keep rates.',
  comments: [{ author: 'Sam', created: '2026-10-01', body: 'Also check the listing page.' }],
};

const testCase = (overrides: Partial<TestCase> = {}): TestCase => ({
  id: 'TC-1',
  ticket: 'SHP-1',
  flow_step: 'Failures',
  title: 'Shipping is blocked after the address changes',
  type: 'ui',
  priority: 'high',
  steps: ['Fetch rates', 'Change the address', 'Try to ship'],
  expected: 'Shipping is blocked',
  sources: [],
  assumptions: [],
  preconditions: [],
  depends_on: [],
  grounding: 'assumed',
  ...overrides,
});

const evidence = buildEvidence(ticket, {
  moduleNotes: 'Rates are stored with the address they were fetched for.',
  pastCases: ['TC-31 Shipment cannot be created without a selected rate'],
  codeChanges: 'validateShip compares the address hash with the hash stored on the rates.',
});

describe('appearsIn', () => {
  it('finds an exact excerpt, ignoring case and spacing', () => {
    expect(appearsIn('shipping must   be BLOCKED until new rates', ticket.description)).toBe(true);
  });

  it('ignores markdown decoration and quote marks', () => {
    expect(appearsIn('**Shipping** must be `blocked`', ticket.description)).toBe(true);
    expect(appearsIn('Ship To address has changed', ticket.description)).toBe(true);
  });

  it('accepts a lightly paraphrased longer excerpt', () => {
    expect(
      appearsIn('shipping must be blocked until the new rates are fetched', ticket.description),
    ).toBe(true);
  });

  it('rejects text that is not there', () => {
    expect(appearsIn('Confirm Save', ticket.description)).toBe(false);
    expect(appearsIn('the user exports the report to a spreadsheet', ticket.description)).toBe(
      false,
    );
  });

  it('is exact only for very short quotes', () => {
    expect(appearsIn('rates stay', ticket.description)).toBe(true);
    expect(appearsIn('rates vanish', ticket.description)).toBe(false);
  });

  it('rejects an empty quote', () => {
    expect(appearsIn('   ', ticket.description)).toBe(false);
  });
});

describe('quotedTexts', () => {
  it('finds quoted button names and messages', () => {
    expect(quotedTexts(`Click 'Confirm Save' and read "Filter name is required".`)).toEqual([
      'Confirm Save',
      'Filter name is required',
    ]);
  });

  it('finds curly-quoted text', () => {
    expect(quotedTexts('Press ‘Process Orders’ now')).toEqual(['Process Orders']);
  });

  it('ignores apostrophes inside words', () => {
    expect(quotedTexts("The user's cart doesn't change and it's fine")).toEqual([]);
  });

  it('ignores very short quoted text', () => {
    expect(quotedTexts("Set the flag to 'no' or 'x'")).toEqual([]);
  });

  it('returns nothing when there are no quotes', () => {
    expect(quotedTexts('Open the order and ship it')).toEqual([]);
  });
});

describe('buildEvidence', () => {
  it('keeps each part of the ticket and context apart', () => {
    expect(evidence.parts.ticket).toContain('Ship To address');
    expect(evidence.parts.ticket).toContain('Regression');
    expect(evidence.parts.acceptance_criteria).toContain('Phone changes keep rates');
    expect(evidence.parts.comment).toContain('listing page');
    expect(evidence.parts.module_notes).toContain('stored with the address');
    expect(evidence.parts.past_cases).toContain('TC-31');
    expect(evidence.parts.code_changes).toContain('address hash');
    expect(evidence.all).toContain('listing page');
  });

  it('works with no context', () => {
    const bare = buildEvidence(ticket);

    expect(bare.parts.module_notes).toBe('');
    expect(bare.parts.code_changes).toBe('');
  });
});

describe('groundCase', () => {
  it('marks a case grounded when its source is really in the ticket', () => {
    const result = groundCase(
      testCase({
        sources: [
          { from: 'ticket', quote: 'Shipping must be blocked until new rates are fetched' },
        ],
      }),
      evidence,
    );

    expect(result.grounding).toBe('grounded');
    expect(result.sources).toEqual([
      { from: 'ticket', quote: 'Shipping must be blocked until new rates are fetched' },
    ]);
    expect(result.assumptions).toEqual([]);
  });

  it('calls a case partly grounded when it has a real source but assumes some details', () => {
    const result = groundCase(
      testCase({
        sources: [
          { from: 'ticket', quote: 'Shipping must be blocked until new rates are fetched' },
        ],
        assumptions: ['The limit is 100 orders per request'],
      }),
      evidence,
    );

    expect(result.grounding).toBe('partly');
    expect(result.assumptions).toEqual(['The limit is 100 orders per request']);
  });

  it('lists an invented status code, endpoint or number and drops the case to "partly"', () => {
    const result = groundCase(
      testCase({
        steps: ['Send a request to /api/v2/labels', 'Select 50 orders'],
        expected: 'The API returns a 409 Conflict error',
        sources: [
          { from: 'ticket', quote: 'Shipping must be blocked until new rates are fetched' },
        ],
      }),
      evidence,
    );

    expect(result.grounding).toBe('partly');
    expect(result.assumptions).toEqual([
      'The status code "409" is not in the ticket or context. Confirm it.',
      'The endpoint "/api/v2/labels" is not in the ticket or context. Confirm it.',
      'The number "50" is not in the ticket or context. Confirm it.',
    ]);
  });

  it('does not question a detail that is in the ticket or the context', () => {
    const result = groundCase(
      testCase({
        steps: ['Open the page /rates/outdated', 'Wait 30 seconds'],
        expected: 'The API returns 409',
        sources: [
          { from: 'ticket', quote: 'Shipping must be blocked until new rates are fetched' },
        ],
      }),
      buildEvidence(ticket, {
        moduleNotes:
          'The page /rates/outdated lists stale quotes. A request returns 409 while busy.',
        codeChanges: 'const TIMEOUT_SECONDS = 30',
      }),
    );

    expect(result.grounding).toBe('grounded');
    expect(result.assumptions).toEqual([]);
  });

  it('corrects the part when the quote is real but from another part', () => {
    const result = groundCase(
      testCase({ sources: [{ from: 'ticket', quote: 'Phone changes keep rates' }] }),
      evidence,
    );

    expect(result.sources).toEqual([
      { from: 'acceptance_criteria', quote: 'Phone changes keep rates' },
    ]);
    expect(result.grounding).toBe('grounded');
  });

  it('accepts sources from the knowledge and the code changes', () => {
    const result = groundCase(
      testCase({
        sources: [
          { from: 'module_notes', quote: 'Rates are stored with the address' },
          { from: 'code_changes', quote: 'validateShip compares the address hash' },
        ],
      }),
      evidence,
    );

    expect(result.grounding).toBe('grounded');
    expect(result.sources).toHaveLength(2);
  });

  it('drops a source that is not in the text and says so', () => {
    const result = groundCase(
      testCase({
        sources: [
          { from: 'ticket', quote: 'Shipping must be blocked until new rates are fetched' },
          { from: 'ticket', quote: 'The export must include a CSV download button' },
        ],
      }),
      evidence,
    );

    expect(result.sources).toHaveLength(1);
    expect(result.assumptions).toEqual([
      'A source was cited that is not in the ticket or context: "The export must include a CSV download button".',
    ]);
    expect(result.grounding).toBe('partly');
  });

  it('treats a case whose only source is invented as assumed', () => {
    const result = groundCase(
      testCase({ sources: [{ from: 'ticket', quote: 'The seller can export an invoice' }] }),
      evidence,
    );

    expect(result.sources).toEqual([]);
    expect(result.grounding).toBe('assumed');
  });

  it('treats an inferred-only case as assumed and keeps the source', () => {
    const result = groundCase(
      testCase({
        sources: [{ from: 'inferred', quote: '' }],
        assumptions: ['The user is logged in'],
      }),
      evidence,
    );

    expect(result.sources).toEqual([{ from: 'inferred', quote: '' }]);
    expect(result.assumptions).toEqual(['The user is logged in']);
    expect(result.grounding).toBe('assumed');
  });

  it('says so when no source was given at all', () => {
    const result = groundCase(testCase({ sources: [] }), evidence);

    expect(result.assumptions).toContain('No source was given for this case.');
    expect(result.grounding).toBe('assumed');
  });

  it('flags a quoted label that is not in the ticket or context', () => {
    const result = groundCase(
      testCase({
        steps: ['Open the order', "Click 'Confirm Save'"],
        expected: 'The message "Filter name is required" is shown',
        sources: [
          { from: 'ticket', quote: 'Shipping must be blocked until new rates are fetched' },
        ],
      }),
      evidence,
    );

    expect(result.assumptions).toEqual([
      'The label or message "Confirm Save" is not in the ticket or context. Confirm the exact text.',
      'The label or message "Filter name is required" is not in the ticket or context. Confirm the exact text.',
    ]);
    expect(result.grounding).toBe('partly');
  });

  it('does not flag quoted text that really is in the ticket', () => {
    const result = groundCase(
      testCase({
        expected:
          'The warning "Ship To address has changed. Please fetch new rates before shipping." is shown',
        sources: [{ from: 'ticket', quote: 'Suggested warning' }],
      }),
      evidence,
    );

    expect(result.assumptions).toEqual([]);
    expect(result.grounding).toBe('grounded');
  });

  it('checks quoted text in the title and the preconditions too', () => {
    const result = groundCase(
      testCase({
        title: "Reject a rate named 'Turbo Express' at checkout",
        preconditions: ["A rate labelled 'Turbo Express' exists"],
        sources: [{ from: 'ticket', quote: 'Suggested warning' }],
      }),
      evidence,
    );

    expect(result.assumptions).toEqual([
      'The label or message "Turbo Express" is not in the ticket or context. Confirm the exact text.',
    ]);
  });

  it('keeps the assumptions the model wrote and does not repeat a note', () => {
    const result = groundCase(
      testCase({
        steps: ["Click 'Confirm Save'", "Click 'Confirm Save' again"],
        assumptions: ['Rates were fetched less than a minute ago'],
        sources: [{ from: 'ticket', quote: 'Suggested warning' }],
      }),
      evidence,
    );

    expect(result.assumptions).toHaveLength(2);
    expect(result.assumptions[0]).toBe('Rates were fetched less than a minute ago');
  });

  it('does not change the case it was given', () => {
    const original = testCase({ sources: [{ from: 'ticket', quote: 'nothing real here at all' }] });

    groundCase(original, evidence);

    expect(original.sources).toHaveLength(1);
    expect(original.assumptions).toEqual([]);
  });
});

describe('assessTicketDetail', () => {
  const withText = (description: string, acceptanceCriteria?: string): Ticket => ({
    ...ticket,
    description,
    ...(acceptanceCriteria !== undefined && { acceptanceCriteria }),
  });

  it('accepts a ticket with a real description and criteria', () => {
    expect(assessTicketDetail(ticket)).toEqual({ sufficient: true, missing: [] });
  });

  it('rejects a ticket with almost no text', () => {
    const result = assessTicketDetail({
      ...withText('Fix the bug.'),
      acceptanceCriteria: undefined,
    });

    expect(result.sufficient).toBe(false);
    expect(result.missing).toEqual(['The ticket has almost no description.']);
  });

  it('rejects a short description without acceptance criteria', () => {
    const description = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');

    const result = assessTicketDetail({ ...withText(description), acceptanceCriteria: undefined });

    expect(result.missing).toEqual([
      'The description is short and there are no acceptance criteria.',
    ]);
  });

  it('accepts a short description when acceptance criteria exist', () => {
    const description = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');

    expect(assessTicketDetail(withText(description, 'It works.')).sufficient).toBe(true);
  });
});

describe('mergeDetail', () => {
  const enough = { sufficient: true, missing: [] };

  it('is sufficient only when both views say so', () => {
    expect(mergeDetail(enough, undefined)).toEqual(enough);
    expect(mergeDetail(enough, { sufficient: true, missing: [] })).toEqual(enough);
  });

  it('takes the model’s view when the quick check passes', () => {
    expect(
      mergeDetail(enough, { sufficient: false, missing: ['Which fields are saved?'] }),
    ).toEqual({
      sufficient: false,
      missing: ['Which fields are saved?'],
    });
  });

  it('combines both lists without repeats when both object', () => {
    const quick = { sufficient: false, missing: ['No description.'] };

    expect(
      mergeDetail(quick, { sufficient: false, missing: ['No description.', 'No limits given.'] }),
    ).toEqual({ sufficient: false, missing: ['No description.', 'No limits given.'] });
  });
});
