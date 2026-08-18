import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser, DatabaseConnection, Role } from '@airaos/types';
import { resolveGrants } from '../../src/rbac/index.js';

/**
 * Security tests for the database write policy (spec §22, §43; rules 4, 5).
 *
 * The write-window lookup is stubbed so these tests exercise the decision logic
 * without a database. The integration suite covers the real query path.
 */

let policy: typeof import('../../src/providers/databases/policy.js');
let hasOpenWindow = false;

/** One open write window, in the shape `WINDOW_COLUMNS` selects. */
function openWindowRows() {
  return hasOpenWindow
    ? [
        {
          connectionId: 'conn-1',
          userId: 'user-1',
          reason: 'incident INC-1042',
          activatedAt: new Date(),
          expiresAt: new Date(Date.now() + 600_000),
        },
      ]
    : [];
}

function selectChain() {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (onFulfilled: (rows: ReturnType<typeof openWindowRows>) => unknown) =>
      Promise.resolve(openWindowRows()).then(onFulfilled),
  };
  return chain;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  process.env.AUDIT_LOG_SECRET = 'audit-secret-for-tests-0123456789';
  process.env.SESSION_SECRET = 'session-secret-for-tests-0123456789-abcdef';
  process.env.LOCAL_AUTH_ENABLED = 'true';

  // Only the console-database call is stubbed; the policy logic under test is
  // real, including the actual Drizzle filter construction — the stub stands in
  // for the round trip, not for the query.
  const schema = await import('../../src/db/schema.js');

  vi.doMock('../../src/db/drizzle.js', () => ({
    // Drizzle query builders are thenables, so a chain that returns itself and
    // resolves to a row array is a faithful stand-in for one.
    orm: () => ({
      select: () => selectChain(),
    }),
    schema,
  }));

  policy = await import('../../src/providers/databases/policy.js');
});

function userWith(roles: Role[]): AuthenticatedUser {
  const grants = resolveGrants(roles);
  return {
    id: 'user-1',
    email: 'operator@airaos.test',
    name: 'Operator',
    roles,
    permissions: [...grants.permissions],
    environments: [...grants.environments],
    mfaVerified: true,
    sessionId: 'session-1',
    sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'conn-1',
    name: 'Production',
    environment: 'production',
    provider: 'digitalocean_managed',
    host: 'db.internal',
    port: 5432,
    database: 'airaos',
    username: 'console_ro',
    sslMode: 'require',
    description: null,
    readOnlyOverride: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('isReadOnlyByDefault', () => {
  it('makes production read-only with no override', () => {
    expect(policy.isReadOnlyByDefault(connection())).toBe(true);
  });

  it('leaves non-production writable by default', () => {
    expect(policy.isReadOnlyByDefault(connection({ environment: 'development' }))).toBe(false);
  });

  it('honours an explicit override in both directions', () => {
    expect(policy.isReadOnlyByDefault(connection({ readOnlyOverride: false }))).toBe(false);
    expect(
      policy.isReadOnlyByDefault(connection({ environment: 'development', readOnlyOverride: true })),
    ).toBe(true);
  });
});

describe('evaluate — reads', () => {
  it('allows a READ for anyone holding database.query', async () => {
    hasOpenWindow = false;
    const decision = await policy.evaluate(userWith(['database_admin']), connection(), 'READ');
    expect(decision.allowed).toBe(true);
    expect(decision.readOnlySession).toBe(true);
  });

  it('refuses a READ without database.query', async () => {
    const decision = await policy.evaluate(userWith(['intern']), connection(), 'READ');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/database\.query/);
  });

  it('refuses a READ against an environment the role cannot see', async () => {
    const decision = await policy.evaluate(userWith(['developer']), connection(), 'READ');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/production/i);
  });
});

describe('evaluate — UNKNOWN is always refused', () => {
  it('refuses UNKNOWN even for an owner with a window open', async () => {
    hasOpenWindow = true;
    const decision = await policy.evaluate(userWith(['owner']), connection(), 'UNKNOWN');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/could not classify/i);
  });
});

describe('evaluate — production writes', () => {
  it('refuses a WRITE without database.admin', async () => {
    hasOpenWindow = true;
    const decision = await policy.evaluate(userWith(['viewer']), connection(), 'WRITE');
    expect(decision.allowed).toBe(false);
  });

  it('requires an open write window even with database.admin', async () => {
    hasOpenWindow = false;
    const decision = await policy.evaluate(userWith(['database_admin']), connection(), 'WRITE');
    expect(decision.allowed).toBe(false);
    expect(decision.needsWriteWindow).toBe(true);
  });

  it('allows a WRITE with database.admin and an open window', async () => {
    hasOpenWindow = true;
    const decision = await policy.evaluate(userWith(['database_admin']), connection(), 'WRITE');
    expect(decision.allowed).toBe(true);
    expect(decision.readOnlySession).toBe(false);
  });

  it('refuses production DDL outright, window or not', async () => {
    hasOpenWindow = true;
    const decision = await policy.evaluate(userWith(['owner']), connection(), 'DDL');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/reviewed migration/i);
  });

  it('refuses production DESTRUCTIVE statements outright', async () => {
    hasOpenWindow = true;
    const decision = await policy.evaluate(userWith(['owner']), connection(), 'DESTRUCTIVE');
    expect(decision.allowed).toBe(false);
  });
});

describe('evaluate — non-production writes', () => {
  const staging = connection({ environment: 'staging', name: 'Staging' });

  it('requires database.write plus a window', async () => {
    hasOpenWindow = false;
    let decision = await policy.evaluate(userWith(['developer']), staging, 'WRITE');
    expect(decision.allowed).toBe(false);
    expect(decision.needsWriteWindow).toBe(true);

    hasOpenWindow = true;
    decision = await policy.evaluate(userWith(['developer']), staging, 'WRITE');
    expect(decision.allowed).toBe(true);
  });

  it('permits DDL in staging with a window', async () => {
    hasOpenWindow = true;
    const decision = await policy.evaluate(userWith(['developer']), staging, 'DDL');
    expect(decision.allowed).toBe(true);
  });

  it('requires database.admin for DESTRUCTIVE even in staging', async () => {
    hasOpenWindow = true;
    const developer = await policy.evaluate(userWith(['developer']), staging, 'DESTRUCTIVE');
    expect(developer.allowed).toBe(false);

    const admin = await policy.evaluate(userWith(['database_admin']), staging, 'DESTRUCTIVE');
    expect(admin.allowed).toBe(true);
  });

  it('refuses writes to a connection explicitly marked read-only', async () => {
    hasOpenWindow = true;
    const locked = connection({ environment: 'staging', readOnlyOverride: true });
    const decision = await policy.evaluate(userWith(['database_admin']), locked, 'WRITE');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/read-only/i);
  });
});

describe('assertAllowed', () => {
  it('throws WRITE_MODE_REQUIRED when only a window is missing', () => {
    expect(() =>
      policy.assertAllowed(
        { allowed: false, reason: 'needs a window', needsWriteWindow: true, readOnlySession: true },
        'staging',
      ),
    ).toThrow(/write window/i);
  });

  it('throws QUERY_REJECTED with the reason otherwise', () => {
    expect(() =>
      policy.assertAllowed(
        { allowed: false, reason: 'not classified', needsWriteWindow: false, readOnlySession: true },
        'staging',
      ),
    ).toThrow(/not classified/);
  });

  it('does nothing when allowed', () => {
    expect(() =>
      policy.assertAllowed(
        { allowed: true, reason: null, needsWriteWindow: false, readOnlySession: false },
        'staging',
      ),
    ).not.toThrow();
  });
});
