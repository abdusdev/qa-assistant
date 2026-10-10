import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JiraError, type JiraErrorKind } from '../../../src/jira/errors.js';
import { resolveInput, type TicketSource } from '../../../src/jira/resolver.js';
import type { Ticket } from '../../../src/jira/ticket.js';

const ticket = (key: string, overrides: Partial<Ticket> = {}): Ticket => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  summary: `Summary of ${key}`,
  type: 'Story',
  status: 'Done',
  description: '',
  labels: [],
  fixVersions: [],
  comments: [],
  ...overrides,
});

interface FakeOptions {
  /** Keys that make getIssue fail, with the failure kind. */
  failures?: Record<string, JiraErrorKind>;
  search?: { tickets: Ticket[]; truncated?: boolean };
}

function fakeSource(known: Ticket[], options: FakeOptions = {}) {
  const getIssue = vi.fn(async (key: string): Promise<Ticket> => {
    const failure = options.failures?.[key];
    if (failure) throw new JiraError(failure, `${key} failed with ${failure}`);
    const found = known.find((t) => t.key === key);
    if (!found) throw new JiraError('not_found', `${key} not found`);
    return found;
  });
  const searchIssues = vi.fn(async () => ({
    tickets: options.search?.tickets ?? [],
    truncated: options.search?.truncated ?? false,
  }));
  const source: TicketSource = { getIssue, searchIssues };
  return { source, getIssue, searchIssues };
}

describe('resolveInput', () => {
  describe('single ticket and pasted list', () => {
    it('returns one ticket for a single key', async () => {
      const { source } = fakeSource([ticket('SHP-1')]);

      const result = await resolveInput(source, { mode: 'ticket', value: 'SHP-1' });

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-1']);
      expect(result.warnings).toEqual([]);
    });

    it('returns three tickets for three pasted keys, in the order given', async () => {
      const { source } = fakeSource([ticket('SHP-1'), ticket('SHP-2'), ticket('SHP-3')]);

      const result = await resolveInput(source, {
        mode: 'list',
        value: 'SHP-3, SHP-1\nSHP-2',
      });

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-3', 'SHP-1', 'SHP-2']);
      expect(result.warnings).toEqual([]);
    });

    it('fetches a repeated key only once', async () => {
      const { source, getIssue } = fakeSource([ticket('SHP-1')]);

      const result = await resolveInput(source, { mode: 'list', value: 'SHP-1 SHP-1 SHP-1' });

      expect(result.tickets).toHaveLength(1);
      expect(getIssue).toHaveBeenCalledTimes(1);
    });

    it('warns about a key that does not exist and still returns the others', async () => {
      const { source } = fakeSource([ticket('SHP-1'), ticket('SHP-3')]);

      const result = await resolveInput(source, { mode: 'list', value: 'SHP-1 SHP-99999 SHP-3' });

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-1', 'SHP-3']);
      expect(result.warnings).toEqual([
        'SHP-99999 was not found, or you do not have permission to see it.',
      ]);
    });

    it('warns about a ticket access was denied for', async () => {
      const { source } = fakeSource([ticket('SHP-1'), ticket('SHP-2')], {
        failures: { 'SHP-2': 'forbidden' },
      });

      const result = await resolveInput(source, { mode: 'list', value: 'SHP-1 SHP-2' });

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-1']);
      expect(result.warnings).toEqual(['SHP-2 could not be read: access was denied.']);
    });

    it.each<JiraErrorKind>(['unauthorized', 'rate_limited', 'server_error', 'network'])(
      'stops the whole run on a %s failure instead of returning a partial list',
      async (kind) => {
        const { source } = fakeSource([ticket('SHP-1'), ticket('SHP-2')], {
          failures: { 'SHP-2': kind },
        });

        await expect(
          resolveInput(source, { mode: 'list', value: 'SHP-1 SHP-2' }),
        ).rejects.toMatchObject({ kind });
      },
    );

    it('rejects input that contains no ticket keys', async () => {
      const { source, getIssue } = fakeSource([]);

      await expect(
        resolveInput(source, { mode: 'list', value: 'please test the new page' }),
      ).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(getIssue).not.toHaveBeenCalled();
    });

    it('stops at the maximum and says how many were left out', async () => {
      const { source } = fakeSource([ticket('SHP-1'), ticket('SHP-2'), ticket('SHP-3')]);

      const result = await resolveInput(
        source,
        { mode: 'list', value: 'SHP-1 SHP-2 SHP-3' },
        { maxTickets: 2 },
      );

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-1', 'SHP-2']);
      expect(result.warnings).toEqual([
        'Only the first 2 of 3 tickets were loaded. Split the list into smaller runs.',
      ]);
    });

    it('never fetches more tickets at once than the concurrency limit', async () => {
      let inFlight = 0;
      let peak = 0;
      const source: TicketSource = {
        searchIssues: vi.fn(),
        getIssue: async (key) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return ticket(key);
        },
      };

      const result = await resolveInput(
        source,
        { mode: 'list', value: 'SHP-1 SHP-2 SHP-3 SHP-4 SHP-5 SHP-6' },
        { concurrency: 2 },
      );

      expect(peak).toBe(2);
      expect(result.tickets.map((t) => t.key)).toEqual([
        'SHP-1',
        'SHP-2',
        'SHP-3',
        'SHP-4',
        'SHP-5',
        'SHP-6',
      ]);
    });

    it('recognises lowercase keys of the configured project', async () => {
      const { source } = fakeSource([ticket('SHP-7')]);

      const result = await resolveInput(
        source,
        { mode: 'ticket', value: 'shp-7' },
        { projectKey: 'SHP' },
      );

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-7']);
    });
  });

  describe('filters on explicit keys', () => {
    it('leaves out tickets whose status is not selected, and says why', async () => {
      const { source } = fakeSource([
        ticket('SHP-1', { status: 'Done' }),
        ticket('SHP-2', { status: 'In Progress' }),
      ]);

      const result = await resolveInput(source, {
        mode: 'list',
        value: 'SHP-1 SHP-2',
        filters: { statuses: ['Done'] },
      });

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-1']);
      expect(result.warnings).toEqual([
        'SHP-2 was left out: status "In Progress" is not in the selected statuses.',
      ]);
    });

    it('leaves out tickets of other types and compares names ignoring case', async () => {
      const { source } = fakeSource([
        ticket('SHP-1', { type: 'Bug' }),
        ticket('SHP-2', { type: 'Epic' }),
      ]);

      const result = await resolveInput(source, {
        mode: 'list',
        value: 'SHP-1 SHP-2',
        filters: { types: ['bug', 'STORY'] },
      });

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-1']);
      expect(result.warnings).toEqual([
        'SHP-2 was left out: type "Epic" is not in the selected types.',
      ]);
    });
  });

  describe('sprint, epic and release', () => {
    let tickets: Ticket[];

    beforeEach(() => {
      tickets = [ticket('SHP-10'), ticket('SHP-11')];
    });

    it('searches a sprint by name and returns its tickets', async () => {
      const { source, searchIssues } = fakeSource([], { search: { tickets } });

      const result = await resolveInput(source, { mode: 'sprint', value: 'SN - Sprint 45' });

      expect(searchIssues).toHaveBeenCalledWith('sprint = "SN - Sprint 45" ORDER BY key ASC', {
        maxTickets: 100,
      });
      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-10', 'SHP-11']);
      expect(result.warnings).toEqual([]);
    });

    it('passes type and status filters into the query', async () => {
      const { source, searchIssues } = fakeSource([], { search: { tickets } });

      await resolveInput(source, {
        mode: 'sprint',
        value: 'SN - Sprint 45',
        filters: { types: ['Story', 'Bug'], statuses: ['Done'] },
      });

      expect(searchIssues).toHaveBeenCalledWith(
        'sprint = "SN - Sprint 45" AND issuetype in ("Story", "Bug") AND status in ("Done") ORDER BY key ASC',
        { maxTickets: 100 },
      );
    });

    it('searches the children of an epic', async () => {
      const { source, searchIssues } = fakeSource([], { search: { tickets } });

      await resolveInput(source, { mode: 'epic', value: 'SHP-4084' });

      expect(searchIssues).toHaveBeenCalledWith('parent = SHP-4084 ORDER BY key ASC', {
        maxTickets: 100,
      });
    });

    it('uses the configured maximum for searches', async () => {
      const { source, searchIssues } = fakeSource([], { search: { tickets } });

      await resolveInput(source, { mode: 'epic', value: 'SHP-4084' }, { maxTickets: 25 });

      expect(searchIssues).toHaveBeenCalledWith(expect.any(String), { maxTickets: 25 });
    });

    it('warns when more tickets matched than were loaded', async () => {
      const { source } = fakeSource([], { search: { tickets, truncated: true } });

      const result = await resolveInput(
        source,
        { mode: 'sprint', value: 'SN - Sprint 45' },
        { maxTickets: 2 },
      );

      expect(result.tickets).toHaveLength(2);
      expect(result.warnings).toEqual([
        'More than 2 tickets matched, so only the first 2 were loaded. ' +
          'Narrow the input with the type or status filters.',
      ]);
    });

    it('warns when nothing matched', async () => {
      const { source } = fakeSource([], { search: { tickets: [] } });

      const result = await resolveInput(source, { mode: 'sprint', value: ' SN - Sprint 99 ' });

      expect(result.tickets).toEqual([]);
      expect(result.warnings).toEqual([
        'No tickets matched the sprint "SN - Sprint 99". Check the name and the selected filters.',
      ]);
    });

    it('removes duplicate tickets from search results', async () => {
      const { source } = fakeSource([], {
        search: { tickets: [ticket('SHP-10'), ticket('SHP-10'), ticket('SHP-11')] },
      });

      const result = await resolveInput(source, { mode: 'epic', value: 'SHP-4084' });

      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-10', 'SHP-11']);
    });

    it('does not search at all for an invalid epic key', async () => {
      const { source, searchIssues } = fakeSource([]);

      await expect(
        resolveInput(source, { mode: 'epic', value: 'not a key' }),
      ).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(searchIssues).not.toHaveBeenCalled();
    });
  });

  describe('release input', () => {
    it('is refused while the feature flag is off', async () => {
      const { source, searchIssues } = fakeSource([]);

      await expect(
        resolveInput(source, { mode: 'release', value: '2.14.0' }),
      ).rejects.toMatchObject({
        kind: 'invalid_input',
        message: expect.stringContaining('JIRA_ENABLE_RELEASE') as string,
      });
      expect(searchIssues).not.toHaveBeenCalled();
    });

    it('searches by fix version when enabled', async () => {
      const { source, searchIssues } = fakeSource([], { search: { tickets: [ticket('SHP-5')] } });

      const result = await resolveInput(
        source,
        { mode: 'release', value: '2.14.0', filters: { statuses: ['Done'] } },
        { enableRelease: true },
      );

      expect(searchIssues).toHaveBeenCalledWith(
        'fixVersion = "2.14.0" AND status in ("Done") ORDER BY key ASC',
        { maxTickets: 100 },
      );
      expect(result.tickets.map((t) => t.key)).toEqual(['SHP-5']);
    });
  });

  it('rejects an unknown input type', async () => {
    const { source } = fakeSource([]);

    await expect(
      resolveInput(source, { mode: 'board' as never, value: 'x' }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });
});
