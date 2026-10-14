import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config/env.js';

describe('loadConfig', () => {
  it('applies defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      env: 'development',
      port: 3000,
      logLevel: 'info',
      databaseRetentionDays: 90,
      maxConcurrentRuns: 1,
      rateLimitPerMinute: 300,
      generateLimitPerMinute: 20,
      trustProxy: false,
      enableHsts: false,
      ai: { provider: 'fake', maxOutputTokens: 8192, fallbackModels: [] },
    });
  });

  it('reads the API settings', () => {
    const config = loadConfig({
      API_TOKEN: 'a-long-enough-token',
      MAX_CONCURRENT_RUNS: '3',
      TICKET_FIXTURES_DIR: 'evals/tickets',
    });

    expect(config).toMatchObject({
      apiToken: 'a-long-enough-token',
      maxConcurrentRuns: 3,
      ticketFixturesDir: 'evals/tickets',
    });
  });

  it('reads the limits and the proxy settings', () => {
    const config = loadConfig({
      RATE_LIMIT_PER_MINUTE: '60',
      GENERATE_LIMIT_PER_MINUTE: '5',
      TRUST_PROXY: 'true',
      ENABLE_HSTS: 'yes',
    });

    expect(config).toMatchObject({
      rateLimitPerMinute: 60,
      generateLimitPerMinute: 5,
      trustProxy: true,
      enableHsts: true,
    });
  });

  it('rejects a limit of zero', () => {
    expect(() => loadConfig({ RATE_LIMIT_PER_MINUTE: '0' })).toThrow(/RATE_LIMIT_PER_MINUTE/);
    expect(() => loadConfig({ GENERATE_LIMIT_PER_MINUTE: '0' })).toThrow(
      /GENERATE_LIMIT_PER_MINUTE/,
    );
  });

  it('rejects a token that is too short and a concurrency of zero', () => {
    expect(() => loadConfig({ API_TOKEN: 'short' })).toThrow(/API_TOKEN/);
    expect(() => loadConfig({ MAX_CONCURRENT_RUNS: '0' })).toThrow(/MAX_CONCURRENT_RUNS/);
  });

  it('reads a complete Jira connection and trims the trailing slash', () => {
    const config = loadConfig({
      JIRA_BASE_URL: 'https://example.atlassian.net/',
      JIRA_EMAIL: 'bot@example.com',
      JIRA_API_TOKEN: 'token-value',
      JIRA_AC_FIELD: 'customfield_10042',
    });
    expect(config.jira).toEqual({
      baseUrl: 'https://example.atlassian.net',
      email: 'bot@example.com',
      apiToken: 'token-value',
      project: 'SHP',
      enableRelease: false,
      acceptanceCriteriaField: 'customfield_10042',
    });
  });

  it('keeps release input off by default and turns it on with JIRA_ENABLE_RELEASE', () => {
    const jira = {
      JIRA_BASE_URL: 'https://example.atlassian.net',
      JIRA_EMAIL: 'bot@example.com',
      JIRA_API_TOKEN: 'token-value',
    };

    expect(loadConfig(jira).jira?.enableRelease).toBe(false);
    expect(loadConfig({ ...jira, JIRA_ENABLE_RELEASE: 'true' }).jira?.enableRelease).toBe(true);
    expect(loadConfig({ ...jira, JIRA_ENABLE_RELEASE: 'false' }).jira?.enableRelease).toBe(false);
    expect(() => loadConfig({ ...jira, JIRA_ENABLE_RELEASE: 'maybe' })).toThrow(
      /JIRA_ENABLE_RELEASE/,
    );
  });

  it('treats empty values as not set', () => {
    const config = loadConfig({ JIRA_BASE_URL: '', JIRA_EMAIL: '  ', PORT: '' });
    expect(config.jira).toBeUndefined();
    expect(config.port).toBe(3000);
  });

  it('splits the GitHub repository list', () => {
    const config = loadConfig({
      GITHUB_TOKEN: 'gh-token',
      GITHUB_REPOS: 'org/api, org/web ,',
    });
    expect(config.github).toEqual({
      token: 'gh-token',
      repos: ['org/api', 'org/web'],
      codeContext: true,
      allowCodeToAi: false,
    });
  });

  it('names the missing Jira settings when only some are set', () => {
    expect(() => loadConfig({ JIRA_BASE_URL: 'https://example.atlassian.net' })).toThrow(
      ConfigError,
    );

    try {
      loadConfig({ JIRA_BASE_URL: 'https://example.atlassian.net' });
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain('JIRA_EMAIL');
      expect(message).toContain('JIRA_API_TOKEN');
      expect(message).not.toContain('JIRA_BASE_URL:');
    }
  });

  it('requires an API key and a model when the real AI provider is chosen', () => {
    expect(() => loadConfig({ AI_PROVIDER: 'gemini' })).toThrow(/AI_API_KEY[\s\S]*AI_MODEL/);
    expect(() => loadConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'key' })).toThrow(/AI_MODEL/);
    expect(() => loadConfig({ AI_PROVIDER: 'gemini', AI_MODEL: 'some-model' })).toThrow(
      /AI_API_KEY/,
    );
    expect(
      loadConfig({ AI_PROVIDER: 'gemini', AI_API_KEY: 'key', AI_MODEL: 'some-model' }).ai,
    ).toEqual({
      provider: 'gemini',
      apiKey: 'key',
      model: 'some-model',
      maxOutputTokens: 8192,
      fallbackModels: [],
    });
  });

  it('does not need a key or model for the fake provider', () => {
    expect(loadConfig({ AI_PROVIDER: 'fake' }).ai).toEqual({
      provider: 'fake',
      maxOutputTokens: 8192,
      fallbackModels: [],
    });
  });

  it('reads the fallback models in order, trimmed and without repeats', () => {
    const config = loadConfig({
      AI_PROVIDER: 'gemini',
      AI_API_KEY: 'key',
      AI_MODEL: 'model-a',
      AI_FALLBACK_MODELS: ' model-b, model-c ,model-b,,model-a ',
    });

    expect(config.ai.fallbackModels).toEqual(['model-b', 'model-c']);
  });

  it('reads and bounds the output token cap', () => {
    expect(loadConfig({ AI_MAX_OUTPUT_TOKENS: '4000' }).ai.maxOutputTokens).toBe(4000);
    expect(() => loadConfig({ AI_MAX_OUTPUT_TOKENS: '10' })).toThrow(/AI_MAX_OUTPUT_TOKENS/);
    expect(() => loadConfig({ AI_MAX_OUTPUT_TOKENS: '9999999' })).toThrow(/AI_MAX_OUTPUT_TOKENS/);
    expect(() => loadConfig({ AI_MAX_OUTPUT_TOKENS: 'lots' })).toThrow(/AI_MAX_OUTPUT_TOKENS/);
  });

  it('rejects an invalid port and an unknown provider', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ AI_PROVIDER: 'other' })).toThrow(/AI_PROVIDER/);
  });

  it('rejects malformed URLs and emails', () => {
    expect(() => loadConfig({ DATABASE_URL: 'not a url' })).toThrow(/DATABASE_URL/);
    expect(() =>
      loadConfig({
        JIRA_BASE_URL: 'nope',
        JIRA_EMAIL: 'not-an-email',
        JIRA_API_TOKEN: 'secret-token',
      }),
    ).toThrow(/JIRA_BASE_URL[\s\S]*JIRA_EMAIL/);
  });

  it('never includes setting values in the error message', () => {
    try {
      loadConfig({
        JIRA_BASE_URL: 'nope',
        JIRA_EMAIL: 'not-an-email',
        JIRA_API_TOKEN: 'super-secret-token',
        AI_API_KEY: 'super-secret-key',
        PORT: 'abc',
      });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('super-secret-token');
      expect(message).not.toContain('super-secret-key');
    }
  });
});
