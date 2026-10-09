import { describe, expect, it } from 'vitest';
import { isSensitivePath, redact } from '../src/redact.js';

describe('redact', () => {
  it.each([
    ['anthropic-key', 'key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['openai-key', 'OPENAI sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['github-token', 'ghp_' + 'a'.repeat(36)],
    ['aws-access-key', 'AKIAABCDEFGHIJKLMNOP'],
    ['slack-token', 'xoxb-1234567890-abcdef'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ])('removes %s', (rule, input) => {
    const out = redact(input);
    expect(out.text).toContain(`[REDACTED:${rule}]`);
    expect(out.findings).toContainEqual({ rule, count: 1 });
  });

  it('removes private key blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
    expect(redact(`before\n${pem}\nafter`).text).toBe('before\n[REDACTED:private-key]\nafter');
  });

  it('keeps the key name for env-style secrets', () => {
    const out = redact('DATABASE_PASSWORD=hunter2\nAPI_TOKEN: "abc def"\nPORT=3000');
    expect(out.text).toBe('DATABASE_PASSWORD=[REDACTED:env-secret]\nAPI_TOKEN: [REDACTED:env-secret]\nPORT=3000');
  });

  it('redacts quoted literals but not code that merely mentions tokens', () => {
    expect(redact('const password = "correct-horse"').text).toBe('const password = "[REDACTED:secret-literal]"');
    const code = 'const token = await fetchToken(user);';
    expect(redact(code).text).toBe(code);
  });

  it('redacts credentials in URLs and auth headers', () => {
    expect(redact('postgres://admin:s3cret@db:5432/app').text).toBe('postgres://admin:[REDACTED:url-credentials]@db:5432/app');
    expect(redact('Authorization: Bearer abc.def.ghi').text).toBe('Authorization: Bearer [REDACTED:auth-header]');
  });

  it('does not double-redact', () => {
    const once = redact('OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx').text;
    expect(redact(once).text).toBe(once);
  });
});

describe('isSensitivePath', () => {
  it.each(['.env', 'app/.env.local', 'C:\\repo\\.env.production', 'id_ed25519', 'certs/server.pem', '.npmrc'])(
    'flags %s',
    (p) => expect(isSensitivePath(p)).toBe(true),
  );
  it.each(['.env.example', 'src/env.ts', 'README.md', 'keys.ts'])('allows %s', (p) => expect(isSensitivePath(p)).toBe(false));
});
