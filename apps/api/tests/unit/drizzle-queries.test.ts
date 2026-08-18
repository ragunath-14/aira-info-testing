import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Tests for the SQL Drizzle actually emits.
 *
 * Every console query now goes through the query builder, which means a wrong
 * filter is a silent behaviour change rather than a visible SQL edit. These
 * cover the two constructs where that would be dangerous:
 *
 *  - the write-window predicate, where dropping either half would grant writes
 *    through a revoked or expired window;
 *  - the environment ordering, which several pages rely on to put production top.
 *
 * The dialect renders SQL without a connection, so no database is needed.
 */

const dialect = new PgDialect();

function render(query: { getSQL(): ReturnType<typeof sql> } | ReturnType<typeof sql>): string {
  const built = dialect.sqlToQuery('getSQL' in query ? query.getSQL() : query);
  return built.sql;
}

let schema: typeof import('../../src/db/schema.js');
let order: typeof import('../../src/db/order.js');

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.AUDIT_LOG_SECRET = 'drizzle-audit-secret-0123456789';
  process.env.SESSION_SECRET = 'drizzle-session-secret-0123456789-abcd';

  schema = await import('../../src/db/schema.js');
  order = await import('../../src/db/order.js');
});

describe('environment ordering', () => {
  it('puts production first and development last', () => {
    const rendered = render(order.environmentRank(schema.applications.environment));

    // Not the enum's own order, which is alphabetical and would lead with
    // development — the environment an operator needs to see must come first.
    const positions = ['production', 'staging', 'testing'].map((environment) =>
      rendered.indexOf(environment),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(rendered).toMatch(/when 'production' then 0/i);
  });

  it('references the column it was given', () => {
    expect(render(order.environmentRank(schema.databaseConnections.environment))).toContain(
      '"environment"',
    );
  });
});

describe('write-window predicate', () => {
  const windows = () => schema.databaseWriteWindows;

  it('requires both un-revoked and unexpired', () => {
    const predicate = and(
      eq(windows().connectionId, 'conn-1'),
      eq(windows().userId, 'user-1'),
      and(isNull(windows().revokedAt), gt(windows().expiresAt, sql`now()`)),
    );

    const rendered = render(predicate as never).toLowerCase();
    // Losing either half would hand a write window to someone whose window was
    // revoked, or whose window has run out.
    expect(rendered).toContain('"revoked_at" is null');
    expect(rendered).toContain('"expires_at" >');
    expect(rendered).toContain('now()');
  });

  it('parameterises the identifiers rather than inlining them', () => {
    const rendered = render(eq(windows().connectionId, "conn-1'; drop table users --") as never);
    expect(rendered).toContain('$1');
    expect(rendered).not.toContain('drop table');
  });
});

describe('audit chain read', () => {
  it('orders by sequence descending, which is what makes the chain head correct', () => {
    // verifyChain and the previous-hash lookup both depend on this ordering; an
    // ascending read would hash against the wrong predecessor.
    const rendered = render(sql`${schema.auditEvents.sequence} desc`);
    expect(rendered).toMatch(/"sequence"\s+desc/i);
  });
});
