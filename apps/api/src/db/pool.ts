import pg from 'pg';
import { sql } from 'drizzle-orm';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Connection pool for the console's own PostgreSQL database.
 *
 * This module owns the driver and nothing else. Every query against the console's
 * own tables goes through Drizzle — see ./drizzle.ts, which wraps this pool. There
 * is deliberately no exported `query()` helper: a raw escape hatch here is how a
 * codebase ends up half-converted, and Drizzle's `sql` template already covers
 * the cases the query builder cannot express.
 *
 * Separate from the managed-target pools in providers/databases — those are
 * per-connection, user-scoped and read-only by default, and they *do* use the raw
 * driver because their schemas are unknown and their statements are supplied by
 * an operator (spec section 11).
 */
export function db(): pg.Pool {
  if (!pool) {
    const cfg = config();
    pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      max: cfg.DATABASE_POOL_MAX,
      ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
      // The console's own queries are small; a slow one means something is wrong.
      statement_timeout: 10_000,
      query_timeout: 10_000,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'airaos-infra-console',
    });

    pool.on('error', (error) => {
      // Idle client errors must not take the process down.
      logger().error({ err: error }, 'console database pool error');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number; detail: string | null }> {
  const started = Date.now();
  try {
    // Imported lazily: drizzle.ts imports this module, and a top-level import
    // back would be a cycle.
    const { orm } = await import('./drizzle.js');
    await orm().execute(sql`select 1`);
    return { ok: true, latencyMs: Date.now() - started, detail: null };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      detail: (error as Error).message.slice(0, 200),
    };
  }
}
