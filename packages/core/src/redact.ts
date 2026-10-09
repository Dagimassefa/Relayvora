export interface RedactionRule {
  id: string;
  pattern: RegExp;
  /** Builds the replacement from the regex match groups; defaults to a full replacement. */
  replace?: (match: string, ...groups: string[]) => string;
}

export interface RedactionFinding {
  rule: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

const mask = (rule: string) => `[REDACTED:${rule}]`;

// Order matters: specific provider formats run before generic assignment rules.
export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    id: 'private-key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe-key', pattern: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    id: 'auth-header',
    pattern: /(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s'"]+/gi,
    replace: (_m, prefix = '') => `${prefix}${mask('auth-header')}`,
  },
  {
    id: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi,
    replace: (_m, prefix = '') => `${prefix}${mask('url-credentials')}@`,
  },
  {
    // ENV-style assignments: API_TOKEN=..., DB_PASSWORD: "..."
    id: 'env-secret',
    pattern:
      /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*[=:]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s'"]+)/g,
    replace: (_m, key = '', sep = '') => `${key}${sep}${mask('env-secret')}`,
  },
  {
    // Quoted literals assigned to secret-ish identifiers in code: password = "hunter22"
    id: 'secret-literal',
    pattern: /\b([\w.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[\w.-]*["']?\s*[:=]\s*)(["'])([^"'\s]{6,})\2/gi,
    replace: (_m, prefix = '', quote = '') => `${prefix}${quote}${mask('secret-literal')}${quote}`,
  },
];

/** Scrubs credentials from text before it can reach an agent, a log, or an export. */
export function redact(text: string, rules: readonly RedactionRule[] = DEFAULT_RULES): RedactionResult {
  const counts = new Map<string, number>();
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      if (match.includes('[REDACTED:')) return match;
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      const groups = rest.filter((g): g is string => typeof g === 'string');
      return rule.replace ? rule.replace(match, ...groups) : mask(rule.id);
    });
  }
  return { text: result, findings: [...counts].map(([rule, count]) => ({ rule, count })) };
}

const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const SAFE_ENV_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

/** Files whose contents must never be inlined into a handoff, regardless of redaction. */
export function isSensitivePath(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base === '.env' || base.startsWith('.env.')) {
    return !SAFE_ENV_SUFFIXES.some((s) => base.endsWith(s));
  }
  if (SENSITIVE_BASENAMES.has(base)) return true;
  return /\.(pem|key|p12|pfx|keystore|jks)$/.test(base);
}
