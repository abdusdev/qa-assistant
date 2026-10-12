import type { Ticket } from '../jira/ticket.js';
import { wordsOf } from '../util/similarity.js';
import type { PromptContext } from './prompt.js';
import type { CaseSource, SourceKind, TestCase } from './schemas.js';

/** The text the model was given, by part. Used to check what it claims to have read. */
export interface Evidence {
  parts: Record<Exclude<SourceKind, 'inferred'>, string>;
  /** Everything above, joined. */
  all: string;
}

const PART_ORDER = [
  'ticket',
  'acceptance_criteria',
  'comment',
  'module_notes',
  'past_cases',
  'code_changes',
] as const;

const MIN_COVERAGE = 0.8;
const MIN_WORDS_FOR_FUZZY = 3;

/** Lowercase, one space between words, no markdown decoration or quote marks. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_>#]+/g, ' ')
    .replace(/[‘’“”"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildEvidence(ticket: Ticket, context: PromptContext = {}): Evidence {
  const parts: Evidence['parts'] = {
    ticket: [ticket.summary, ticket.description, ticket.labels.join(' ')].join('\n'),
    acceptance_criteria: ticket.acceptanceCriteria ?? '',
    comment: ticket.comments.map((c) => c.body).join('\n'),
    module_notes: [context.productKnowledge, context.moduleNotes].filter(Boolean).join('\n'),
    past_cases: (context.pastCases ?? []).join('\n'),
    code_changes: context.codeChanges ?? '',
  };
  return { parts, all: PART_ORDER.map((key) => parts[key]).join('\n') };
}

/**
 * Is this text really present in the haystack?
 * Exact (after tidying) or, for longer quotes, most of its words, since models paraphrase a little.
 */
export function appearsIn(quote: string, haystack: string): boolean {
  const needle = normalize(quote);
  if (needle === '') return false;

  const text = normalize(haystack);
  if (text.includes(needle)) return true;

  const words = wordsOf(needle);
  if (words.size < MIN_WORDS_FOR_FUZZY) return false;
  const available = wordsOf(text);
  let found = 0;
  for (const word of words) if (available.has(word)) found++;
  return found / words.size >= MIN_COVERAGE;
}

/** Quoted button names, labels and messages in a text, such as 'Confirm Save'. */
export function quotedTexts(value: string): string[] {
  const found: string[] = [];
  const pattern = /(?<![\p{L}\p{N}])(['"‘“])([^'"‘’“”]{3,80})(['"’”])(?![\p{L}\p{N}])/gu;
  for (const match of value.matchAll(pattern)) {
    const inner = match[2]?.trim();
    if (inner) found.push(inner);
  }
  return found;
}

export interface UnbackedDetail {
  detail: string;
  kind: 'status code' | 'endpoint' | 'number';
}

const STATUS_NAMES =
  'Bad Request|Unauthorized|Forbidden|Not Found|Conflict|Gone|Unprocessable|Too Many Requests|' +
  'Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Precondition Failed';

const STATUS_CODE_PATTERNS = [
  /\b(?:http|status(?: code)?|code|error|response|returns?|responds?(?: with)?)\s*:?\s*([1-5]\d{2})\b/gi,
  new RegExp(`\\b([1-5]\\d{2})\\s+(?:${STATUS_NAMES})\\b`, 'gi'),
  new RegExp(`\\b(?:${STATUS_NAMES})\\s*\\(([1-5]\\d{2})\\)`, 'gi'),
];

const ENDPOINT_PATTERN = /(?<![A-Za-z0-9)\].])\/(?:[A-Za-z0-9_{}:.-]+\/)*[A-Za-z0-9_{}:-]{3,}/g;
const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Specific details a case states that are not in the ticket or the context: HTTP status codes,
 * endpoint paths and numbers of 10 or more. A number one away from a number in the evidence is
 * allowed, because boundary cases are made that way (limit 100, test 101).
 * It catches invented values, not a real value used for the wrong thing.
 */
export function unbackedDetails(text: string, evidence: string): UnbackedDetail[] {
  const haystack = evidence.toLowerCase();
  const withoutKeys = text.replace(TICKET_KEY, ' ');
  const found: UnbackedDetail[] = [];
  const seen = new Set<string>();
  const add = (detail: string, kind: UnbackedDetail['kind']) => {
    if (seen.has(detail)) return;
    seen.add(detail);
    found.push({ detail, kind });
  };

  for (const pattern of STATUS_CODE_PATTERNS) {
    for (const match of withoutKeys.matchAll(pattern)) {
      const code = match[1];
      if (code && !new RegExp('(?<![0-9])' + code + '(?![0-9])').test(evidence)) {
        add(code, 'status code');
      }
    }
  }

  for (const match of withoutKeys.matchAll(ENDPOINT_PATTERN)) {
    const path = match[0].replace(/[.,;:]+$/, '');
    if (!haystack.includes(path.toLowerCase())) add(path, 'endpoint');
  }

  const evidenceNumbers = new Set(
    (evidence.replace(TICKET_KEY, ' ').match(/\d+(?:\.\d+)?/g) ?? []).map(Number),
  );
  for (const match of withoutKeys.matchAll(
    /(?<![A-Za-z0-9./#-])\d{2,}(?:\.\d+)?(?![A-Za-z0-9/])/g,
  )) {
    const value = Number(match[0]);
    const known = [value, value - 1, value + 1].some((n) => evidenceNumbers.has(n));
    if (!known && !seen.has(match[0])) add(match[0], 'number');
  }

  return found;
}

const clip = (value: string, max = 120) =>
  value.length > max ? `${value.slice(0, max)}...` : value;

function verifySource(source: CaseSource, evidence: Evidence): CaseSource | undefined {
  if (source.from === 'inferred') return source;
  if (source.quote.trim() === '') return undefined;

  // Right part first, then any part (the model may have named the wrong one).
  if (appearsIn(source.quote, evidence.parts[source.from])) return source;
  for (const part of PART_ORDER) {
    if (part !== source.from && appearsIn(source.quote, evidence.parts[part])) {
      return { from: part, quote: source.quote };
    }
  }
  return undefined;
}

/**
 * Checks one case against what the model was actually given:
 * - a cited source must really appear in that part, or it is dropped and listed as an assumption
 * - a quoted label or message that appears nowhere is listed as an assumption
 * - the case is "grounded" only with a verified source and nothing assumed; with a verified
 *   source but assumptions it is "partly"; with no verified source it is "assumed"
 * The model's own claims are never trusted without this check.
 */
export function groundCase(testCase: TestCase, evidence: Evidence): TestCase {
  const assumptions = [...testCase.assumptions];
  const add = (note: string) => {
    if (!assumptions.includes(note)) assumptions.push(note);
  };

  const sources: CaseSource[] = [];
  for (const source of testCase.sources) {
    const verified = verifySource(source, evidence);
    if (verified) sources.push(verified);
    else add(`A source was cited that is not in the ticket or context: "${clip(source.quote)}".`);
  }

  if (testCase.sources.length === 0) add('No source was given for this case.');

  const visible = [testCase.title, ...testCase.steps, testCase.expected, ...testCase.preconditions];
  const unbacked = new Set<string>();
  for (const text of visible) {
    for (const quoted of quotedTexts(text)) {
      if (!appearsIn(quoted, evidence.all)) unbacked.add(quoted);
    }
  }
  for (const quoted of unbacked) {
    add(
      `The label or message "${clip(quoted, 80)}" is not in the ticket or context. Confirm the exact text.`,
    );
  }

  for (const { detail, kind } of unbackedDetails(visible.join('\n'), evidence.all).slice(0, 4)) {
    add(`The ${kind} "${detail}" is not in the ticket or context. Confirm it.`);
  }

  const hasEvidence = sources.some((source) => source.from !== 'inferred');
  return {
    ...testCase,
    sources,
    assumptions,
    grounding: !hasEvidence ? 'assumed' : assumptions.length === 0 ? 'grounded' : 'partly',
  };
}

export interface DetailAssessment {
  sufficient: boolean;
  missing: string[];
}

/**
 * A cheap check that does not need the model: a ticket with almost no text cannot support
 * reliable cases. The model gives its own, finer view in its answer.
 */
export function assessTicketDetail(ticket: Ticket): DetailAssessment {
  const text = `${ticket.description}\n${ticket.acceptanceCriteria ?? ''}`;
  const words = text.split(/\s+/).filter(Boolean).length;
  const hasCriteria = (ticket.acceptanceCriteria ?? '').trim() !== '';

  if (words < 15) {
    return { sufficient: false, missing: ['The ticket has almost no description.'] };
  }
  if (words < 40 && !hasCriteria) {
    return {
      sufficient: false,
      missing: ['The description is short and there are no acceptance criteria.'],
    };
  }
  return { sufficient: true, missing: [] };
}

/** Combines the quick check and the model's view. Insufficient if either says so. */
export function mergeDetail(
  quick: DetailAssessment,
  model: { sufficient: boolean; missing: string[] } | undefined,
): DetailAssessment {
  const missing = [...new Set([...quick.missing, ...(model?.missing ?? [])])];
  const sufficient = quick.sufficient && (model?.sufficient ?? true);
  return { sufficient, missing: sufficient ? [] : missing };
}
