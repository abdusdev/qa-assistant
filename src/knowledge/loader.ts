import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { asList, asText, parseFrontMatter } from './frontmatter.js';
import { parsePastCases, type PastCase } from './past-cases.js';

export interface ModuleNote {
  /** File name without the extension. */
  id: string;
  name: string;
  /** Jira components that belong to this module. */
  components: string[];
  labels: string[];
  /** Words in a ticket that point at this module. */
  keywords: string[];
  body: string;
  file: string;
}

export interface Knowledge {
  overview?: string;
  glossary?: string;
  standards?: string;
  modules: ModuleNote[];
  pastCases: PastCase[];
  /** Things QA should know: missing or unfilled files, files that could not be read. */
  warnings: string[];
  /** Every file that was read. */
  files: string[];
}

/** A file that is still only the template (or nearly empty) does not count as filled in. */
const MIN_FILLED_CHARS = 40;

const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim();

const isIgnored = (name: string) =>
  !name.toLowerCase().endsWith('.md') || name.startsWith('_') || name.toLowerCase() === 'readme.md';

const titleCase = (value: string) =>
  value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function listMarkdown(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => !isIgnored(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Reads the knowledge folder:
 *   overview.md, glossary.md, standards.md   fixed context for every ticket
 *   modules/*.md                             one note per module, chosen per ticket
 *   past-cases/*.md                          approved cases, a few chosen per ticket
 * Missing or unfilled files give warnings. Nothing here ever throws for a missing file.
 */
export async function loadKnowledge(dir = 'knowledge'): Promise<Knowledge> {
  const knowledge: Knowledge = { modules: [], pastCases: [], warnings: [], files: [] };

  const fixed = async (name: 'overview' | 'glossary' | 'standards') => {
    const file = path.join(dir, `${name}.md`);
    try {
      const raw = await readIfExists(file);
      if (raw === undefined) {
        knowledge.warnings.push(`${name}.md was not found in ${dir}.`);
        return;
      }
      knowledge.files.push(file);
      const text = stripComments(parseFrontMatter(raw).body);
      if (text.length < MIN_FILLED_CHARS) {
        knowledge.warnings.push(`${name}.md has not been filled in yet.`);
        return;
      }
      knowledge[name] = text;
    } catch (error) {
      knowledge.warnings.push(`${name}.md could not be read: ${(error as Error).message}`);
    }
  };
  await fixed('overview');
  await fixed('glossary');
  await fixed('standards');

  for (const name of await listMarkdown(path.join(dir, 'modules'))) {
    const file = path.join(dir, 'modules', name);
    try {
      const { data, body } = parseFrontMatter(await readFile(file, 'utf8'));
      knowledge.files.push(file);
      const text = stripComments(body);
      const id = name.replace(/\.md$/i, '');
      if (text.length < MIN_FILLED_CHARS) {
        knowledge.warnings.push(`modules/${name} has not been filled in yet, so it is not used.`);
        continue;
      }
      knowledge.modules.push({
        id,
        name: asText(data.name) ?? titleCase(id),
        components: asList(data.components),
        labels: asList(data.labels),
        keywords: asList(data.keywords),
        body: text,
        file,
      });
    } catch (error) {
      knowledge.warnings.push(`modules/${name} could not be read: ${(error as Error).message}`);
    }
  }

  for (const name of await listMarkdown(path.join(dir, 'past-cases'))) {
    const file = path.join(dir, 'past-cases', name);
    try {
      const { data, body } = parseFrontMatter(await readFile(file, 'utf8'));
      knowledge.files.push(file);
      const module = asText(data.module) ?? titleCase(name.replace(/\.md$/i, ''));
      const cases = parsePastCases(stripComments(body), `past-cases/${name}`, module);
      const usable = cases.filter((c) => c.expected !== '');
      if (usable.length < cases.length) {
        knowledge.warnings.push(
          `past-cases/${name}: ${cases.length - usable.length} case(s) have no expected result and are not used.`,
        );
      }
      knowledge.pastCases.push(...usable);
    } catch (error) {
      knowledge.warnings.push(`past-cases/${name} could not be read: ${(error as Error).message}`);
    }
  }

  return knowledge;
}
