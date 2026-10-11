/**
 * Quality check for the prompt: runs the real AI on the tickets in evals/tickets and
 * compares the result with QA's own cases. Run by hand, never in CI.
 *
 *   npm run eval                      all example tickets
 *   npm run eval -- bulk              only files whose name contains "bulk"
 *
 * The comparison is a rough guide. A person still reads the cases and decides if they are good.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadConfig } from '../config/env.js';
import { AIError } from './errors.js';
import { loadEvalFile } from './eval-file.js';
import { generateTestCases, GenerationError } from './generate.js';
import { createProvider } from './index.js';
import type { TestCase } from './schemas.js';
import { similarity } from '../util/similarity.js';
import { UsageTracker } from './types.js';

const EVALS_DIR = path.resolve('evals', 'tickets');
const OUT_DIR = path.resolve('out');
const MATCH_THRESHOLD = 0.35;

/** Share of QA's reference cases that have a similar generated case. */
function referenceRecall(
  reference: { title: string; expected: string }[],
  cases: TestCase[],
): { matched: number; missed: string[] } {
  const missed: string[] = [];
  let matched = 0;
  for (const ref of reference) {
    const refText = `${ref.title} ${ref.expected}`;
    const best = Math.max(0, ...cases.map((c) => similarity(refText, `${c.title} ${c.expected}`)));
    if (best >= MATCH_THRESHOLD) matched++;
    else missed.push(ref.title);
  }
  return { matched, missed };
}

async function main(): Promise<void> {
  const { ai } = loadConfig();
  if (ai.provider === 'fake') {
    console.error('AI_PROVIDER is "fake". Set AI_PROVIDER=gemini (with AI_API_KEY and AI_MODEL).');
    process.exitCode = 1;
    return;
  }

  const filter = process.argv[2]?.toLowerCase();
  const files = (await readdir(EVALS_DIR))
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !filter || name.toLowerCase().includes(filter))
    .sort();
  if (files.length === 0) {
    console.error(`No evaluation tickets found in ${EVALS_DIR}.`);
    process.exitCode = 1;
    return;
  }

  const provider = createProvider(ai, {
    onSwitch: (e) =>
      console.log(
        `! ${e.from} has used its daily limit. ${e.to ? `Switching to ${e.to}.` : 'No other model is left.'}`,
      ),
  });
  const usage = new UsageTracker();
  const report: unknown[] = [];

  console.log(`Provider: ${provider.name}${ai.model ? ` (${ai.model})` : ''}`);
  console.log(`Tickets: ${files.length}\n`);

  for (const file of files) {
    const parsed = await loadEvalFile(path.join(EVALS_DIR, file));
    console.log(`== ${file}: ${parsed.ticket.key} ${parsed.ticket.summary}`);

    try {
      const result = await generateTestCases(provider, parsed.ticket, { usage });
      const recall = referenceRecall(parsed.reference, result.cases);

      const byStep = new Map<string, number>();
      for (const c of result.cases) byStep.set(c.flow_step, (byStep.get(c.flow_step) ?? 0) + 1);

      console.log(
        `   ${result.cases.length} cases | attempts: ${result.attempts} | reviewed: ${result.reviewed} | ` +
          `${result.usage.totalTokens} tokens`,
      );
      console.log(`   steps: ${[...byStep].map(([step, n]) => `${step} ${n}`).join(', ')}`);
      if (parsed.reference.length > 0) {
        console.log(`   matches ${recall.matched} of ${parsed.reference.length} reference cases`);
        for (const title of recall.missed) console.log(`   - not covered: ${title}`);
      }
      if (result.reviewNote) console.log(`   note: ${result.reviewNote}`);
      for (const c of result.cases) {
        console.log(`   ${c.id} [${c.type}/${c.priority}] ${c.flow_step}: ${c.title}`);
      }

      report.push({
        file,
        ...result,
        referenceMatched: recall.matched,
        referenceMissed: recall.missed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`   FAILED: ${message}`);
      report.push({ file, error: message });
      if (error instanceof AIError && ['unauthorized', 'model_not_found'].includes(error.kind))
        break;
    }
    console.log('');
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(outFile, JSON.stringify(report, null, 2));

  console.log(`Total: ${usage.calls} AI calls, ${usage.total.totalTokens} tokens.`);
  console.log(`Full results: ${path.relative(process.cwd(), outFile)}`);
}

main().catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof AIError ||
    error instanceof GenerationError
  ) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
