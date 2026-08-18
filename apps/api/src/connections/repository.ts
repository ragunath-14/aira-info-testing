import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  Connection,
  ConnectionConfiguration,
  ConnectionStatus,
  ConnectionType,
  Environment,
} from '@airaos/types';
import { orm } from '../db/drizzle.js';
import { connections } from '../db/schema.js';
import { aad, isSealedSecret, open, seal, type SealedSecret } from '../security/crypto.js';
import { errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Persistence for the Connection Manager. The first module written against
 * Drizzle rather than raw SQL.
 *
 * The security boundary lives here: `toPublic` is the only projection that leaves
 * this module, and it cannot carry a secret because the secret is not one of its
 * fields. Plaintext credentials exist only inside `credentialsFor`, which returns
 * them to a provider adapter at the moment of use and never stores or logs them.
 */

/**
 * Secrets per connection type, sealed together as one JSON bundle.
 *
 * Keeping them in one envelope means one AES-GCM operation per connection and one
 * associated-data binding, rather than a column per secret.
 */
export interface ConnectionSecrets {
  /** DigitalOcean read-scoped token. */
  apiToken?: string;
  /** DigitalOcean write-scoped token. Absent means power actions are refused. */
  writeApiToken?: string;
  /** Proxmox API token secret. */
  tokenSecret?: string;
  /** PostgreSQL / Redis / Prometheus password. */
  password?: string;
  /** Grafana API token. */
  grafanaToken?: string;
}

interface ConnectionRowShape {
  id: string;
  name: string;
  type: ConnectionType;
  environment: Environment;
  description: string | null;
  configuration: unknown;
  credentialCipher: unknown;
  credentialRef: string | null;
  isEnabled: boolean;
  status: ConnectionStatus;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  latencyMs: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Secret-free projection. The only shape that may reach an API response. */
export function toPublic(row: ConnectionRowShape): Connection {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    environment: row.environment,
    description: row.description,
    configuration: (row.configuration ?? {}) as ConnectionConfiguration,
    hasCredential: Boolean(row.credentialCipher ?? row.credentialRef),
    isEnabled: row.isEnabled,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    lastError: row.lastError,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ListFilters {
  type?: ConnectionType;
  environment?: Environment;
  status?: ConnectionStatus;
  enabled?: boolean;
  search?: string;
  /** Environments the caller may see. Always supplied by the route. */
  visibleEnvironments: Environment[];
}

export async function list(filters: ListFilters): Promise<Connection[]> {
  // inArray rather than a raw fragment: the values come from RBAC, but a
  // parameterised list is the right habit in a query builder.
  const where = [inArray(connections.environment, filters.visibleEnvironments)];

  if (filters.type) where.push(eq(connections.type, filters.type));
  if (filters.environment) where.push(eq(connections.environment, filters.environment));
  if (filters.status) where.push(eq(connections.status, filters.status));
  if (filters.enabled !== undefined) where.push(eq(connections.isEnabled, filters.enabled));
  if (filters.search) {
    where.push(sql`(${connections.name} ILIKE ${`%${filters.search}%`} OR ${connections.description} ILIKE ${`%${filters.search}%`})`);
  }

  const rows = await orm()
    .select()
    .from(connections)
    .where(and(...where))
    .orderBy(asc(connections.type), asc(connections.name));

  return rows.map((row) => toPublic(row as ConnectionRowShape));
}

async function loadRow(connectionId: string): Promise<ConnectionRowShape> {
  const rows = await orm()
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  const row = rows[0];
  if (!row) throw errors.notFound('Connection');
  return row as ConnectionRowShape;
}

/**
 * Loads a connection and confirms the caller may act in its environment.
 *
 * Not-found and not-permitted return the same response, so connection ids cannot
 * be probed to discover what exists in another environment (rule 11).
 */
export async function requireConnection(
  connectionId: string,
  visibleEnvironments: Environment[],
): Promise<Connection> {
  const row = await loadRow(connectionId);
  if (!visibleEnvironments.includes(row.environment)) throw errors.notFound('Connection');
  return toPublic(row);
}

export interface CreateInput {
  name: string;
  type: ConnectionType;
  environment: Environment;
  description: string | null;
  configuration: Record<string, unknown>;
  secrets: ConnectionSecrets;
  createdBy: string;
}

export async function create(input: CreateInput): Promise<Connection> {
  // The row id is part of the encryption associated data, so it must exist before
  // the secret can be sealed. Insert first, then seal against the generated id.
  const inserted = await orm()
    .insert(connections)
    .values({
      name: input.name,
      type: input.type,
      environment: input.environment,
      description: input.description,
      configuration: input.configuration,
      credentialRef: hasSecrets(input.secrets) ? 'pending' : null,
      createdBy: input.createdBy,
      status: 'not_tested',
    })
    .returning({ id: connections.id })
    .catch((error: unknown) => {
      // A duplicate name is an operator mistake, not an internal error.
      if (String(error).includes('connections_name_idx')) {
        throw errors.conflict(`A connection named "${input.name}" already exists.`);
      }
      throw error;
    });

  const id = inserted[0]?.id;
  if (!id) throw errors.internal({ reason: 'connection insert returned no id' });

  if (hasSecrets(input.secrets)) {
    await orm()
      .update(connections)
      .set({
        credentialCipher: seal(JSON.stringify(input.secrets), aad.connection(id)),
        credentialRef: null,
      })
      .where(eq(connections.id, id));
  }

  return toPublic(await loadRow(id));
}

export interface UpdateInput {
  name?: string;
  description?: string | null;
  configuration?: Record<string, unknown>;
  /** Only the keys present are changed; omitted secrets keep their stored value. */
  secrets?: ConnectionSecrets;
}

export async function update(connectionId: string, input: UpdateInput): Promise<Connection> {
  const existing = await loadRow(connectionId);

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.configuration !== undefined) {
    // Merge so a partial update cannot silently drop settings the form did not
    // send.
    patch.configuration = {
      ...((existing.configuration ?? {}) as Record<string, unknown>),
      ...input.configuration,
    };
  }

  if (input.secrets && hasSecrets(input.secrets)) {
    const current = readSecrets(existing);
    patch.credentialCipher = seal(
      JSON.stringify({ ...current, ...input.secrets }),
      aad.connection(connectionId),
    );
    patch.credentialRef = null;
  }

  if (Object.keys(patch).length > 0) {
    // Changing configuration invalidates the last probe result: the connection
    // has not been tested in its new shape.
    if (patch.configuration || patch.credentialCipher) {
      patch.status = 'not_tested';
      patch.latencyMs = null;
      patch.lastError = null;
    }
    await orm().update(connections).set(patch).where(eq(connections.id, connectionId));
  }

  return toPublic(await loadRow(connectionId));
}

export async function setEnabled(connectionId: string, isEnabled: boolean): Promise<Connection> {
  await orm()
    .update(connections)
    .set({
      isEnabled,
      // A disabled connection's last status is no longer meaningful.
      ...(isEnabled ? {} : { status: 'not_tested' as ConnectionStatus, latencyMs: null }),
    })
    .where(eq(connections.id, connectionId));
  return toPublic(await loadRow(connectionId));
}

export async function remove(connectionId: string): Promise<void> {
  await orm().delete(connections).where(eq(connections.id, connectionId));
}

/** Records the outcome of a probe against a saved connection. */
export async function recordProbe(
  connectionId: string,
  outcome: { ok: boolean; status: ConnectionStatus; latencyMs: number | null; error: string | null },
): Promise<void> {
  const now = new Date();
  await orm()
    .update(connections)
    .set({
      status: outcome.status,
      latencyMs: outcome.latencyMs,
      lastCheckedAt: now,
      ...(outcome.ok
        ? { lastSuccessAt: now, lastError: null }
        : { lastErrorAt: now, lastError: outcome.error?.slice(0, 500) ?? 'Connection failed.' }),
    })
    .where(eq(connections.id, connectionId));
}

/**
 * Decrypts a connection's secrets for immediate use by a provider adapter.
 *
 * The return value is deliberately not cached anywhere. Callers pass it straight
 * into an adapter and let it go out of scope.
 */
export async function credentialsFor(connectionId: string): Promise<ConnectionSecrets> {
  return readSecrets(await loadRow(connectionId));
}

function readSecrets(row: ConnectionRowShape): ConnectionSecrets {
  if (row.credentialCipher && isSealedSecret(row.credentialCipher)) {
    try {
      return JSON.parse(open(row.credentialCipher as SealedSecret, aad.connection(row.id)));
    } catch (error) {
      logger().error({ connectionId: row.id }, 'connection credential could not be decrypted');
      // Usually a rotated ENCRYPTION_KEY. Say so plainly rather than surfacing a
      // crypto error.
      throw errors.providerAuthFailed(
        `Connection "${row.name}" (stored credential could not be decrypted; re-enter it after a key rotation)`,
      );
    }
  }

  if (row.credentialRef && row.credentialRef !== 'pending') {
    // Hook for an external secret manager: the reference names an environment
    // variable the deployment injects.
    const envKey = `CONNECTION_SECRET_${row.credentialRef.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    const value = process.env[envKey];
    if (!value) {
      throw errors.providerNotConfigured(
        `Connection "${row.name}" (secret reference ${row.credentialRef} is not resolvable)`,
      );
    }
    try {
      return JSON.parse(value) as ConnectionSecrets;
    } catch {
      return { apiToken: value, tokenSecret: value, password: value, grafanaToken: value };
    }
  }

  return {};
}

function hasSecrets(secrets: ConnectionSecrets): boolean {
  return Object.values(secrets).some((value) => typeof value === 'string' && value.length > 0);
}

/**
 * The connection an adapter should use for a type, preferring an exact
 * environment match and otherwise the most recently updated enabled one.
 */
export async function findActive(
  type: ConnectionType,
  environment?: Environment,
): Promise<ConnectionRowShape | null> {
  const where = [eq(connections.type, type), eq(connections.isEnabled, true)];
  if (environment) where.push(eq(connections.environment, environment));

  const rows = await orm()
    .select()
    .from(connections)
    .where(and(...where))
    .orderBy(desc(connections.updatedAt))
    .limit(1);

  return (rows[0] as ConnectionRowShape | undefined) ?? null;
}

export async function countAll(): Promise<number> {
  const rows = await orm().select({ count: sql<string>`count(*)` }).from(connections);
  return Number(rows[0]?.count ?? 0);
}

export type { ConnectionRowShape };
