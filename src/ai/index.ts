import type { AppConfig } from '../config/env.js';
import { AIError } from './errors.js';
import { FakeAIProvider } from './fake.js';
import { GeminiProvider } from './gemini.js';
import type { AIProvider } from './types.js';

export { AIError } from './errors.js';
export type { AIErrorKind } from './errors.js';
export { FakeAIProvider } from './fake.js';
export type { FakeAIOptions, FakeReply } from './fake.js';
export { GeminiProvider } from './gemini.js';
export type { GeminiConfig, GeminiOptions } from './gemini.js';
export { UsageTracker } from './types.js';
export type { AIProvider, AIRequest, AIResponse, AIUsage } from './types.js';

/** Builds the provider chosen by AI_PROVIDER. Switching providers is only a setting. */
export function createProvider(config: AppConfig['ai']): AIProvider {
  switch (config.provider) {
    case 'fake':
      return new FakeAIProvider({ fallback: '{}' });
    case 'gemini': {
      if (!config.apiKey || !config.model) {
        throw new AIError('invalid_request', 'Gemini needs AI_API_KEY and AI_MODEL to be set.');
      }
      return new GeminiProvider({
        apiKey: config.apiKey,
        model: config.model,
        maxOutputTokens: config.maxOutputTokens,
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
