import { describe, expect, it } from 'vitest';
import { MAX_COMMENTS, MAX_FIELD_CHARS, toTicketSnapshot } from '../../../src/jira/snapshot.js';
import { makeTicket } from '../pipeline/support.js';

describe('toTicketSnapshot', () => {
  it('keeps the ticket fields a reader needs', () => {
    const ticket = makeTicket('SHP-1', {
      acceptanceCriteria: 'It works',
      labels: ['rates'],
      components: ['Shipments'],
      parentKey: 'SHP-0',
      updated: '2026-10-01T10:00:00Z',
      comments: [{ author: 'Asha', created: '2026-10-01', body: 'Seen on prod' }],
    });

    expect(toTicketSnapshot(ticket)).toEqual({
      key: 'SHP-1',
      url: ticket.url,
      summary: ticket.summary,
      type: 'Story',
      status: 'Done',
      description: ticket.description,
      acceptanceCriteria: 'It works',
      labels: ['rates'],
      components: ['Shipments'],
      parentKey: 'SHP-0',
      updated: '2026-10-01T10:00:00Z',
      commentCount: 1,
      comments: [{ author: 'Asha', created: '2026-10-01', body: 'Seen on prod' }],
      truncated: false,
    });
  });

  it('leaves out the fields the ticket does not have', () => {
    const snapshot = toTicketSnapshot(makeTicket('SHP-1'));

    expect(snapshot).not.toHaveProperty('acceptanceCriteria');
    expect(snapshot).not.toHaveProperty('components');
    expect(snapshot).not.toHaveProperty('parentKey');
    expect(snapshot).not.toHaveProperty('updated');
  });

  it('cuts a very long field and says so, and a ticket at the limit is whole', () => {
    const atLimit = toTicketSnapshot(
      makeTicket('SHP-1', { description: 'x'.repeat(MAX_FIELD_CHARS) }),
    );
    const over = toTicketSnapshot(
      makeTicket('SHP-1', { description: 'x'.repeat(MAX_FIELD_CHARS + 5) }),
    );

    expect(atLimit.truncated).toBe(false);
    expect(atLimit.description).toHaveLength(MAX_FIELD_CHARS);
    expect(over.truncated).toBe(true);
    expect(over.description).toHaveLength(MAX_FIELD_CHARS);
  });

  it('cuts a very long comment', () => {
    const snapshot = toTicketSnapshot(
      makeTicket('SHP-1', {
        comments: [{ author: 'A', created: '2026-10-01', body: 'y'.repeat(MAX_FIELD_CHARS + 1) }],
      }),
    );

    expect(snapshot.comments[0]!.body).toHaveLength(MAX_FIELD_CHARS);
    expect(snapshot.truncated).toBe(true);
  });

  it('keeps the first comments, counts all of them and says some were left out', () => {
    const comments = Array.from({ length: MAX_COMMENTS + 3 }, (_, i) => ({
      author: `A${i}`,
      created: '2026-10-01',
      body: `Comment ${i}`,
    }));

    const snapshot = toTicketSnapshot(makeTicket('SHP-1', { comments }));

    expect(snapshot.comments).toHaveLength(MAX_COMMENTS);
    expect(snapshot.comments[0]!.author).toBe('A0');
    expect(snapshot.commentCount).toBe(MAX_COMMENTS + 3);
    expect(snapshot.truncated).toBe(true);
  });
});
