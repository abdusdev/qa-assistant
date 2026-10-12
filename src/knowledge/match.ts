import type { PromptContext } from '../ai/prompt.js';
import type { Ticket } from '../jira/ticket.js';
import { similarity } from '../util/similarity.js';
import type { Knowledge, ModuleNote } from './loader.js';
import { formatPastCase, type PastCase } from './past-cases.js';

export interface ModuleMatch {
  module: ModuleNote;
  score: number;
  /** Why it matched, so QA can tune the keywords. */
  reasons: string[];
}

export interface PastCaseMatch {
  case: PastCase;
  score: number;
}

export interface KnowledgeOptions {
  /** Most module notes added to one ticket. Default 2. */
  maxModules?: number;
  /** A module must score at least this to be used. Default 3. */
  minModuleScore?: number;
  /** Most past cases added to one ticket. Default 4. */
  maxPastCases?: number;
  /** A past case must be at least this similar to the ticket. Default 0.06. */
  minCaseSimilarity?: number;
  /** Most reviewed code overviews added to one ticket. Default 1. */
  maxCodeNotes?: number;
}

const lower = (value: string) => value.toLowerCase().trim();
const sameText = (a: string, b: string) => lower(a) === lower(b);

function containsWord(text: string, word: string): boolean {
  const needle = lower(word);
  if (needle === '') return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(lower(text));
}

const ticketText = (ticket: Ticket) =>
  [
    ticket.summary,
    ticket.description,
    ticket.acceptanceCriteria ?? '',
    ticket.labels.join(' '),
  ].join('\n');

/**
 * Scores each module note against a ticket:
 *   a Jira component equal to one of the module's components or its name  +10
 *   a label equal to one of the module's labels                           +5
 *   the module name in the summary                                        +4
 *   a keyword in the summary                                              +3 each
 *   a keyword in the description or criteria                              +1 each (at most +3)
 */
export function matchModules(
  modules: ModuleNote[],
  ticket: Ticket,
  options: KnowledgeOptions = {},
): ModuleMatch[] {
  const minScore = options.minModuleScore ?? 3;
  const components = ticket.components ?? [];
  const matches: ModuleMatch[] = [];

  for (const module of modules) {
    let score = 0;
    const reasons: string[] = [];

    for (const component of components) {
      if (
        sameText(component, module.name) ||
        module.components.some((c) => sameText(c, component))
      ) {
        score += 10;
        reasons.push(`component "${component}"`);
      }
    }
    for (const label of ticket.labels) {
      if (module.labels.some((l) => sameText(l, label))) {
        score += 5;
        reasons.push(`label "${label}"`);
      }
    }
    if (containsWord(ticket.summary, module.name)) {
      score += 4;
      reasons.push(`module name in the summary`);
    }

    let bodyHits = 0;
    for (const keyword of module.keywords) {
      if (containsWord(ticket.summary, keyword)) {
        score += 3;
        reasons.push(`keyword "${keyword}" in the summary`);
      } else if (
        bodyHits < 3 &&
        containsWord(`${ticket.description}\n${ticket.acceptanceCriteria ?? ''}`, keyword)
      ) {
        score += 1;
        bodyHits++;
        reasons.push(`keyword "${keyword}" in the description`);
      }
    }

    if (score >= minScore) matches.push({ module, score, reasons });
  }

  return matches
    .sort((a, b) => b.score - a.score || a.module.name.localeCompare(b.module.name))
    .slice(0, options.maxModules ?? 2);
}

/**
 * The past cases most like the ticket. A case from a matched module gets a small boost,
 * but a very similar case from another module can still be chosen.
 */
export function matchPastCases(
  cases: PastCase[],
  ticket: Ticket,
  matchedModules: ModuleNote[],
  options: KnowledgeOptions = {},
): PastCaseMatch[] {
  const text = ticketText(ticket);
  const moduleNames = new Set(matchedModules.map((m) => lower(m.name)));
  const threshold = options.minCaseSimilarity ?? 0.06;

  return cases
    .map((pastCase) => {
      const base = similarity(
        text,
        `${pastCase.title} ${pastCase.steps.join(' ')} ${pastCase.expected}`,
      );
      const boost = pastCase.module && moduleNames.has(lower(pastCase.module)) ? 0.1 : 0;
      return { case: pastCase, score: base + (base > 0 ? boost : 0) };
    })
    .filter((match) => match.score >= threshold)
    .sort((a, b) => b.score - a.score || a.case.title.localeCompare(b.case.title))
    .slice(0, options.maxPastCases ?? 4);
}

/** What was chosen for a ticket and why. Shown to QA, never sent to the AI. */
export interface ContextMeta {
  modules: { name: string; score: number; reasons: string[] }[];
  /** Reviewed code overviews that were added. Left out when there are none. */
  codeNotes?: { name: string; score: number; reasons: string[] }[];
  pastCases: { title: string; source: string; score: number }[];
  hasProductKnowledge: boolean;
}

export type KnowledgeContext = PromptContext & { meta: ContextMeta };

/** Builds the context for one ticket: the fixed knowledge, the matching module notes and cases. */
export function buildKnowledgeContext(
  knowledge: Knowledge,
  ticket: Ticket,
  options: KnowledgeOptions = {},
): KnowledgeContext {
  const fixed = [
    knowledge.overview && `### Product overview\n${knowledge.overview}`,
    knowledge.glossary && `### Glossary\n${knowledge.glossary}`,
    knowledge.standards && `### Standards for test cases\n${knowledge.standards}`,
  ].filter((part): part is string => Boolean(part));

  const modules = matchModules(knowledge.modules, ticket, options);
  const cases = matchPastCases(
    knowledge.pastCases,
    ticket,
    modules.map((m) => m.module),
    options,
  );

  const codeNotes = matchModules(knowledge.codeNotes ?? [], ticket, {
    ...options,
    maxModules: options.maxCodeNotes ?? 1,
  });
  const notes = [
    ...modules.map((m) => `## Module: ${m.module.name}\n${m.module.body}`),
    ...codeNotes.map((m) => `## Code overview: ${m.module.name}\n${m.module.body}`),
  ];

  return {
    ...(fixed.length > 0 && { productKnowledge: fixed.join('\n\n') }),
    ...(notes.length > 0 && { moduleNotes: notes.join('\n\n') }),
    ...(cases.length > 0 && { pastCases: cases.map((m) => formatPastCase(m.case)) }),
    meta: {
      modules: modules.map((m) => ({ name: m.module.name, score: m.score, reasons: m.reasons })),
      ...(codeNotes.length > 0 && {
        codeNotes: codeNotes.map((m) => ({
          name: m.module.name,
          score: m.score,
          reasons: m.reasons,
        })),
      }),
      pastCases: cases.map((m) => ({
        title: m.case.title,
        source: m.case.source,
        score: Number(m.score.toFixed(3)),
      })),
      hasProductKnowledge: fixed.length > 0,
    },
  };
}
