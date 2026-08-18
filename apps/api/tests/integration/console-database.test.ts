import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integration test for the console's own database.
 *
 * Verifies the parts of the schema that carry security guarantees: the audit
 * trail is append-only, the hash chain verifies, and the production deployment
 * gate rejects an unapproved rollout.
 *
 * Skipped entirely when DATABASE_URL is not set, so a developer without a local
 * PostgreSQL sees skips rather than failures.
 */

const configured = Boolean(process.env.DATABASE_URL);
const describeIfConfigured = configured ? describe : describe.skip;

let pool: typeof import('../../src/db/pool.js');
let audit: typeof import('../../src/audit/service.js');

beforeAll(async () => {
  if (!configured) return;
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString('base64');
  process.env.AUDIT_LOG_SECRET ??= 'integration-audit-secret-0123456789';
  process.env.SESSION_SECRET ??= 'integration-session-secret-0123456789-abc';
  process.env.LOCAL_AUTH_ENABLED ??= 'true';

  pool = await import('../../src/db/pool.js');
  audit = await import('../../src/audit/service.js');
});

afterAll(async () => {
  if (configured && pool) await pool.closePool();
});

describeIfConfigured('console database schema', () => {
  it('is reachable', async () => {
    const result = await pool.pingDatabase();
    expect(result.ok).toBe(true);
  });

  it('has every migration applied', async () => {
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.map((row) => row.name)).toContain('0002_audit.sql');
  });

  it('has synced RBAC from the type definitions', async () => {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM permissions',
    );
    // Seeding is a prerequisite; a zero here means `npm run seed` was not run.
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});

describeIfConfigured('audit trail is append-only', () => {
  it('refuses UPDATE on audit_events', async () => {
    await expect(
      pool.query("UPDATE audit_events SET action = 'TAMPERED' WHERE sequence = 1"),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses DELETE on audit_events', async () => {
    await expect(pool.query('DELETE FROM audit_events WHERE sequence = 1')).rejects.toThrow(
      /append-only/i,
    );
  });

  it('verifies the hash chain', async () => {
    const verification = await audit.verifyChain(1000);
    expect(verification.verified).toBe(true);
    expect(verification.firstBrokenSequence).toBeNull();
  });
});

describeIfConfigured('production deployment gate', () => {
  it('refuses a running production deployment with no approver', async () => {
    // Requires an application row to reference; skip cleanly if none exists.
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM applications WHERE environment = 'production' LIMIT 1",
    );
    const applicationId = rows[0]?.id;
    if (!applicationId) return;

    const users = await pool.query<{ id: string }>('SELECT id FROM users LIMIT 1');
    const userId = users.rows[0]?.id;
    if (!userId) return;

    await expect(
      pool.query(
        `INSERT INTO deployments
           (application_id, environment, version, commit_sha, status, triggered_by)
         VALUES ($1, 'production', 'v0.0.0-test', 'abc1234', 'running', $2)`,
        [applicationId, userId],
      ),
    ).rejects.toThrow(/requires a recorded approver/i);
  });
});

describeIfConfigured('credential columns are not exposed by the public views', () => {
  it('omits password_cipher from database_connections_public', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'database_connections_public'`,
    );
    const columns = rows.map((row) => row.column_name);
    expect(columns).not.toContain('password_cipher');
    expect(columns).not.toContain('password_ref');
    expect(columns).toContain('host');
  });

  it('omits secret_cipher from providers_public', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'providers_public'`,
    );
    expect(rows.map((row) => row.column_name)).not.toContain('secret_cipher');
  });
});
