import type { PromptContext } from '../ai/prompt.js';

/**
 * Puts the context of several sources into one. A later source wins for a text field, the
 * reports ("meta") are merged under their own names, and the warnings are added together.
 *
 *   combineContexts({ knowledge: knowledgeContext, code: codeContext })
 */
export function combineContexts(sources: Record<string, PromptContext | undefined>): PromptContext {
  const combined: PromptContext = {};
  const reports: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const [name, source] of Object.entries(sources)) {
    if (!source) continue;
    const { meta, warnings: own, ...rest } = source;
    Object.assign(combined, rest);
    if (meta !== undefined) reports[name] = meta;
    if (own) warnings.push(...own);
  }

  return {
    ...combined,
    ...(Object.keys(reports).length > 0 && { meta: flatten(reports) }),
    ...(warnings.length > 0 && { warnings }),
  };
}

/**
 * The knowledge report keeps its own shape at the top (as it did before there was a second
 * source) and every other source sits next to it under its name.
 */
function flatten(reports: Record<string, unknown>): Record<string, unknown> {
  const { knowledge, ...others } = reports;
  return {
    ...(knowledge !== null && typeof knowledge === 'object' ? (knowledge as object) : {}),
    ...others,
  };
}
