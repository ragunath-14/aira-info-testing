import type {
  AuthenticatedUser,
  Connection,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTestResult,
  ConnectionType,
  Environment,
  ResolvedProviderStatus,
} from '@airaos/types';
import { CONNECTION_TYPES } from '@airaos/types';
import type { CreateConnectionInput, UpdateConnectionInput } from '@airaos/validation';
import { errors } from '../utils/errors.js';
import { visibleEnvironments } from '../rbac/index.js';
import * as registry from '../providers/registry.js';
import * as repository from './repository.js';
import * as resolver from './resolver.js';

/**
 * Connection Manager service (spec sections 3-6, 30, 33).
 *
 * Sits between the routes and the provider adapters. Its jobs:
 *
 *  - Split a validated form payload into non-secret configuration and secrets,
 *    so the repository never has to know provider field names.
 *  - Test a candidate configuration before it is saved, and a stored one on
 *    demand, recording the outcome against the row.
 *  - Invalidate the resolver cache on every mutation, so a saved connection is in
 *    use within moments and no operator has to restart anything (spec §33).
 *
 * Every mutation is audited by the route layer, which has the request context.
 */

/**
 * Splits a validated payload into the two halves the repository stores.
 *
 * This is the only function outside `providers/` that knows provider field names,
 * and it exists so the discriminated-union payload from the form can be persisted
 * generically.
 */
function split(input: CreateConnectionInput | (UpdateConnectionInput & { type: ConnectionType })): {
  configuration: Record<string, unknown>;
  secrets: repository.ConnectionSecrets;
} {
  switch (input.type) {
    case 'digitalocean':
      return {
        configuration: {
          ...(input.apiUrl !== undefined ? { apiUrl: input.apiUrl } : {}),
          // Recorded so the UI can show whether power actions are possible
          // without revealing whether a token exists in the secret bundle.
          ...(input.writeApiToken !== undefined
            ? { hasWriteToken: Boolean(input.writeApiToken) }
            : {}),
        },
        secrets: {
          ...(input.apiToken ? { apiToken: input.apiToken } : {}),
          ...(input.writeApiToken ? { writeApiToken: input.writeApiToken } : {}),
        },
      };

    case 'proxmox':
      return {
        configuration: {
          ...(input.apiUrl !== undefined ? { apiUrl: input.apiUrl } : {}),
          ...(input.tokenId !== undefined ? { tokenId: input.tokenId } : {}),
          ...(input.rejectUnauthorized !== undefined
            ? { rejectUnauthorized: input.rejectUnauthorized }
            : {}),
          ...(input.caCertPath !== undefined ? { caCertPath: input.caCertPath ?? null } : {}),
        },
        secrets: input.tokenSecret ? { tokenSecret: input.tokenSecret } : {},
      };

    case 'postgres':
      return {
        configuration: {
          ...(input.host !== undefined ? { host: input.host } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.database !== undefined ? { database: input.database } : {}),
          ...(input.username !== undefined ? { username: input.username } : {}),
          ...(input.sslMode !== undefined ? { sslMode: input.sslMode } : {}),
          ...(input.readOnlyOverride !== undefined
            ? { readOnlyOverride: input.readOnlyOverride ?? null }
            : {}),
        },
        secrets: input.password ? { password: input.password } : {},
      };

    case 'redis':
      return {
        configuration: {
          ...(input.host !== undefined ? { host: input.host } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.tls !== undefined ? { tls: input.tls } : {}),
          ...(input.db !== undefined ? { db: input.db } : {}),
        },
        secrets: input.password ? { password: input.password } : {},
      };

    case 'prometheus':
      return {
        configuration: {
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.username !== undefined ? { username: input.username ?? null } : {}),
        },
        secrets: input.password ? { password: input.password } : {},
      };

    case 'grafana':
      return {
        configuration: {
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.organisationId !== undefined
            ? { organisationId: input.organisationId ?? null }
            : {}),
        },
        secrets: input.apiToken ? { grafanaToken: input.apiToken } : {},
      };

    default: {
      const exhaustive: never = input;
      throw errors.validation([
        { path: 'type', message: `Unsupported connection type: ${String(exhaustive)}` },
      ]);
    }
  }
}

/** Turns a probe result into the status stored on the row. */
function statusFrom(result: ConnectionTestResult): ConnectionStatus {
  if (!result.ok) return 'offline';
  // A reachable provider that reported a caveat is degraded rather than healthy —
  // for example Prometheus scraping nothing, or Redis refusing INFO.
  const hasCaveat = result.details.some((detail) =>
    /not permitted|not readable|disabled|not scraping/i.test(detail.value),
  );
  return hasCaveat ? 'degraded' : 'connected';
}

export async function list(
  user: AuthenticatedUser,
  filters: {
    type?: ConnectionType;
    environment?: Environment;
    status?: ConnectionStatus;
    enabled?: boolean;
    search?: string;
  } = {},
): Promise<Connection[]> {
  return repository.list({ ...filters, visibleEnvironments: visibleEnvironments(user) });
}

export async function get(user: AuthenticatedUser, connectionId: string): Promise<Connection> {
  return repository.requireConnection(connectionId, visibleEnvironments(user));
}

/**
 * Tests a candidate configuration that has not been saved (spec section 6).
 *
 * Nothing is persisted, so an operator can iterate on a form without leaving
 * half-configured rows behind.
 */
export async function testCandidate(
  user: AuthenticatedUser,
  input: CreateConnectionInput,
): Promise<ConnectionTestResult> {
  if (!user.environments.includes(input.environment)) {
    throw errors.environmentForbidden(input.environment);
  }

  const { configuration, secrets } = split(input);
  return registry.testConnection(input.type, buildProbeConfig(input.type, configuration, secrets));
}

/** Tests a stored connection using its own credential, and records the outcome. */
export async function testSaved(
  user: AuthenticatedUser,
  connectionId: string,
): Promise<{ connection: Connection; result: ConnectionTestResult }> {
  const connection = await repository.requireConnection(connectionId, visibleEnvironments(user));
  const secrets = await repository.credentialsFor(connectionId);

  const result = await registry.testConnection(
    connection.type,
    buildProbeConfig(
      connection.type,
      connection.configuration as unknown as Record<string, unknown>,
      secrets,
    ),
  );

  await repository.recordProbe(connectionId, {
    ok: result.ok,
    status: statusFrom(result),
    latencyMs: result.latencyMs,
    error: result.ok ? null : result.message,
  });

  // The probe may have changed whether this connection is usable.
  resolver.invalidate(connection.type);

  return { connection: await repository.requireConnection(connectionId, visibleEnvironments(user)), result };
}

/**
 * Assembles the shape an adapter's tester expects.
 *
 * Mirrors the resolver's `buildConfig`, but works from a form payload rather than
 * a stored row so the same adapter code probes both.
 */
function buildProbeConfig(
  type: ConnectionType,
  configuration: Record<string, unknown>,
  secrets: repository.ConnectionSecrets,
): Record<string, unknown> {
  switch (type) {
    case 'digitalocean':
      return {
        apiUrl: configuration.apiUrl ?? 'https://api.digitalocean.com/v2',
        apiToken: secrets.apiToken ?? '',
        writeApiToken: secrets.writeApiToken ?? null,
      };
    case 'proxmox':
      return {
        apiUrl: configuration.apiUrl ?? '',
        tokenId: configuration.tokenId ?? '',
        tokenSecret: secrets.tokenSecret ?? '',
        rejectUnauthorized: configuration.rejectUnauthorized !== false,
        caCertPath: configuration.caCertPath ?? null,
      };
    case 'postgres':
      return {
        host: configuration.host ?? '',
        port: configuration.port ?? 5432,
        database: configuration.database ?? '',
        username: configuration.username ?? '',
        password: secrets.password ?? '',
        sslMode: configuration.sslMode ?? 'require',
      };
    case 'redis':
      return {
        host: configuration.host ?? '',
        port: configuration.port ?? 6379,
        password: secrets.password ?? null,
        tls: configuration.tls === true,
        db: configuration.db ?? 0,
      };
    case 'prometheus':
      return {
        url: configuration.url ?? '',
        username: configuration.username ?? null,
        password: secrets.password ?? null,
      };
    case 'grafana':
      return {
        url: configuration.url ?? '',
        apiToken: secrets.grafanaToken ?? null,
        organisationId: configuration.organisationId ?? null,
      };
    default: {
      const exhaustive: never = type;
      throw new Error(`Unhandled connection type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Creates a connection.
 *
 * Tests first and refuses to save a configuration that does not work — a saved
 * connection that has never connected is a trap for whoever relies on it next
 * (spec section 6: Test before Save).
 */
export async function create(
  user: AuthenticatedUser,
  input: CreateConnectionInput,
  options: { skipTest?: boolean } = {},
): Promise<{ connection: Connection; result: ConnectionTestResult | null }> {
  if (!user.environments.includes(input.environment)) {
    throw errors.environmentForbidden(input.environment);
  }

  const { configuration, secrets } = split(input);

  let result: ConnectionTestResult | null = null;
  if (!options.skipTest) {
    result = await registry.testConnection(
      input.type,
      buildProbeConfig(input.type, configuration, secrets),
    );
    if (!result.ok) {
      throw errors.conflict(
        `The connection test failed, so nothing was saved: ${result.message}`,
      );
    }
  }

  const connection = await repository.create({
    name: input.name,
    type: input.type,
    environment: input.environment,
    description: input.description ?? null,
    configuration,
    secrets,
    createdBy: user.id,
  });

  if (result) {
    await repository.recordProbe(connection.id, {
      ok: true,
      status: statusFrom(result),
      latencyMs: result.latencyMs,
      error: null,
    });
  }

  resolver.invalidate(input.type);
  return {
    connection: await repository.requireConnection(connection.id, visibleEnvironments(user)),
    result,
  };
}

export async function update(
  user: AuthenticatedUser,
  connectionId: string,
  input: UpdateConnectionInput,
): Promise<Connection> {
  const existing = await repository.requireConnection(connectionId, visibleEnvironments(user));

  // A connection's type is immutable: changing it would orphan both its stored
  // credential and its configuration shape.
  if (input.type !== existing.type) {
    throw errors.conflict(
      `This connection is a ${existing.type} connection. Create a new one rather than changing its type.`,
    );
  }

  const { configuration, secrets } = split(input as UpdateConnectionInput & { type: ConnectionType });

  const updated = await repository.update(connectionId, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description ?? null } : {}),
    ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  });

  resolver.invalidate(existing.type);
  return updated;
}

export async function setEnabled(
  user: AuthenticatedUser,
  connectionId: string,
  isEnabled: boolean,
): Promise<Connection> {
  const existing = await repository.requireConnection(connectionId, visibleEnvironments(user));
  const updated = await repository.setEnabled(connectionId, isEnabled);
  resolver.invalidate(existing.type);
  return updated;
}

export async function remove(user: AuthenticatedUser, connectionId: string): Promise<Connection> {
  const existing = await repository.requireConnection(connectionId, visibleEnvironments(user));
  await repository.remove(connectionId);
  resolver.invalidate(existing.type);
  return existing;
}

/** Roll-up for the Connections page header and the setup prompts. */
export async function summary(user: AuthenticatedUser): Promise<ConnectionSummary> {
  const items = await list(user);

  const byStatus: ConnectionSummary['byStatus'] = {
    connected: 0,
    degraded: 0,
    offline: 0,
    not_tested: 0,
  };
  const byType = Object.fromEntries(
    CONNECTION_TYPES.map((type) => [type, 0]),
  ) as ConnectionSummary['byType'];

  for (const item of items) {
    byStatus[item.status] += 1;
    byType[item.type] += 1;
  }

  return {
    total: items.length,
    byStatus,
    byType,
    missingTypes: CONNECTION_TYPES.filter(
      (type) => !items.some((item) => item.type === type && item.isEnabled),
    ),
  };
}

/**
 * Where each provider's configuration currently comes from, so the UI can show
 * which providers are still on .env and prompt for migration (spec section 29).
 */
export async function providerSources(): Promise<ResolvedProviderStatus[]> {
  return Promise.all(CONNECTION_TYPES.map((type) => resolver.providerStatus(type)));
}
