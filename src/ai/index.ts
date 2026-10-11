import type { AppConfig } from '../config/env.js';
import { AIError } from './errors.js';
import { FakeAIProvider } from './fake.js';
import { FallbackProvider, type ModelSwitch } from './fallback.js';
import { GeminiProvider } from './gemini.js';
import type { AIProvider } from './types.js';

export { AIError } from './errors.js';
export type { AIErrorKind } from './errors.js';
export { FakeAIProvider } from './fake.js';
export type { FakeAIOptions, FakeReply } from './fake.js';
export { FallbackProvider } from './fallback.js';
export type { FallbackEntry, FallbackOptions, ModelSwitch } from './fallback.js';
export { GeminiProvider } from './gemini.js';
export type { GeminiConfig, GeminiOptions } from './gemini.js';
export { UsageTracker } from './types.js';
export type { AIProvider, AIRequest, AIResponse, AIUsage } from './types.js';

export interface CreateProviderOptions {
  /** Told when a model runs out of daily quota and the next one takes over. */
  onSwitch?: (event: ModelSwitch) => void;
}

/**
 * Builds the provider chosen by AI_PROVIDER. Switching providers is only a setting.
 * With AI_FALLBACK_MODELS set, the models are tried in order as each one runs out of quota.
 */
export function createProvider(
  config: AppConfig['ai'],
  options: CreateProviderOptions = {},
): AIProvider {
  switch (config.provider) {
    case 'fake':
      return new FakeAIProvider({ fallback: '{}' });
    case 'gemini': {
      if (!config.apiKey || !config.model) {
        throw new AIError('invalid_request', 'Gemini needs AI_API_KEY and AI_MODEL to be set.');
      }
      const apiKey = config.apiKey;
      const models = [config.model, ...(config.fallbackModels ?? [])].filter(
        (model, index, all) => all.indexOf(model) === index,
      );
      const entries = models.map((model) => ({
        label: model,
        provider: new GeminiProvider({ apiKey, model, maxOutputTokens: config.maxOutputTokens }),
      }));

      const [only] = entries;
      if (entries.length === 1 && only) return only.provider;
      return new FallbackProvider(entries, {
        ...(options.onSwitch && { onSwitch: options.onSwitch }),
      });
    }
  }
}

export { generateTestCases, GenerationError } from './generate.js';
export type { GenerateOptions, GenerateResult } from './generate.js';
export { extractJson, JsonExtractionError } from './json.js';
export {
  buildGenerationPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
  neutralizeTags,
  PROMPT_VERSION,
} from './prompt.js';
export type { BuiltPrompt, PromptContext } from './prompt.js';
export {
  checkFlow,
  DEFAULT_FLOW_STEPS,
  flowSchema,
  generatedCasesSchema,
  testCaseSchema,
} from './schemas.js';
export type { Flow, FlowStep, TestCase } from './schemas.js';
export { FlowError, generateFlow } from './flow.js';
export type { FlowOptions, FlowResult } from './flow.js';
export { buildFlowPrompt } from './prompt.js';
export type { FlowPromptCase } from './prompt.js';
