import { describe, expect, it, vi } from 'vitest';
import { AIError } from '../../../src/ai/errors.js';
import { checkFlow } from '../../../src/ai/schemas.js';
import { estimateCost, runPipeline, type ProgressEvent } from '../../../src/pipeline/run.js';
import { makeTicket, scriptedAI } from './support.js';

const tickets = (...keys: string[]) => keys.map((key) => makeTicket(key));

describe('runPipeline', () => {
  describe('a normal run', () => {
    it('produces numbered cases, a valid flow and one outcome per ticket', async () => {
      const ai = scriptedAI({ casesPerTicket: 3 });

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2', 'SHP-3'));

      expect(result.cases).toHaveLength(9);
      expect(result.tickets.map((t) => [t.ticket, t.status, t.cases])).toEqual([
        ['SHP-1', 'ok', 3],
        ['SHP-2', 'ok', 3],
        ['SHP-3', 'ok', 3],
      ]);
      expect(result.flowSource).toBe('ai');
      expect(result.warnings).toEqual([]);
      expect(checkFlow(result.flow, result.cases)).toEqual([]);
    });

    it('numbers cases uniquely across the whole run', async () => {
      const result = await runPipeline(
        scriptedAI({ casesPerTicket: 2 }),
        tickets('SHP-1', 'SHP-2'),
      );

      const ids = result.cases.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(['TC-1', 'TC-2', 'TC-3', 'TC-4']);
    });

    it('tags every case with exactly one valid flow step', async () => {
      const result = await runPipeline(
        scriptedAI({ casesPerTicket: 4 }),
        tickets('SHP-1', 'SHP-2'),
      );

      const stepNames = new Set(result.flow.steps.map((s) => s.name));
      for (const testCase of result.cases) {
        expect(stepNames.has(testCase.flow_step)).toBe(true);
      }
      const placed = result.flow.steps.flatMap((s) => s.caseIds);
      expect([...placed].sort()).toEqual(result.cases.map((c) => c.id).sort());
    });

    it('orders the cases by the flow and the steps by their order', async () => {
      const result = await runPipeline(
        scriptedAI({ casesPerTicket: 4 }),
        tickets('SHP-1', 'SHP-2'),
      );

      expect(result.flow.steps.map((s) => s.order)).toEqual([1, 2]);
      expect(result.flow.steps.map((s) => s.name)).toEqual(['Happy path', 'Failures']);
      expect(result.cases.map((c) => c.flow_step)).toEqual([
        ...Array(4).fill('Happy path'),
        ...Array(4).fill('Failures'),
      ]);
    });

    it('keeps the ticket on every case', async () => {
      const result = await runPipeline(scriptedAI(), tickets('SHP-1', 'SHP-2'));

      const byTicket = new Set(result.cases.map((c) => c.ticket));
      expect(byTicket).toEqual(new Set(['SHP-1', 'SHP-2']));
    });

    it('returns an empty result without calling the AI when there are no tickets', async () => {
      const ai = scriptedAI();

      const result = await runPipeline(ai, []);

      expect(result).toMatchObject({ cases: [], flowSource: 'none', calls: 0, tickets: [] });
      expect(result.flow.steps).toEqual([]);
      expect(ai.requests).toHaveLength(0);
    });
  });

  describe('failures stay small', () => {
    it('keeps going when one ticket fails, and says which one', async () => {
      const ai = scriptedAI({ garbageFor: ['SHP-2'] });

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2', 'SHP-3'));

      expect(result.tickets.map((t) => t.status)).toEqual(['ok', 'failed', 'ok']);
      expect(result.tickets[1]?.error).toContain('SHP-2');
      expect(result.cases.map((c) => c.ticket)).not.toContain('SHP-2');
      expect(result.cases).toHaveLength(4);
      expect(result.warnings).toContain('1 of 3 tickets failed: SHP-2.');
      expect(result.flowSource).toBe('ai');
    });

    it('returns results for 18 of 20 tickets when 2 fail', async () => {
      const keys = Array.from({ length: 20 }, (_, i) => `SHP-${i + 1}`);
      const ai = scriptedAI({ garbageFor: ['SHP-5', 'SHP-14'] });

      const result = await runPipeline(ai, tickets(...keys), { concurrency: 4 });

      expect(result.tickets.filter((t) => t.status === 'ok')).toHaveLength(18);
      expect(result.tickets.filter((t) => t.status === 'failed').map((t) => t.ticket)).toEqual([
        'SHP-5',
        'SHP-14',
      ]);
      expect(result.cases).toHaveLength(36);
      expect(checkFlow(result.flow, result.cases)).toEqual([]);
    });

    it('does not retry a failing ticket forever', async () => {
      const ai = scriptedAI({ garbageFor: ['SHP-1'] });

      await runPipeline(ai, tickets('SHP-1'));

      expect(ai.callsFor('SHP-1')).toBe(3); // first attempt plus two retries
    });

    it('handles a run where every ticket fails: no flow call, no cases', async () => {
      const ai = scriptedAI({ garbageFor: ['SHP-1', 'SHP-2'] });

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2'));

      expect(result.cases).toEqual([]);
      expect(result.flowSource).toBe('none');
      expect(ai.flowCalls).toBe(0);
      expect(result.tickets.every((t) => t.status === 'failed')).toBe(true);
    });

    it('records an unexpected error on one ticket without losing the others', async () => {
      const ai = scriptedAI();
      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2'), {
        contextFor: (ticket) => {
          if (ticket.key === 'SHP-1') throw new Error('knowledge store unavailable');
          return {};
        },
      });

      expect(result.tickets[0]).toMatchObject({ status: 'failed' });
      expect(result.tickets[0]?.error).toContain('knowledge store unavailable');
      expect(result.tickets[1]?.status).toBe('ok');
    });
  });

  describe('the quality review', () => {
    it('keeps the first draft and says so when the review cannot run', async () => {
      const ai = scriptedAI({
        reviewThrowFor: {
          'SHP-2': new AIError('rate_limited', 'Gemini rate limit or quota reached (429).'),
        },
      });

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2', 'SHP-3'));

      expect(result.tickets.map((t) => [t.ticket, t.status, t.reviewed])).toEqual([
        ['SHP-1', 'ok', true],
        ['SHP-2', 'ok', false],
        ['SHP-3', 'ok', true],
      ]);
      expect(result.cases.map((c) => c.ticket)).toContain('SHP-2');
      const warning = result.warnings.find((w) => w.includes('quality review'));
      expect(warning).toContain('1 ticket(s)');
      expect(warning).toContain('SHP-2');
      expect(warning).toContain('quota reached');
      expect(result.flowSource).toBe('ai');
    });

    it('says nothing about the review when it was turned off on purpose', async () => {
      const result = await runPipeline(scriptedAI(), tickets('SHP-1'), {
        generate: { selfReview: false },
      });

      expect(result.warnings).toEqual([]);
    });
  });

  describe('a broken AI connection', () => {
    it('stops at once with the error for a rejected key', async () => {
      const ai = scriptedAI({
        throwFor: { 'SHP-1': new AIError('unauthorized', 'Gemini rejected the API key') },
      });

      await expect(
        runPipeline(ai, tickets('SHP-1', 'SHP-2', 'SHP-3', 'SHP-4', 'SHP-5'), { concurrency: 1 }),
      ).rejects.toMatchObject({ kind: 'unauthorized' });

      // Nothing after the first failure was sent.
      expect(ai.requests).toHaveLength(1);
    });

    it('treats an unknown model the same way', async () => {
      const ai = scriptedAI({
        throwFor: { 'SHP-1': new AIError('model_not_found', 'no such model') },
      });

      await expect(runPipeline(ai, tickets('SHP-1', 'SHP-2'))).rejects.toMatchObject({
        kind: 'model_not_found',
      });
    });

    it('stops after repeated rate limits and keeps what finished', async () => {
      const limited = new AIError('rate_limited', 'quota reached');
      const ai = scriptedAI({
        throwFor: {
          'SHP-3': limited,
          'SHP-4': limited,
          'SHP-5': limited,
          'SHP-6': limited,
          'SHP-7': limited,
        },
      });

      const result = await runPipeline(
        ai,
        tickets(...['1', '2', '3', '4', '5', '6', '7'].map((n) => `SHP-${n}`)),
        {
          concurrency: 1,
        },
      );

      expect(result.tickets.map((t) => t.status)).toEqual([
        'ok',
        'ok',
        'failed',
        'failed',
        'failed',
        'skipped',
        'skipped',
      ]);
      expect(result.cases).toHaveLength(4);
      expect(result.warnings.join(' ')).toContain('stopped early after repeated rate-limit errors');
      expect(result.warnings.join(' ')).toContain('2 tickets were not processed');
      expect(ai.callsFor('SHP-6')).toBe(0);
    });

    it('does not stop for a rate limit that is not repeated', async () => {
      const limited = new AIError('rate_limited', 'quota reached');
      const ai = scriptedAI({ throwFor: { 'SHP-2': limited, 'SHP-4': limited } });

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2', 'SHP-3', 'SHP-4', 'SHP-5'), {
        concurrency: 1,
      });

      expect(result.tickets.map((t) => t.status)).toEqual(['ok', 'failed', 'ok', 'failed', 'ok']);
    });
  });

  describe('parallel work', () => {
    it('never runs more tickets at once than the limit', async () => {
      const keys = Array.from({ length: 9 }, (_, i) => `SHP-${i + 1}`);
      const delayMs = Object.fromEntries(keys.map((key) => [key, 5]));
      const ai = scriptedAI({ delayMs });

      await runPipeline(ai, tickets(...keys), {
        concurrency: 2,
        generate: { selfReview: false },
      });

      expect(ai.peakInFlight).toBe(2);
    });

    it('defaults to three tickets at once', async () => {
      const keys = Array.from({ length: 9 }, (_, i) => `SHP-${i + 1}`);
      const ai = scriptedAI({ delayMs: Object.fromEntries(keys.map((key) => [key, 5])) });

      await runPipeline(ai, tickets(...keys), { generate: { selfReview: false } });

      expect(ai.peakInFlight).toBe(3);
    });

    it('gives the same order whichever ticket finishes first', async () => {
      const slowFirst = scriptedAI({ delayMs: { 'SHP-1': 30 } });
      const fastFirst = scriptedAI({ delayMs: { 'SHP-3': 30 } });

      const a = await runPipeline(slowFirst, tickets('SHP-1', 'SHP-2', 'SHP-3'));
      const b = await runPipeline(fastFirst, tickets('SHP-1', 'SHP-2', 'SHP-3'));

      const shape = (r: typeof a) => r.cases.map((c) => `${c.id}:${c.ticket}:${c.flow_step}`);
      expect(shape(a)).toEqual(shape(b));
    });
  });

  describe('duplicates across tickets', () => {
    it('removes a near-duplicate of another ticket and renumbers the rest', async () => {
      const ai = scriptedAI({
        casesFor: (key) => [
          {
            title: 'Create shipments for all selected orders',
            expected: 'One shipment is created per selected order',
            flow_step: 'Happy path',
          },
          {
            title: `Unique behaviour of ${key.toLowerCase().replace('-', '')}x`,
            expected: `Distinct outcome for ${key.toLowerCase().replace('-', '')}x`,
            flow_step: 'Failures',
          },
        ],
      });

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2'));

      expect(result.cases).toHaveLength(3);
      expect(result.cases.filter((c) => c.title.startsWith('Create shipments'))).toHaveLength(1);
      expect(result.cases.map((c) => c.id).sort()).toEqual(['TC-1', 'TC-2', 'TC-3']);
      expect(result.warnings.join(' ')).toContain('near-duplicate');
      expect(result.warnings.join(' ')).toContain('(SHP-2)');
    });

    it('keeps similar cases that belong to the same ticket', async () => {
      const ai = scriptedAI({
        casesFor: () => [
          {
            title: 'Create shipments for exactly 100 orders',
            expected: 'All 100 shipments are created',
          },
          {
            title: 'Create shipments for exactly 101 orders',
            expected: 'All 101 shipments are created',
          },
        ],
      });

      const result = await runPipeline(ai, tickets('SHP-1'));

      expect(result.cases).toHaveLength(2);
    });
  });

  describe('the flow', () => {
    it('falls back to grouping by each case’s own step when the AI answer is unusable', async () => {
      const ai = scriptedAI({ flow: 'garbage', casesPerTicket: 4 });

      const result = await runPipeline(ai, tickets('SHP-1'));

      expect(result.flowSource).toBe('fallback');
      expect(result.warnings.join(' ')).toContain('could not order the flow');
      expect(result.flow.steps.map((s) => s.name)).toEqual(['Happy path', 'Failures']);
      expect(checkFlow(result.flow, result.cases)).toEqual([]);
      expect(ai.flowCalls).toBe(3);
    });

    it('falls back when the AI flow leaves cases out', async () => {
      const ai = scriptedAI({ flow: 'incomplete', casesPerTicket: 3 });

      const result = await runPipeline(ai, tickets('SHP-1'));

      expect(result.flowSource).toBe('fallback');
      expect(checkFlow(result.flow, result.cases)).toEqual([]);
    });

    it('falls back when the flow request fails outright', async () => {
      const ai = scriptedAI({ flow: 'throw' });

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2'));

      expect(result.flowSource).toBe('fallback');
      expect(result.cases).toHaveLength(4);
    });

    it('skips the AI flow when there are too many cases for one pass', async () => {
      const ai = scriptedAI({ casesPerTicket: 3 });

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2'), { maxCasesForAiFlow: 5 });

      expect(result.flowSource).toBe('fallback');
      expect(ai.flowCalls).toBe(0);
      expect(result.warnings.join(' ')).toContain('too many for the AI');
    });

    it('can skip the AI flow on request', async () => {
      const ai = scriptedAI();

      const result = await runPipeline(ai, tickets('SHP-1'), { buildFlow: false });

      expect(result.flowSource).toBe('fallback');
      expect(ai.flowCalls).toBe(0);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('cancelling', () => {
    it('skips tickets that have not started and keeps finished work', async () => {
      const controller = new AbortController();
      const ai = scriptedAI();

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2', 'SHP-3', 'SHP-4'), {
        concurrency: 1,
        signal: controller.signal,
        onProgress: (event) => {
          if (event.type === 'ticket_done' && event.ticket === 'SHP-1') controller.abort();
        },
      });

      expect(result.cancelled).toBe(true);
      expect(result.tickets.map((t) => t.status)).toEqual(['ok', 'skipped', 'skipped', 'skipped']);
      expect(result.cases.length).toBeGreaterThan(0);
      expect(result.warnings.join(' ')).toContain('cancelled');
      expect(ai.flowCalls).toBe(0);
      expect(result.flowSource).toBe('fallback');
    });

    it('does nothing when cancelled before it starts', async () => {
      const controller = new AbortController();
      controller.abort();
      const ai = scriptedAI();

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2'), {
        signal: controller.signal,
      });

      expect(result.cancelled).toBe(true);
      expect(result.cases).toEqual([]);
      expect(ai.requests).toHaveLength(0);
    });
  });

  describe('progress', () => {
    it('reports each ticket and the flow, in a sensible order', async () => {
      const events: ProgressEvent[] = [];

      await runPipeline(scriptedAI({ garbageFor: ['SHP-2'] }), tickets('SHP-1', 'SHP-2'), {
        concurrency: 1,
        onProgress: (event) => events.push(event),
      });

      expect(events.map((e) => e.type)).toEqual([
        'ticket_started',
        'ticket_done',
        'ticket_started',
        'ticket_failed',
        'flow_started',
        'flow_done',
        'finished',
      ]);
      const last = events
        .filter((e) => e.type === 'ticket_done' || e.type === 'ticket_failed')
        .at(-1);
      expect(last).toMatchObject({ done: 2, total: 2 });
    });

    it('is not broken by a progress listener that throws', async () => {
      const result = await runPipeline(scriptedAI(), tickets('SHP-1'), {
        onProgress: () => {
          throw new Error('listener bug');
        },
      });

      expect(result.cases.length).toBeGreaterThan(0);
    });
  });

  describe('context and totals', () => {
    it('asks for context once per ticket and puts it in the prompt', async () => {
      const ai = scriptedAI();
      const contextFor = vi.fn(async (ticket: { key: string }) => ({
        moduleNotes: `Notes for ${ticket.key}`,
      }));

      await runPipeline(ai, tickets('SHP-1', 'SHP-2'), { contextFor });

      expect(contextFor).toHaveBeenCalledTimes(2);
      const prompts = ai.requests.map((r) => r.prompt);
      expect(prompts.some((p) => p.includes('Notes for SHP-1'))).toBe(true);
      expect(prompts.some((p) => p.includes('Notes for SHP-2'))).toBe(true);
    });

    it('adds up the tokens and calls of the whole run, flow included', async () => {
      const ai = scriptedAI();

      const result = await runPipeline(ai, tickets('SHP-1', 'SHP-2'));

      // Per ticket: 1 generation + 1 review. Plus 1 flow call.
      expect(result.calls).toBe(5);
      expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 250, totalTokens: 750 });
    });

    it('estimates the cost only when prices are given', async () => {
      const without = await runPipeline(scriptedAI(), tickets('SHP-1'));
      const priced = await runPipeline(scriptedAI(), tickets('SHP-1'), {
        pricing: { inputPerMillion: 1, outputPerMillion: 4 },
      });

      expect(without).not.toHaveProperty('estimatedCostUsd');
      // 3 calls: 300 in, 150 out -> 300 * 1 / 1e6 + 150 * 4 / 1e6
      expect(priced.estimatedCostUsd).toBeCloseTo(0.0009, 10);
    });

    it('passes retry and review settings to every ticket', async () => {
      const ai = scriptedAI();

      await runPipeline(ai, tickets('SHP-1'), { generate: { selfReview: false } });

      expect(ai.callsFor('SHP-1')).toBe(1);
    });

    it('records the prompt version and how long the run took', async () => {
      const result = await runPipeline(scriptedAI(), tickets('SHP-1'));

      expect(result.promptVersion).toMatch(/^v\d+$/);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('estimateCost', () => {
  it('prices input and output tokens separately', () => {
    const cost = estimateCost(
      { inputTokens: 2_000_000, outputTokens: 500_000, totalTokens: 2_500_000 },
      { inputPerMillion: 0.75, outputPerMillion: 3.75 },
    );

    expect(cost).toBeCloseTo(1.5 + 1.875, 10);
  });

  it('is zero for no usage', () => {
    expect(
      estimateCost(
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        { inputPerMillion: 1, outputPerMillion: 1 },
      ),
    ).toBe(0);
  });
});
