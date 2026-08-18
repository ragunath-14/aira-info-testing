/**
 * Secret redaction (spec sections 12, 31).
 *
 * Applied on three paths: structured log fields, log lines forwarded to the Logs
 * page, and audit metadata. It is a defence in depth measure — the primary
 * control is never putting secrets in these places — so it errs towards
 * over-redacting.
 */

/** Field names whose values are replaced wholesale, matched case-insensitively. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|session|cookie|otp|mfa[-_]?code|encryption[-_]?key|dsn|connection[-_]?string)/i;

/** Keys that look sensitive but are safe and useful to keep. */
const ALLOWED_KEYS = new Set([
  'authenticated',
  'auth_method',
  'authMethod',
  'session_id',
  'sessionId',
  'mfa_verified',
  'mfaVerified',
  'token_type',
  'tokenType',
]);

export const REDACTED = '[REDACTED]';

interface ValuePattern {
  name: string;
  pattern: RegExp;
  /** Replacement string; capture groups keep the non-secret prefix readable. */
  replacement: string;
}

/**
 * Value-shaped matches, for secrets that arrive inside a message string rather
 * than as a named field. Ordered so structural patterns run before the generic
 * `key=value` sweep.
 */
const VALUE_PATTERNS: ValuePattern[] = [
  {
    name: 'private_key_block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  {
    // Keeps scheme + username so the operator can still tell which target it is.
    name: 'connection_url_password',
    pattern: /\b((?:postgres(?:ql)?|rediss?|mysql|amqps?|mongodb(?:\+srv)?):\/\/[^:@\s/]*:)[^@\s]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  {
    name: 'bearer',
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    name: 'basic',
    pattern: /\b(Basic\s+)[A-Za-z0-9+/=]{8,}/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED,
  },
  {
    // DigitalOcean personal access tokens.
    name: 'do_token',
    pattern: /\bdop_v1_[a-f0-9]{64}\b/gi,
    replacement: REDACTED,
  },
  {
    name: 'pve_token',
    pattern: /(PVEAPIToken=)[^\s,;]+/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    name: 'github_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'aws_access_key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  {
    name: 'assignment',
    pattern:
      /\b(password|passwd|pwd|secret|token|api[-_]?key|apikey|credential)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)"']+)/gi,
    replacement: `$1$2${REDACTED}`,
  },
];

/** Replaces secret-shaped substrings inside a free-form string. */
export function redactString(input: string): string {
  let output = input;
  for (const { pattern, replacement } of VALUE_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

const MAX_DEPTH = 8;

/**
 * Deep-redacts an arbitrary value. Objects are copied rather than mutated so a
 * caller can safely log a redacted view of live state.
 */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return REDACTED as unknown as T;

  if (typeof value === 'string') {
    return redactString(value) as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1)) as unknown as T;
  }
  if (value instanceof Date) {
    return value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as unknown as T;
  }
  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.byteLength} bytes]` as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(key) && SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactValue(entry, depth + 1);
  }
  return result as unknown as T;
}

/**
 * Strips literal values from a SQL statement so it can be stored in query
 * history without capturing customer data (spec section 24).
 */
export function redactSqlLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\$\d+/g, '$?')
    .replace(/\b\d+\.\d+\b/g, '?')
    .replace(/(?<![A-Za-z_$])\d+(?![A-Za-z_$])/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}
