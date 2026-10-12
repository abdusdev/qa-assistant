import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';
import { decideCodeContext } from '../../../src/github/settings.js';

const configWith = (env: Record<string, string> = {}) => loadConfig({ ...env });

const github = { GITHUB_TOKEN: 'gh-token', GITHUB_REPOS: 'acme/shop' };
const real = { realTickets: true, flags: {} };

describe('decideCodeContext', () => {
  it('is on by default for real tickets once GitHub is set up and agreed to', () => {
    const decision = decideCodeContext(configWith({ ...github, ALLOW_CODE_TO_AI: 'true' }), real);

    expect(decision).toEqual({ use: true, repos: ['acme/shop'] });
  });

  it('stops the run, instead of leaving the code out, when sending code is not approved', () => {
    const decision = decideCodeContext(configWith(github), real);

    expect(decision).toMatchObject({ use: false });
    expect('error' in decision && decision.error).toContain('ALLOW_CODE_TO_AI=true');
    expect('error' in decision && decision.error).toContain('--no-code-context');
  });

  it('accepts the approval for one run with a flag', () => {
    const decision = decideCodeContext(configWith(github), {
      realTickets: true,
      flags: { allow: true },
    });

    expect(decision).toEqual({ use: true, repos: ['acme/shop'] });
  });

  it('can be turned off for one run, even when approved', () => {
    const decision = decideCodeContext(configWith({ ...github, ALLOW_CODE_TO_AI: 'true' }), {
      realTickets: true,
      flags: { off: true },
    });

    expect(decision).toMatchObject({ use: false, warn: false });
    expect('reason' in decision && decision.reason).toContain('--no-code-context');
  });

  it('can be turned off in the settings', () => {
    const decision = decideCodeContext(
      configWith({ ...github, ALLOW_CODE_TO_AI: 'true', CODE_CONTEXT: 'false' }),
      real,
    );

    expect(decision).toMatchObject({ use: false, warn: false });
    expect('reason' in decision && decision.reason).toContain('CODE_CONTEXT=false');
  });

  it('is not used for example ticket files unless asked for', () => {
    const settings = configWith({ ...github, ALLOW_CODE_TO_AI: 'true' });

    expect(decideCodeContext(settings, { realTickets: false, flags: {} })).toMatchObject({
      use: false,
      warn: false,
    });
    expect(decideCodeContext(settings, { realTickets: false, flags: { force: true } })).toEqual({
      use: true,
      repos: ['acme/shop'],
    });
  });

  it('warns, and continues without code, when GitHub is not set up', () => {
    const noToken = decideCodeContext(configWith(), real);
    const noRepos = decideCodeContext(configWith({ GITHUB_TOKEN: 'gh-token' }), real);

    expect(noToken).toMatchObject({ use: false, warn: true });
    expect('reason' in noToken && noToken.reason).toContain('GITHUB_TOKEN');
    expect(noRepos).toMatchObject({ use: false, warn: true });
    expect('reason' in noRepos && noRepos.reason).toContain('GITHUB_REPOS');
  });

  it('stops when code context was asked for by flag but GitHub is not set up', () => {
    const decision = decideCodeContext(configWith(), {
      realTickets: true,
      flags: { force: true },
    });

    expect('error' in decision && decision.error).toContain('GITHUB_TOKEN');
  });

  it('uses the setting even when CODE_CONTEXT=false if asked for by flag', () => {
    const decision = decideCodeContext(
      configWith({ ...github, ALLOW_CODE_TO_AI: 'true', CODE_CONTEXT: 'false' }),
      { realTickets: true, flags: { force: true } },
    );

    expect(decision).toEqual({ use: true, repos: ['acme/shop'] });
  });

  it('reads the new settings with their defaults', () => {
    expect(configWith(github).github).toMatchObject({ codeContext: true, allowCodeToAi: false });
    expect(
      configWith({ ...github, CODE_CONTEXT: 'false', ALLOW_CODE_TO_AI: 'yes' }).github,
    ).toMatchObject({ codeContext: false, allowCodeToAi: true });
  });
});
