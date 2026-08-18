import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  redactSqlLiterals,
  redactString,
  redactValue,
} from '../../src/utils/redaction.js';

/**
 * Redaction is the last line of defence for spec §12 and §31: the primary control
 * is not putting secrets in logs, but if one arrives it must not be stored or
 * displayed.
 */

describe('redactString', () => {
  it('keeps the scheme and user but removes a connection-string password', () => {
    const result = redactString('postgres://airaos:s3cr3t@db.internal:5432/airaos');
    expect(result).not.toContain('s3cr3t');
    expect(result).toContain('postgres://airaos:');
    expect(result).toContain('db.internal:5432/airaos');
  });

  it('redacts a redis URL password', () => {
    expect(redactString('rediss://default:hunter2@cache:6379')).not.toContain('hunter2');
  });

  it('redacts bearer and basic credentials while keeping the scheme', () => {
    expect(redactString('authorization: Bearer abcdef1234567890')).toBe(
      `authorization: Bearer ${REDACTED}`,
    );
    expect(redactString('Basic YWRtaW46cGFzcw==')).toBe(`Basic ${REDACTED}`);
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX2hlcmU';
    expect(redactString(`token=${jwt}`)).not.toContain('c2lnbmF0dXJlX2hlcmU');
  });

  it('redacts a DigitalOcean personal access token', () => {
    const token = `dop_v1_${'a'.repeat(64)}`;
    expect(redactString(`using ${token} now`)).toBe(`using ${REDACTED} now`);
  });

  it('redacts a Proxmox API token secret but keeps the parameter name', () => {
    const result = redactString('PVEAPIToken=root@pam!console=1234-5678');
    expect(result).toBe(`PVEAPIToken=${REDACTED}`);
  });

  it('redacts a GitHub token and an AWS access key id', () => {
    expect(redactString(`ghp_${'b'.repeat(36)}`)).toBe(REDACTED);
    expect(redactString('AKIAIOSFODNN7EXAMPLE')).toBe(REDACTED);
  });

  it('redacts a private key block entirely', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(redactString(`key: ${key}`)).toBe(`key: ${REDACTED}`);
  });

  it('redacts key=value assignments', () => {
    expect(redactString('password=hunter2')).toBe(`password=${REDACTED}`);
    expect(redactString('api_key: "abcd1234"')).toContain(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    const message = 'Restarted airaos-api on prod-droplet-01 in 1.2s';
    expect(redactString(message)).toBe(message);
  });
});

describe('redactValue', () => {
  it('replaces values under sensitive keys', () => {
    const result = redactValue({ user: 'admin', password: 'hunter2', apiToken: 'abc' });
    expect(result).toEqual({ user: 'admin', password: REDACTED, apiToken: REDACTED });
  });

  it('keeps allowlisted keys that merely look sensitive', () => {
    const result = redactValue({ sessionId: 'abc-123', mfaVerified: true });
    expect(result).toEqual({ sessionId: 'abc-123', mfaVerified: true });
  });

  it('recurses through nested objects and arrays', () => {
    const result = redactValue({
      connections: [{ name: 'prod', secret: 'shhh' }],
      nested: { deeper: { token: 'abc' } },
    }) as { connections: Array<{ secret: string }>; nested: { deeper: { token: string } } };

    expect(result.connections[0]?.secret).toBe(REDACTED);
    expect(result.nested.deeper.token).toBe(REDACTED);
  });

  it('redacts secret-shaped content inside plain string values', () => {
    const result = redactValue({ dsnNote: 'postgres://u:p@h/db' }) as { dsnNote: string };
    // The key itself matches the sensitive pattern, so the whole value goes.
    expect(result.dsnNote).toBe(REDACTED);
  });

  it('summarises buffers rather than dumping them', () => {
    const result = redactValue({ blob: Buffer.from('hello') }) as { blob: string };
    expect(result.blob).toMatch(/^\[Buffer 5 bytes\]$/);
  });

  it('reduces an Error to name and redacted message', () => {
    const result = redactValue(new Error('failed with password=hunter2')) as {
      name: string;
      message: string;
    };
    expect(result.name).toBe('Error');
    expect(result.message).not.toContain('hunter2');
  });

  it('preserves primitives and dates', () => {
    const date = new Date('2026-08-18T10:00:00.000Z');
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(date)).toBe(date);
  });

  it('does not mutate its input', () => {
    const input = { password: 'hunter2' };
    redactValue(input);
    expect(input.password).toBe('hunter2');
  });
});

describe('redactSqlLiterals', () => {
  it('replaces string and numeric literals', () => {
    expect(redactSqlLiterals("SELECT * FROM users WHERE email = 'a@b.com' AND id = 42")).toBe(
      "SELECT * FROM users WHERE email = '?' AND id = ?",
    );
  });

  it('handles doubled quotes inside a literal', () => {
    expect(redactSqlLiterals("SELECT 'it''s here'")).toBe("SELECT '?'");
  });

  it('replaces bind parameters and collapses whitespace', () => {
    expect(redactSqlLiterals('UPDATE t\n  SET a = $1\n  WHERE id = $2')).toBe(
      'UPDATE t SET a = $? WHERE id = $?',
    );
  });

  it('keeps identifiers containing digits intact', () => {
    expect(redactSqlLiterals('SELECT col2 FROM table1')).toBe('SELECT col2 FROM table1');
  });

  it('replaces decimals', () => {
    expect(redactSqlLiterals('SELECT * FROM t WHERE price > 19.99')).toBe(
      'SELECT * FROM t WHERE price > ?',
    );
  });
});
