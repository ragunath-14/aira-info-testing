import pg from 'pg';
import type { DatabaseConnection, DatabaseProvider, Environment } from '@airaos/types';
import { config } from '../../config.js';
import { eq, inArray } from 'drizzle-orm';
import { orm, schema } from '../../db/drizzle.js';
import { environmentRank } from '../../db/order.js';
import { aad, isSealedSecret, open, seal } from '../../security/crypto.js';
import { errors } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const { Pool } = pg;

/**
 * Managed-target connection registry and pooling (spec sections 16, 17).
 *
 * Design points:
 *
 *  - The browser never connects to PostgreSQL. Every query arrives as an HTTP
 *    request and is executed by this process.
 *  - Credentials are decrypted only in the moment a pool is created, and the
 *    plaintext is not retained on any object the API returns.
 *  - `toPublic` is the only shape that leaves the API: no cipher, no password,
 *    no DSN.
 *  - Pools are small and capped per target so the console cannot exhaust a
 *    production database's connection slots (spec section 42).
 */

type ConnectionRow = typeof schema.databaseConnections.$inferSelect;

const connections = schema.databaseConnections;

/** Public projection. Deliberately omits every credential column. */
export function toPublic(row: ConnectionRow): DatabaseConnection {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    provider: row.provider,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    sslMode: row.sslMode,
    description: row.description,
    readOnlyOverride: row.readOnlyOverride,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listConnections(visibleEnvironments: Environment[]): Promise<DatabaseConnection[]> {
  const rows = await orm()
    .select()
    .from(connections)
    .where(inArray(connections.environment, visibleEnvironments))
    .orderBy(environmentRank(connections.environment), connections.name);
  return rows.map(toPublic);
}

async function loadRow(connectionId: string): Promise<ConnectionRow> {
  const [row] = await orm()
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  if (!row) throw errors.notFound('Database connection');
  return row;
}

/**
 * Resolves a connection and asserts the caller may act in its environment.
 * Environment comes from the stored row, never from the request (rule 11).
 */
export async function requireConnection(
  connectionId: string,
  visibleEnvironments: Environment[],
): Promise<DatabaseConnection> {
  const row = await loadRow(connectionId);
  if (!visibleEnvironments.includes(row.environment)) {
    // Same response as a missing connection: no environment probing.
    throw errors.notFound('Database connection');
  }
  return toPublic(row);
}

export interface CreateConnectionInput {
  name: string;
  environment: Environment;
  provider: DatabaseProvider;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: DatabaseConnection['sslMode'];
  description?: string | null;
  readOnlyOverride?: boolean | null;
}

export async function createConnection(
  input: CreateConnectionInput,
  createdBy: string,
): Promise<DatabaseConnection> {
  // The row id is part of the encryption AAD, so it must exist before sealing.
  // Insert with a placeholder cipher, then seal against the generated id.
  const [created] = await orm()
    .insert(connections)
    .values({
      name: input.name,
      environment: input.environment,
      provider: input.provider,
      host: input.host,
      port: input.port,
      database: input.database,
      username: input.username,
      passwordRef: 'pending',
      sslMode: input.sslMode,
      description: input.description ?? null,
      readOnlyOverride: input.readOnlyOverride ?? null,
      createdBy,
    })
    .returning({ id: connections.id });

  const id = created?.id;
  if (!id) throw errors.internal({ reason: 'connection insert returned no id' });

  await orm()
    .update(connections)
    .set({ passwordCipher: seal(input.password, aad.databaseConnection(id)), passwordRef: null })
    .where(eq(connections.id, id));

  return toPublic(await loadRow(id));
}

export async function updateConnection(
  connectionId: string,
  input: Partial<Omit<CreateConnectionInput, 'environment'>>,
): Promise<DatabaseConnection> {
  // Confirms the row exists before building an UPDATE that would silently
  // affect nothing.
  await loadRow(connectionId);

  // Drizzle takes a partial object, so only the supplied fields are written —
  // no dynamic SET-clause assembly.
  const updates: Partial<typeof connections.$inferInsert> = {};

  if (input.name !== undefined) updates.name = input.name;
  if (input.provider !== undefined) updates.provider = input.provider;
  if (input.host !== undefined) updates.host = input.host;
  if (input.port !== undefined) updates.port = input.port;
  if (input.database !== undefined) updates.database = input.database;
  if (input.username !== undefined) updates.username = input.username;
  if (input.sslMode !== undefined) updates.sslMode = input.sslMode;
  if (input.description !== undefined) updates.description = input.description;
  if (input.readOnlyOverride !== undefined) updates.readOnlyOverride = input.readOnlyOverride;
  if (input.password !== undefined) {
    // A replaced password is resealed against this row's id, and any external
    // reference is dropped so the two cannot disagree.
    updates.passwordCipher = seal(input.password, aad.databaseConnection(connectionId));
    updates.passwordRef = null;
  }

  if (Object.keys(updates).length > 0) {
    await orm().update(connections).set(updates).where(eq(connections.id, connectionId));
  }

  // Connection parameters changed, so any pooled clients are stale.
  await closeTargetPool(connectionId);
  return toPublic(await loadRow(connectionId));
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await closeTargetPool(connectionId);
  await orm().delete(connections).where(eq(connections.id, connectionId));
}

// ------------------------------------------------------------------ pools ----

interface PooledTarget {
  pool: pg.Pool;
  createdAt: number;
  lastUsedAt: number;
}

const pools = new Map<string, PooledTarget>();

/** Idle pools are closed so the console holds no long-lived production sessions. */
const POOL_IDLE_MS = 5 * 60_000;

function resolvePassword(row: ConnectionRow): string {
  if (row.passwordCipher && isSealedSecret(row.passwordCipher)) {
    try {
      return open(row.passwordCipher, aad.databaseConnection(row.id));
    } catch (error) {
      // Usually a rotated ENCRYPTION_KEY: say so plainly rather than surfacing a
      // crypto error to the operator.
      throw errors.providerAuthFailed(
        `Database "${row.name}" (stored credential could not be decrypted; it may need re-entering after a key rotation)`,
      );
    }
  }

  if (row.passwordRef) {
    // Hook for an external secret manager. Referenced secrets are resolved from
    // the environment so a manager-backed deployment can inject them per target.
    const envKey = `DB_SECRET_${row.passwordRef.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    const value = process.env[envKey];
    if (value) return value;
    throw errors.providerNotConfigured(
      `Database "${row.name}" (secret reference ${row.passwordRef} is not resolvable)`,
    );
  }

  throw errors.providerNotConfigured(`Database "${row.name}" (no credential stored)`);
}

function sslConfig(row: ConnectionRow): pg.PoolConfig['ssl'] {
  switch (row.sslMode) {
    case 'disable':
      return undefined;
    case 'require':
      // Encrypt in transit but accept a self-signed server certificate, which is
      // what `require` means in libpq terms.
      return { rejectUnauthorized: false };
    case 'verify-ca':
    case 'verify-full':
      return { rejectUnauthorized: true, servername: row.host };
    default:
      return { rejectUnauthorized: false };
  }
}

/**
 * Returns a pool for one target, creating it on first use.
 *
 * `default_transaction_read_only` is set at the session level for every target
 * that policy considers read-only. That means read-only enforcement holds even
 * if a future code path forgets to check the classifier: the server itself
 * rejects the write.
 */
export async function getTargetPool(
  connectionId: string,
  options: { readOnly: boolean },
): Promise<pg.Pool> {
  const cacheKey = `${connectionId}:${options.readOnly ? 'ro' : 'rw'}`;
  const existing = pools.get(cacheKey);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.pool;
  }

  const cfg = config();
  const row = await loadRow(connectionId);
  const password = resolvePassword(row);

  const pool = new Pool({
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.username,
    password,
    ssl: sslConfig(row),
    max: cfg.DB_QUERY_MAX_CONNECTIONS_PER_TARGET,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: cfg.DB_QUERY_TIMEOUT_MS,
    query_timeout: cfg.DB_QUERY_TIMEOUT_MS + 1_000,
    // Identifies console sessions in pg_stat_activity, which matters when a DBA
    // is deciding what is safe to terminate.
    application_name: `airaos-console(${options.readOnly ? 'ro' : 'rw'})`,
    options: options.readOnly ? '-c default_transaction_read_only=on' : undefined,
  });

  pool.on('error', (error) => {
    logger().warn({ err: error, connectionId }, 'managed database pool error');
  });

  pools.set(cacheKey, { pool, createdAt: Date.now(), lastUsedAt: Date.now() });
  return pool;
}

export async function closeTargetPool(connectionId: string): Promise<void> {
  for (const [key, entry] of pools.entries()) {
    if (!key.startsWith(`${connectionId}:`)) continue;
    pools.delete(key);
    await entry.pool.end().catch((error) => {
      logger().debug({ err: error, connectionId }, 'error closing target pool');
    });
  }
}

export async function closeAllTargetPools(): Promise<void> {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.allSettled(entries.map((entry) => entry.pool.end()));
}

/** Reaps idle pools. Called from the health endpoint's periodic path. */
export async function reapIdlePools(): Promise<number> {
  const now = Date.now();
  let closed = 0;
  for (const [key, entry] of pools.entries()) {
    if (now - entry.lastUsedAt <= POOL_IDLE_MS) continue;
    pools.delete(key);
    closed += 1;
    await entry.pool.end().catch(() => undefined);
  }
  return closed;
}

/**
 * Verifies a connection works, without exposing why it failed in provider terms.
 * Used by the "Test connection" button.
 */
export async function testConnection(
  connectionId: string,
): Promise<{ ok: boolean; latencyMs: number; serverVersion: string | null; message: string | null }> {
  const started = Date.now();
  try {
    const pool = await getTargetPool(connectionId, { readOnly: true });
    const result = await pool.query<{ version: string }>('SELECT version() AS version');
    return {
      ok: true,
      latencyMs: Date.now() - started,
      serverVersion: result.rows[0]?.version ?? null,
      message: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed';
    logger().warn({ connectionId, err: error }, 'database connection test failed');
    return {
      ok: false,
      latencyMs: Date.now() - started,
      serverVersion: null,
      // Postgres connection errors are safe to show: they name a host and a
      // reason, not a credential.
      message: message.slice(0, 300),
    };
  }
}
