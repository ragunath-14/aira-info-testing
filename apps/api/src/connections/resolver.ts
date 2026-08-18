import type {
  ConnectionSource,
  ConnectionType,
  Environment,
  ResolvedProviderStatus,
} from '@airaos/types';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ResolvedConnection } from '../providers/contract.js';
import * as repository from './repository.js';

/**
 * Resolves which configuration a provider should use (spec sections 28, 29, 33).
 *
 * Precedence, deliberately in this order:
 *
 *   1. An enabled connection saved in the Connection Manager.
 *   2. The matching .env variables.
 *   3. Nothing — the provider reports "not configured" and the UI says so.
 *
 * Step 2 is the backward-compatibility path required by spec section 29: an
 * instance still configured through .env keeps working untouched, and
 * `providerStatus()` reports the source so the UI can suggest migrating.
 *
 * Resolved configurations are cached briefly by type. The cache holds decrypted
 * secrets, so it is in-process only, short-lived, and cleared the moment a
 * connection changes — never written to Redis or logged.
 */

interface CacheEntry {
  resolved: ResolvedConnection | null;
  expiresAt: number;
}

/** Short enough that saving a connection takes effect almost immediately. */
const CACHE_TTL_MS = 15_000;

const cache = new Map<string, CacheEntry>();

function cacheKey(type: ConnectionType, environment?: Environment): string {
  return `${type}:${environment ?? '*'}`;
}

/** Called whenever a connection is created, changed, disabled or deleted. */
export function invalidate(type?: ConnectionType): void {
  if (!type) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${type}:`)) cache.delete(key);
  }
}

export async function resolve(
  type: ConnectionType,
  environment?: Environment,
): Promise<ResolvedConnection | null> {
  const key = cacheKey(type, environment);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.resolved;

  const resolved = await resolveUncached(type, environment);
  cache.set(key, { resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

async function resolveUncached(
  type: ConnectionType,
  environment?: Environment,
): Promise<ResolvedConnection | null> {
  try {
    const row = await repository.findActive(type, environment);
    if (row) {
      const secrets = await repository.credentialsFor(row.id);
      return {
        connectionId: row.id,
        name: row.name,
        type,
        environment: row.environment,
        config: buildConfig(type, (row.configuration ?? {}) as Record<string, unknown>, secrets),
      };
    }
  } catch (error) {
    // A database blip or an undecryptable credential must not take a provider
    // down entirely when .env could still serve it.
    logger().warn({ err: error, type }, 'connection lookup failed; falling back to environment');
  }

  return fromEnvironment(type);
}

/**
 * Merges stored settings with decrypted secrets into the shape an adapter wants.
 *
 * This is the one place that knows both halves, which keeps provider-specific
 * field names out of the repository and out of the routes.
 */
function buildConfig(
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
        readOnlyOverride: configuration.readOnlyOverride ?? null,
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
 * Builds a resolved connection from .env for backward compatibility.
 *
 * Returns null when the relevant variables are absent, which is how a provider
 * ends up reporting "not configured" rather than failing at first use.
 */
function fromEnvironment(type: ConnectionType): ResolvedConnection | null {
  const cfg = config();
  const wrap = (
    name: string,
    providerConfig: Record<string, unknown>,
  ): ResolvedConnection => ({
    connectionId: null,
    name,
    type,
    environment: cfg.APP_ENV,
    config: providerConfig,
  });

  switch (type) {
    case 'digitalocean':
      if (!cfg.DIGITALOCEAN_API_TOKEN) return null;
      return wrap('DigitalOcean (from environment)', {
        apiUrl: cfg.DIGITALOCEAN_API_URL,
        apiToken: cfg.DIGITALOCEAN_API_TOKEN,
        writeApiToken: cfg.DIGITALOCEAN_WRITE_API_TOKEN ?? null,
      });

    case 'proxmox':
      if (!cfg.PROXMOX_API_URL || !cfg.PROXMOX_TOKEN_ID || !cfg.PROXMOX_TOKEN_SECRET) return null;
      return wrap('Proxmox (from environment)', {
        apiUrl: cfg.PROXMOX_API_URL,
        tokenId: cfg.PROXMOX_TOKEN_ID,
        tokenSecret: cfg.PROXMOX_TOKEN_SECRET,
        rejectUnauthorized: cfg.PROXMOX_TLS_REJECT_UNAUTHORIZED,
        caCertPath: cfg.PROXMOX_CA_CERT_PATH ?? null,
      });

    case 'prometheus':
      if (!cfg.PROMETHEUS_URL) return null;
      return wrap('Prometheus (from environment)', {
        url: cfg.PROMETHEUS_URL,
        username: cfg.PROMETHEUS_USERNAME ?? null,
        password: cfg.PROMETHEUS_PASSWORD ?? null,
      });

    case 'grafana':
      if (!cfg.GRAFANA_URL) return null;
      return wrap('Grafana (from environment)', {
        url: cfg.GRAFANA_URL,
        apiToken: cfg.GRAFANA_TOKEN ?? null,
        organisationId: null,
      });

    case 'redis': {
      if (!cfg.REDIS_URL) return null;
      // REDIS_URL is a DSN; the adapter wants discrete fields.
      try {
        const url = new URL(cfg.REDIS_URL);
        return wrap('Redis (from environment)', {
          host: url.hostname,
          port: url.port ? Number(url.port) : 6379,
          password: url.password || null,
          tls: url.protocol === 'rediss:',
          db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) || 0 : 0,
        });
      } catch {
        logger().warn('REDIS_URL is not a parseable URL; ignoring it');
        return null;
      }
    }

    // PostgreSQL targets are not configured through .env: they live in
    // database_connections with their own write policy.
    case 'postgres':
      return null;

    default: {
      const exhaustive: never = type;
      throw new Error(`Unhandled connection type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Where each provider's configuration currently comes from. Drives the setup
 * prompts in the Connections UI and the "migrate from .env" hint.
 */
export async function providerStatus(type: ConnectionType): Promise<ResolvedProviderStatus> {
  const resolved = await resolve(type);
  const source: ConnectionSource = !resolved
    ? 'none'
    : resolved.connectionId
      ? 'connection_manager'
      : 'environment';

  return {
    type,
    source,
    connectionId: resolved?.connectionId ?? null,
    connectionName: resolved?.name ?? null,
    environment: (resolved?.environment as Environment | undefined) ?? null,
    configured: resolved !== null,
  };
}

/** True when a provider has any usable configuration at all. */
export async function isConfigured(type: ConnectionType): Promise<boolean> {
  return (await resolve(type)) !== null;
}
