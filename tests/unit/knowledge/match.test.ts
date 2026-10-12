import { describe, expect, it } from 'vitest';
import type { Knowledge, ModuleNote } from '../../../src/knowledge/loader.js';
import {
  buildKnowledgeContext,
  matchModules,
  matchPastCases,
} from '../../../src/knowledge/match.js';
import type { PastCase } from '../../../src/knowledge/past-cases.js';
import { runPipeline } from '../../../src/pipeline/run.js';
import { makeTicket, scriptedAI } from '../pipeline/support.js';

const module = (overrides: Partial<ModuleNote>): ModuleNote => ({
  id: 'shipments',
  name: 'Shipments',
  components: [],
  labels: [],
  keywords: [],
  body: 'Orders are shipped from the Orders page with the "Create shipments" button.',
  file: 'modules/shipments.md',
  ...overrides,
});

const shipments = module({
  components: ['Shipments'],
  labels: ['rates'],
  keywords: ['label', 'tracking'],
});
const orders = module({
  id: 'orders',
  name: 'Orders',
  components: ['Orders'],
  keywords: ['filter'],
  body: 'The Orders page lists orders and has bulk actions and filters for the seller.',
});

const pastCase = (title: string, module: string, expected = 'It works'): PastCase => ({
  title,
  module,
  type: 'ui',
  priority: 'high',
  steps: ['Do the thing'],
  expected,
  source: 'past-cases/x.md',
});

describe('matchModules', () => {
  it('matches a Jira component first and most strongly', () => {
    const ticket = makeTicket('SHP-1', { components: ['Shipments'] });

    const [match] = matchModules([orders, shipments], ticket);

    expect(match?.module.name).toBe('Shipments');
    expect(match?.score).toBeGreaterThanOrEqual(10);
    expect(match?.reasons).toContain('component "Shipments"');
  });

  it('matches a label', () => {
    const ticket = makeTicket('SHP-1', { labels: ['Rates'], summary: 'Something unrelated' });

    const [match] = matchModules([shipments], ticket);

    expect(match?.reasons).toEqual(['label "Rates"']);
  });

  it('matches a keyword in the summary, and the module name in the summary', () => {
    const ticket = makeTicket('SHP-1', { summary: 'Reprint the label from the Shipments page' });

    const [match] = matchModules([shipments], ticket);

    expect(match?.reasons).toEqual(
      expect.arrayContaining(['module name in the summary', 'keyword "label" in the summary']),
    );
  });

  it('counts keywords in the description for less, and at most three of them', () => {
    const many = module({ keywords: ['one', 'two', 'three', 'four', 'five'] });
    const ticket = makeTicket('SHP-1', {
      summary: 'Unrelated',
      description: 'one two three four five',
    });

    const [match] = matchModules([many], ticket, { minModuleScore: 1 });

    expect(match?.score).toBe(3);
  });

  it('does not match a word that is only part of another word', () => {
    const ticket = makeTicket('SHP-1', {
      summary: 'Unlabelled cards',
      description: 'The labelling of items',
    });

    expect(matchModules([shipments], ticket)).toEqual([]);
  });

  it('returns no module when nothing reaches the minimum score', () => {
    const ticket = makeTicket('SHP-1', { summary: 'Change the footer colour' });

    expect(matchModules([shipments, orders], ticket)).toEqual([]);
  });

  it('returns the best modules first, at most the limit', () => {
    const ticket = makeTicket('SHP-1', {
      components: ['Shipments', 'Orders'],
      labels: ['rates'],
    });

    const matches = matchModules([orders, shipments], ticket, { maxModules: 1 });

    expect(matches.map((m) => m.module.name)).toEqual(['Shipments']);
  });
});

describe('matchPastCases', () => {
  const cases = [
    pastCase(
      'Reprint the label of an active shipment',
      'Shipments',
      'Same tracking number is used',
    ),
    pastCase('Filter orders by status', 'Orders', 'Only matching orders are shown'),
    pastCase('Change the colour theme', 'Settings', 'The theme changes'),
  ];

  it('returns the cases most like the ticket, most similar first', () => {
    const ticket = makeTicket('SHP-1', {
      summary: 'Reprint a shipping label',
      description:
        'The seller reprints the label of an active shipment and keeps the tracking number',
    });

    const matches = matchPastCases(cases, ticket, []);

    expect(matches[0]?.case.title).toBe('Reprint the label of an active shipment');
    expect(matches.map((m) => m.case.title)).not.toContain('Change the colour theme');
  });

  it('leaves out cases that are not similar enough', () => {
    const ticket = makeTicket('SHP-1', { summary: 'Quarterly invoice export', description: 'CSV' });

    expect(matchPastCases(cases, ticket, [])).toEqual([]);
  });

  it('prefers a case from a matched module when similarity is close', () => {
    const similar = [
      pastCase('Reprint the label', 'Orders', 'Label printed'),
      pastCase('Reprint the label', 'Shipments', 'Label printed'),
    ];
    const ticket = makeTicket('SHP-1', {
      summary: 'Reprint the label',
      description: 'Label printed',
    });

    const [first] = matchPastCases(similar, ticket, [shipments]);

    expect(first?.case.module).toBe('Shipments');
  });

  it('returns at most the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      pastCase(`Reprint the label variant${i}`, 'Shipments', 'Label printed'),
    );
    const ticket = makeTicket('SHP-1', {
      summary: 'Reprint the label',
      description: 'Label printed',
    });

    expect(matchPastCases(many, ticket, [], { maxPastCases: 3 })).toHaveLength(3);
  });
});

describe('buildKnowledgeContext', () => {
  const knowledge: Knowledge = {
    overview: 'ShipNest connects online stores with couriers.',
    glossary: '**Rate**: a courier price quote.',
    standards: 'One purpose per case.',
    modules: [shipments, orders],
    pastCases: [pastCase('Reprint the label of an active shipment', 'Shipments')],
    warnings: [],
    files: [],
  };

  const ticket = makeTicket('SHP-9', {
    summary: 'Reprint the label',
    components: ['Shipments'],
    description: 'Reprint the label of an active shipment',
  });

  it('puts the fixed knowledge in product knowledge, with a heading each', () => {
    const context = buildKnowledgeContext(knowledge, ticket);

    expect(context.productKnowledge).toBe(
      [
        '### Product overview\nShipNest connects online stores with couriers.',
        '### Glossary\n**Rate**: a courier price quote.',
        '### Standards for test cases\nOne purpose per case.',
      ].join('\n\n'),
    );
  });

  it('adds only the matching module note, and the similar past cases', () => {
    const context = buildKnowledgeContext(knowledge, ticket);

    expect(context.moduleNotes).toContain('## Module: Shipments');
    expect(context.moduleNotes).toContain('Create shipments');
    expect(context.moduleNotes).not.toContain('Module: Orders');
    expect(context.pastCases).toHaveLength(1);
    expect(context.pastCases?.[0]).toContain('Case: Reprint the label of an active shipment');
  });

  it('reports what was chosen and why, for people and not for the AI', () => {
    const context = buildKnowledgeContext(knowledge, ticket);

    expect(context.meta.modules[0]).toMatchObject({ name: 'Shipments' });
    expect(context.meta.modules[0]?.reasons).toContain('component "Shipments"');
    expect(context.meta.pastCases[0]).toMatchObject({
      title: 'Reprint the label of an active shipment',
      source: 'past-cases/x.md',
    });
    expect(context.meta.hasProductKnowledge).toBe(true);
  });

  it('gives only the fixed knowledge when nothing matches the ticket', () => {
    const other = makeTicket('SHP-9', { summary: 'Change the footer colour', description: 'Blue' });

    const context = buildKnowledgeContext(knowledge, other);

    expect(context.productKnowledge).toBeDefined();
    expect(context.moduleNotes).toBeUndefined();
    expect(context.pastCases).toBeUndefined();
  });

  it('gives nothing but the report when the knowledge is empty', () => {
    const empty: Knowledge = { modules: [], pastCases: [], warnings: [], files: [] };

    const context = buildKnowledgeContext(empty, ticket);

    expect(context.productKnowledge).toBeUndefined();
    expect(context.meta).toEqual({ modules: [], pastCases: [], hasProductKnowledge: false });
  });
});

describe('code overviews in the context', () => {
  const overview = module({
    id: 'shipments-code',
    name: 'Shipments',
    components: ['Shipments'],
    body: '### Validation rules and limits\n- A shipment needs a selected rate.',
    file: 'knowledge/codebase/shipments.md',
  });
  const other = module({
    id: 'orders-code',
    name: 'Orders',
    components: ['Orders'],
    body: '### Purpose\n- Lists orders.',
    file: 'knowledge/codebase/orders.md',
  });
  const knowledge: Knowledge = {
    modules: [shipments],
    codeNotes: [other, overview],
    pastCases: [],
    warnings: [],
    files: [],
  };
  const ticket = makeTicket('SHP-9', { components: ['Shipments'], summary: 'Reprint the label' });

  it('adds the matching overview after the module note, under its own heading', () => {
    const context = buildKnowledgeContext(knowledge, ticket);

    expect(context.moduleNotes).toContain('## Module: Shipments');
    expect(context.moduleNotes).toContain('## Code overview: Shipments');
    expect(context.moduleNotes).toContain('A shipment needs a selected rate.');
    expect(context.moduleNotes).not.toContain('Lists orders.');
    expect(context.moduleNotes?.indexOf('## Module:')).toBeLessThan(
      context.moduleNotes?.indexOf('## Code overview:') ?? -1,
    );
  });

  it('adds only one overview by default, the best match, and reports it', () => {
    const both = makeTicket('SHP-9', {
      components: ['Shipments', 'Orders'],
      summary: 'Shipments page shows the wrong label',
    });

    const context = buildKnowledgeContext(knowledge, both);

    expect(context.moduleNotes?.match(/## Code overview:/g)).toHaveLength(1);
    expect(context.meta.codeNotes).toMatchObject([{ name: 'Shipments' }]);
    expect(context.meta.codeNotes?.[0]?.reasons).toContain('component "Shipments"');
  });

  it('can add more overviews when asked', () => {
    const both = makeTicket('SHP-9', { components: ['Shipments', 'Orders'] });

    const context = buildKnowledgeContext(knowledge, both, { maxCodeNotes: 2 });

    expect(context.moduleNotes?.match(/## Code overview:/g)).toHaveLength(2);
  });

  it('works when only an overview matches, and leaves the report unchanged without any', () => {
    const onlyCode: Knowledge = { ...knowledge, modules: [] };
    const without: Knowledge = { ...knowledge, codeNotes: [] };

    expect(buildKnowledgeContext(onlyCode, ticket).moduleNotes).toContain('## Code overview');
    expect(buildKnowledgeContext(without, ticket).meta).not.toHaveProperty('codeNotes');
  });

  it('is used for the grounding of a case that quotes it', async () => {
    const ai = scriptedAI({
      casesFor: () => [
        {
          title: 'A shipment needs a rate',
          expected: 'Shipping is blocked without a selected rate',
          sources: [{ from: 'module_notes', quote: 'A shipment needs a selected rate.' }],
          assumptions: [],
        },
      ],
    });

    const result = await runPipeline(ai, [ticket], {
      contextFor: (t) => buildKnowledgeContext(knowledge, t),
    });

    expect(result.cases[0]?.sources[0]?.from).toBe('module_notes');
    expect(result.cases[0]?.grounding).toBe('grounded');
  });
});

describe('knowledge in a pipeline run', () => {
  const knowledge: Knowledge = {
    overview: 'ShipNest connects online stores with couriers so sellers can ship orders.',
    modules: [shipments],
    pastCases: [],
    warnings: [],
    files: [],
  };

  it('reaches the prompt and is reported per ticket', async () => {
    const ai = scriptedAI();

    const result = await runPipeline(ai, [makeTicket('SHP-1', { components: ['Shipments'] })], {
      contextFor: (ticket) => buildKnowledgeContext(knowledge, ticket),
    });

    const generation = ai.requests.find((r) => r.prompt.includes('<ticket key="SHP-1"'));
    expect(generation?.system).toContain('ShipNest connects online stores');
    expect(generation?.prompt).toContain('<module_notes>');
    expect(generation?.prompt).toContain('"Create shipments" button');
    expect(result.tickets[0]?.context).toMatchObject({
      modules: [{ name: 'Shipments' }],
      hasProductKnowledge: true,
    });
  });

  it('does not put the report into the prompt', async () => {
    const ai = scriptedAI();

    await runPipeline(ai, [makeTicket('SHP-1', { components: ['Shipments'] })], {
      contextFor: (ticket) => buildKnowledgeContext(knowledge, ticket),
    });

    for (const request of ai.requests) {
      expect(request.prompt).not.toContain('reasons');
      expect(request.system).not.toContain('"meta"');
    }
  });
});
