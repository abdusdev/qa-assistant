import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitivePath, redactSecrets } from '../../../src/github/redact.js';

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.production',
    'app/.env.local',
    'services/orders/.env',
    'cypress/cypress.env.json',
    'certs/server.pem',
    'deploy/signing.key',
    'keys/id_rsa',
    'config/secrets/app.yml',
    'infra/credentials.json',
    'terraform.tfstate',
    'prod.tfvars',
    '.npmrc',
  ])('treats %s as private', (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    'src/environment.ts',
    'src/components/KeyboardShortcuts.tsx',
    'docs/secrets-management.md',
    'src/env.example.ts',
    'app_2/src/components/address/rateAffectingAddress.ts',
  ])('does not treat %s as private', (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });
});

describe('redactSecrets', () => {
  const redact = (text: string) => redactSecrets(text);

  it('replaces well-known token formats', () => {
    const samples = [
      'ghp_' + 'a'.repeat(36),
      'github_pat_' + 'B'.repeat(30),
      'AKIA' + 'ABCDEFGHIJKLMNOP',
      'AIza' + 'x'.repeat(35),
      'xoxb-' + '1234567890-abcdef',
      'ATATT' + 'z'.repeat(30),
      'sk_live_' + 'q'.repeat(24),
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    ];

    for (const secret of samples) {
      const result = redact(`const value = ${secret};`);
      expect(result.text).not.toContain(secret);
      expect(result.text).toContain(REDACTED);
      expect(result.count).toBeGreaterThan(0);
    }
  });

  it('replaces a whole private key block, over several lines', () => {
    const text = [
      '+-----BEGIN RSA PRIVATE KEY-----',
      '+MIIEowIBAAKCAQEAxyz',
      '+abcdef1234567890',
      '+-----END RSA PRIVATE KEY-----',
      '+const next = 1',
    ].join('\n');

    const result = redact(text);

    expect(result.text).not.toContain('MIIEowIBAAKCAQEAxyz');
    expect(result.text).not.toContain('abcdef1234567890');
    expect(result.text).toContain('const next = 1');
  });

  it('replaces a key block that was cut before its end', () => {
    const result = redact('+-----BEGIN PRIVATE KEY-----\n+MIIEvQIBADANBgkqhkiG9w0B');

    expect(result.text).not.toContain('MIIEvQ');
  });

  it('replaces quoted values of secret-looking names and keeps the name', () => {
    const result = redact(
      [
        'const password = "Sup3rSecretValue";',
        "apiKey: 'abcd1234efgh5678',",
        '"client_secret": "zzzzzzzzzzzz"',
      ].join('\n'),
    );

    expect(result.text).toContain('password = "' + REDACTED + '"');
    expect(result.text).toContain("apiKey: '" + REDACTED + "'");
    expect(result.text).toContain('"client_secret": "' + REDACTED + '"');
    expect(result.text).not.toContain('Sup3rSecretValue');
    expect(result.text).not.toContain('abcd1234efgh5678');
    expect(result.count).toBe(3);
  });

  it('replaces values in env-style lines, with or without a diff marker', () => {
    const result = redact(
      '+DATABASE_PASSWORD=hunter2hunter2\nexport API_TOKEN=abc123def456\nPORT=3000',
    );

    expect(result.text).toContain('+DATABASE_PASSWORD=' + REDACTED);
    expect(result.text).toContain('export API_TOKEN=' + REDACTED);
    expect(result.text).toContain('PORT=3000');
  });

  it('replaces credentials inside a URL and bearer tokens', () => {
    const result = redact(
      'const url = "postgres://admin:s3cretpass@db.internal:5432/app";\n' +
        'headers = { Authorization: "Bearer abcdefghijklmnop1234567890" }',
    );

    expect(result.text).not.toContain('s3cretpass');
    expect(result.text).toContain('postgres://' + REDACTED + '@db.internal');
    expect(result.text).not.toContain('abcdefghijklmnop1234567890');
  });

  it('leaves ordinary code and screen text alone', () => {
    const text = [
      'token: string',
      'const passwordLabel = "Your password";',
      'placeholder="Enter password"',
      'if (!token) return',
      'label: "The destination changed. Fetch new quotes before booking."',
      "const author = 'Jane Smith'",
      'PORT=3000',
      'const postalCode = "90210"',
    ].join('\n');

    const result = redact(text);

    expect(result.text).toBe(text);
    expect(result.count).toBe(0);
  });

  it('counts every replacement', () => {
    const result = redact(`a = "ghp_${'k'.repeat(36)}"\nb = "ghp_${'m'.repeat(36)}"`);

    expect(result.count).toBe(2);
  });
});
