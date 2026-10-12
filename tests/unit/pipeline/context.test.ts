import { describe, expect, it } from 'vitest';
import { contextHash } from '../../../src/db/ticket-cache.js';
import { CodeContextProvider } from '../../../src/github/code-context.js';
import type { Knowledge } from '../../../src/knowledge/loader.js';
import { buildKnowledgeContext } from '../../../src/knowledge/match.js';
import { combineContexts } from '../../../src/pipeline/context.js';
import { runPipeline } from '../../../src/pipeline/run.js';
import { REPO, fakeGitHub, file, pr } from '../github/support.js';
import { makeTicket, scriptedAI } from './support.js';

describe('combineContexts', () => {
  it('joins the text fields of every source', () => {
    const combined = combineContexts({
      knowledge: { productKnowledge: 'about ShipNest', moduleNotes: 'shipments note' },
      code: { codeChanges: '+const A = 1' },
    });

    expect(combined).toEqual({
      productKnowledge: 'about ShipNest',
      moduleNotes: 'shipments note',
      codeChanges: '+const A = 1',
    });
  });

  it('keeps the knowledge report at the top and puts other reports under their name', () => {
    const combined = combineContexts({
      knowledge: { meta: { modules: [{ name: 'Shipments' }], hasProductKnowledge: true } },
      code: { meta: { status: 'found' } },
    });

    expect(combined.meta).toEqual({
      modules: [{ name: 'Shipments' }],
      hasProductKnowledge: true,
      code: { status: 'found' },
    });
  });

  it('adds the warnings together', () => {
    const combined = combineContexts({
      knowledge: { warnings: ['a'] },
      code: { warnings: ['b', 'c'] },
    });

    expect(combined.warnings).toEqual(['a', 'b', 'c']);
  });

  it('skips sources that are missing and returns nothing extra for none', () => {
    expect(combineContexts({ knowledge: undefined, code: undefined })).toEqual({});
    expect(combineContexts({ code: { codeChanges: 'x' } })).toEqual({ codeChanges: 'x' });
  });

  it('reports a source other than knowledge under its own name even when alone', () => {
    expect(combineContexts({ code: { meta: { status: 'none' } } }).meta).toEqual({
      code: { status: 'none' },
    });
  });
});

describe('code context in a pipeline run', () => {
  const changed = [
    file('src/drawer.tsx', {
      patch: '@@ -1 +1 @@\n-old\n+const MESSAGE = "Ship To address has changed."',
    }),
  ];

  const knowledge: Knowledge = {
    overview: 'ShipNest connects online stores with couriers so sellers can ship orders.',
    modules: [],
    pastCases: [],
    warnings: [],
    files: [],
  };

  const setup = (useCode: boolean) => {
    const github = fakeGitHub({
      recent: [pr(10, { title: 'Quote (SHP-1)' })],
      files: { 10: changed },
    });
    const code = new CodeContextProvider(github, { repos: [REPO] });
    const contextFor = async (ticket: ReturnType<typeof makeTicket>) =>
      combineContexts({
        knowledge: buildKnowledgeContext(knowledge, ticket),
        code: useCode ? await code.contextFor(ticket) : undefined,
      });
    return { github, contextFor };
  };

  it('reaches the prompt of a ticket that has a pull request', async () => {
    const ai = scriptedAI();
    const { contextFor } = setup(true);

    await runPipeline(ai, [makeTicket('SHP-1')], { contextFor });

    const generation = ai.requests.find((r) => r.prompt.includes('<ticket key="SHP-1"'));
    expect(generation?.prompt).toContain('<code_changes>');
    expect(generation?.prompt).toContain('+const MESSAGE = "Ship To address has changed."');
    expect(generation?.system).toContain('## Code changes');
    expect(generation?.system).toContain('ShipNest connects online stores');
  });

  it('writes the cases from the ticket and warns when a ticket has no pull request', async () => {
    const ai = scriptedAI();
    const { contextFor } = setup(true);

    const result = await runPipeline(ai, [makeTicket('SHP-1'), makeTicket('SHP-2')], {
      contextFor,
    });

    const generation = ai.requests.find((r) => r.prompt.includes('<ticket key="SHP-2"'));
    expect(generation?.prompt).not.toContain('<code_changes>');
    expect(generation?.system).not.toContain('## Code changes');
    expect(result.tickets.map((t) => t.status)).toEqual(['ok', 'ok']);
    expect(result.cases.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('SHP-2: no pull request'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('SHP-1: no pull request'))).toBe(false);
  });

  it('reports what code was used per ticket, next to the knowledge report', async () => {
    const { contextFor } = setup(true);

    const result = await runPipeline(scriptedAI(), [makeTicket('SHP-1')], { contextFor });

    expect(result.tickets[0]?.context).toMatchObject({
      hasProductKnowledge: true,
      code: { status: 'found', pullRequests: [{ number: 10, matchedIn: ['title'] }] },
    });
  });

  it('is left out completely when the toggle is off, and GitHub is not asked', async () => {
    const ai = scriptedAI();
    const { github, contextFor } = setup(false);

    const result = await runPipeline(ai, [makeTicket('SHP-1')], { contextFor });

    expect(ai.requests.every((r) => !r.prompt.includes('<code_changes>'))).toBe(true);
    expect(github.calls.recent).toEqual([]);
    expect(result.warnings.some((w) => w.includes('pull request'))).toBe(false);
    expect(result.tickets[0]?.context).not.toHaveProperty('code');
  });

  it('counts a case built on the diff as grounded', async () => {
    const ai = scriptedAI({
      casesFor: () => [
        {
          title: 'Warn when the address changes',
          expected: 'The seller sees the stale quote message',
          sources: [{ from: 'code_changes', quote: 'Ship To address has changed.' }],
          assumptions: [],
        },
      ],
    });
    const { contextFor } = setup(true);

    const result = await runPipeline(ai, [makeTicket('SHP-1')], { contextFor });

    expect(result.cases[0]?.sources[0]?.from).toBe('code_changes');
    expect(result.cases[0]?.grounding).toBe('grounded');
  });

  it('does not accept a code quote that is not in the diff', async () => {
    const ai = scriptedAI({
      casesFor: () => [
        {
          title: 'Warn when the address changes',
          expected: 'The seller sees a message',
          sources: [{ from: 'code_changes', quote: 'Rates were deleted for ever and ever.' }],
          assumptions: [],
        },
      ],
    });
    const { contextFor } = setup(true);

    const result = await runPipeline(ai, [makeTicket('SHP-1')], { contextFor });

    expect(result.cases[0]?.grounding).toBe('assumed');
  });

  it('gives a different cache identity once the code changes', () => {
    const before = contextHash({ codeChanges: '+const A = 1' });
    const after = contextHash({ codeChanges: '+const A = 2' });

    expect(before).not.toBe(after);
  });
});
