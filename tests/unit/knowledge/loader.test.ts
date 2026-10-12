import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadKnowledge } from '../../../src/knowledge/loader.js';

const OVERVIEW =
  'ShipNest connects online stores with shipping couriers so sellers can ship orders.';

describe('loadKnowledge', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  const folder = async (files: Record<string, string>) => {
    root = await mkdtemp(path.join(tmpdir(), 'knowledge-'));
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    return root;
  };

  it('reads the fixed files, the module notes and the past cases', async () => {
    const dir = await folder({
      'overview.md': OVERVIEW,
      'glossary.md': '**Rate**: a courier price quote for one order to its address.',
      'standards.md': 'One purpose per case. Expected results are specific and checkable.',
      'modules/shipments.md':
        '---\nname: Shipments\ncomponents: [Shipments]\nlabels: [rates]\nkeywords: [label]\n---\n' +
        'Orders are shipped from the Orders page with the "Create shipments" button.',
      'past-cases/shipments.md':
        '---\nmodule: Shipments\n---\n## A case\nSteps:\n1. Do it\nExpected: It happens',
    });

    const knowledge = await loadKnowledge(dir);

    expect(knowledge.overview).toBe(OVERVIEW);
    expect(knowledge.glossary).toContain('Rate');
    expect(knowledge.standards).toContain('One purpose per case');
    expect(knowledge.modules).toHaveLength(1);
    expect(knowledge.modules[0]).toMatchObject({
      id: 'shipments',
      name: 'Shipments',
      components: ['Shipments'],
      labels: ['rates'],
      keywords: ['label'],
    });
    expect(knowledge.pastCases).toMatchObject([{ title: 'A case', module: 'Shipments' }]);
    expect(knowledge.warnings).toEqual([]);
    expect(knowledge.files).toHaveLength(5);
  });

  it('does not crash and says so when the folder is missing', async () => {
    const knowledge = await loadKnowledge(path.join(tmpdir(), 'no-such-knowledge-folder-xyz'));

    expect(knowledge.modules).toEqual([]);
    expect(knowledge.pastCases).toEqual([]);
    expect(knowledge.warnings).toEqual([
      'overview.md was not found in ' + path.join(tmpdir(), 'no-such-knowledge-folder-xyz') + '.',
      'glossary.md was not found in ' + path.join(tmpdir(), 'no-such-knowledge-folder-xyz') + '.',
      'standards.md was not found in ' + path.join(tmpdir(), 'no-such-knowledge-folder-xyz') + '.',
    ]);
  });

  it('treats a file that is only a template as not filled in', async () => {
    const dir = await folder({
      'overview.md': '<!-- TEMPLATE: write the overview here, 150 to 400 words -->',
      'modules/shipments.md': '---\nname: Shipments\n---\n<!-- TEMPLATE -->',
    });

    const knowledge = await loadKnowledge(dir);

    expect(knowledge.overview).toBeUndefined();
    expect(knowledge.modules).toEqual([]);
    expect(knowledge.warnings).toContain('overview.md has not been filled in yet.');
    expect(knowledge.warnings).toContain(
      'modules/shipments.md has not been filled in yet, so it is not used.',
    );
  });

  it('ignores templates that start with an underscore and the README', async () => {
    const dir = await folder({
      'overview.md': OVERVIEW,
      'README.md': 'Notes about this folder that are long enough to count as text.',
      'modules/_template.md': 'A template that is long enough to look like a real module note.',
      'modules/README.md': 'Readme text long enough to look like a real module note too.',
      'past-cases/_template.md': '## A template case\nSteps:\n1. x\nExpected: y',
    });

    const knowledge = await loadKnowledge(dir);

    expect(knowledge.modules).toEqual([]);
    expect(knowledge.pastCases).toEqual([]);
  });

  it('removes comments from a file that is filled in', async () => {
    const dir = await folder({
      'overview.md': `<!-- instructions for the writer -->\n${OVERVIEW}`,
    });

    expect((await loadKnowledge(dir)).overview).toBe(OVERVIEW);
  });

  it('names a module from its file when the header has no name', async () => {
    const dir = await folder({
      'modules/automation-rules.md':
        'Rules run automatically on orders that match a condition set by the seller.',
    });

    const knowledge = await loadKnowledge(dir);

    expect(knowledge.modules[0]).toMatchObject({
      id: 'automation-rules',
      name: 'Automation Rules',
    });
  });

  it('uses the file name as the module of its past cases', async () => {
    const dir = await folder({
      'past-cases/orders.md': '## A case\nSteps:\n1. Do it\nExpected: It happens',
    });

    expect((await loadKnowledge(dir)).pastCases[0]?.module).toBe('Orders');
  });

  it('skips past cases without an expected result and says so', async () => {
    const dir = await folder({
      'past-cases/orders.md':
        '## Complete\nSteps:\n1. Do it\nExpected: It happens\n\n## Incomplete\nSteps:\n1. Do it',
    });

    const knowledge = await loadKnowledge(dir);

    expect(knowledge.pastCases.map((c) => c.title)).toEqual(['Complete']);
    expect(knowledge.warnings).toContain(
      'past-cases/orders.md: 1 case(s) have no expected result and are not used.',
    );
  });
});
