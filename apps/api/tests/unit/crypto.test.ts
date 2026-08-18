import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Crypto tests for the secrets-at-rest envelope (spec §31, rule 7).
 *
 * A fixture configuration is installed before the module under test is imported,
 * because config() is loaded lazily and cached on first use.
 */

let crypto: typeof import('../../src/security/crypto.js');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.AUDIT_LOG_SECRET = 'audit-secret-for-tests-0123456789';
  process.env.SESSION_SECRET = 'session-secret-for-tests-0123456789-abcdef';
  process.env.LOCAL_AUTH_ENABLED = 'true';

  crypto = await import('../../src/security/crypto.js');
});

describe('seal / open', () => {
  it('round-trips a secret', () => {
    const sealed = crypto.seal('hunter2', 'database_connection:abc');
    expect(crypto.open(sealed, 'database_connection:abc')).toBe('hunter2');
  });

  it('does not expose the plaintext in the envelope', () => {
    const sealed = crypto.seal('hunter2', 'database_connection:abc');
    expect(JSON.stringify(sealed)).not.toContain('hunter2');
    expect(sealed.v).toBe(1);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const first = crypto.seal('same-secret', 'aad');
    const second = crypto.seal('same-secret', 'aad');
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
  });

  it('refuses to decrypt under different associated data', () => {
    // This is what stops a stolen blob being pasted into another connection row
    // to make the console dial a different host.
    const sealed = crypto.seal('hunter2', 'database_connection:abc');
    expect(() => crypto.open(sealed, 'database_connection:xyz')).toThrow();
  });

  it('refuses to decrypt a tampered ciphertext', () => {
    const sealed = crypto.seal('hunter2', 'aad');
    const tampered = { ...sealed, ciphertext: Buffer.from('different').toString('base64') };
    expect(() => crypto.open(tampered, 'aad')).toThrow();
  });

  it('refuses an unknown envelope version', () => {
    const sealed = crypto.seal('hunter2', 'aad');
    expect(() => crypto.open({ ...sealed, v: 2 as unknown as 1 }, 'aad')).toThrow(/version/i);
  });

  it('handles empty and unicode plaintext', () => {
    expect(crypto.open(crypto.seal('', 'aad'), 'aad')).toBe('');
    const unicode = 'pässwörd-日本語-🔐';
    expect(crypto.open(crypto.seal(unicode, 'aad'), 'aad')).toBe(unicode);
  });
});

describe('isSealedSecret', () => {
  it('accepts a real envelope and rejects anything else', () => {
    expect(crypto.isSealedSecret(crypto.seal('x', 'aad'))).toBe(true);
    expect(crypto.isSealedSecret(null)).toBe(false);
    expect(crypto.isSealedSecret({ v: 1 })).toBe(false);
    expect(crypto.isSealedSecret('not an object')).toBe(false);
  });
});

describe('session tokens', () => {
  it('generates distinct high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => crypto.generateSessionToken()));
    expect(tokens.size).toBe(50);
    // 32 bytes base64url is 43 characters.
    expect([...tokens][0]).toHaveLength(43);
  });

  it('hashes deterministically and does not reveal the token', () => {
    const token = crypto.generateSessionToken();
    const hash = crypto.hashSessionToken(token);
    expect(crypto.hashSessionToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different hashes for different tokens', () => {
    expect(crypto.hashSessionToken('a')).not.toBe(crypto.hashSessionToken('b'));
  });
});

describe('constantTimeEquals', () => {
  it('compares equal and unequal strings correctly', () => {
    expect(crypto.constantTimeEquals('abc', 'abc')).toBe(true);
    expect(crypto.constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('handles differing lengths without throwing', () => {
    expect(crypto.constantTimeEquals('abc', 'abcdef')).toBe(false);
  });
});

describe('password hashing', () => {
  it('verifies a correct password', () => {
    const stored = crypto.hashPassword('correct-horse-battery');
    expect(crypto.verifyPassword('correct-horse-battery', stored)).toBe(true);
  });

  it('rejects an incorrect password', () => {
    const stored = crypto.hashPassword('correct-horse-battery');
    expect(crypto.verifyPassword('wrong', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently', () => {
    expect(crypto.hashPassword('same')).not.toBe(crypto.hashPassword('same'));
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(crypto.verifyPassword('x', 'garbage')).toBe(false);
    expect(crypto.verifyPassword('x', 'bcrypt$salt$hash')).toBe(false);
  });
});

describe('audit chain hashing', () => {
  it('is deterministic for the same input', () => {
    const first = crypto.auditRecordHash('canonical', 'previous');
    expect(crypto.auditRecordHash('canonical', 'previous')).toBe(first);
  });

  it('changes when the record content changes', () => {
    expect(crypto.auditRecordHash('a', 'previous')).not.toBe(
      crypto.auditRecordHash('b', 'previous'),
    );
  });

  it('changes when the predecessor changes — this is what chains the records', () => {
    expect(crypto.auditRecordHash('same', 'previous-a')).not.toBe(
      crypto.auditRecordHash('same', 'previous-b'),
    );
  });

  it('handles the genesis record', () => {
    expect(crypto.auditRecordHash('first', null)).toMatch(/^[0-9a-f]{64}$/);
  });
});
