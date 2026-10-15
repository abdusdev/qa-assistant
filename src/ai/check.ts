/**
 * Connection check: makes one tiny call to the configured AI provider.
 *   npm run ai:check
 * Sends a fixed, harmless sentence (never ticket text) and prints the answer and token use.
 */
import { ConfigError, loadConfig } from '../config/env.js';
import { AIError } from './errors.js';
import { createProvider } from './index.js';

async function main(): Promise<void> {
  const { ai } = loadConfig();
  const provider = createProvider(ai, {
    onSwitch: (e) =>
      console.log(
        `! ${e.from} has used its daily limit. ${e.to ? `Switching to ${e.to}.` : 'No other model is left.'}`,
      ),
  });

  console.log(`Provider: ${provider.name}${ai.model ? ` (model: ${ai.model})` : ''}`);
  if (provider.name === 'fake') {
    console.log(
      'AI_PROVIDER is "fake", so no real call is made. Set AI_PROVIDER to gemini, openai or grok to test.',
    );
  }

  const started = Date.now();
  const response = await provider.generate({
    system: 'You answer with a single short JSON object and nothing else.',
    prompt: 'Return {"ok": true, "word": "<any one common English word>"}.',
    json: true,
    maxOutputTokens: 256,
    temperature: 0,
  });

  console.log(`Answer: ${response.text.trim()}`);
  console.log(
    `Tokens: ${response.usage.inputTokens} in, ${response.usage.outputTokens} out ` +
      `(${response.usage.totalTokens} total)`,
  );
  console.log(`Model: ${response.model} | ${Date.now() - started} ms`);
  if (response.truncated) console.log('Warning: the answer was cut off by the output limit.');
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof AIError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
