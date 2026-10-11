import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config/env.js';

describe('loadConfig', () => {
  it('applies defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      env: 'development',
      port: 3000,
      logLevel: 'info',
      ai: { provider: 'fake', maxOutputTokens: 8192 },
    });
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
    expect(config.github).toEqual({ token: 'gh-token', repos: ['org/api', 'org/web'] });
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
    ).toEqual({ provider: 'gemini', apiKey: 'key', model: 'some-model', maxOutputTokens: 8192 });
  });

  it('does not need a key or model for the fake provider', () => {
    expect(loadConfig({ AI_PROVIDER: 'fake' }).ai).toEqual({
      provider: 'fake',
      maxOutputTokens: 8192,
    });
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
