import { createHash } from 'node:crypto';
import { errors } from '../../utils/errors.js';
import type { ProviderHttpClient } from '../../utils/http.js';
import { logger } from '../../utils/logger.js';
import { resolve } from '../../connections/resolver.js';
import { buildClient, type ProxmoxConfig } from './test.js';
import type { PveEnvelope } from './types.js';

/**
 * Proxmox VE client.
 *
 * Configuration comes from the Connection Manager, falling back to .env
 * (spec sections 8, 28, 29). Authenticates with a scoped API token
 * (`PVEAPIToken=user@realm!tokenid=secret`) rather than a root ticket: tokens can
 * be restricted per path and do not expire mid-session.
 *
 * Only the endpoints the console needs are exposed as named methods; there is no
 * arbitrary passthrough.
 */

interface CachedClient {
  fingerprint: string;
  client: ProviderHttpClient;
}

let cached: CachedClient | null = null;
let warnedAboutTls = false;

function fingerprint(config: ProxmoxConfig): string {
  return createHash('sha256')
    .update(`${config.apiUrl}|${config.tokenId}|${config.tokenSecret}|${config.rejectUnauthorized}|${config.caCertPath ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

async function activeConfig(): Promise<ProxmoxConfig | null> {
  const resolved = await resolve('proxmox');
  return resolved ? (resolved.config as unknown as ProxmoxConfig) : null;
}

export async function isConfigured(): Promise<boolean> {
  return (await activeConfig()) !== null;
}

async function client(): Promise<ProviderHttpClient> {
  const config = await activeConfig();
  if (!config?.apiUrl || !config.tokenId || !config.tokenSecret) {
    throw errors.providerNotConfigured('Proxmox');
  }

  const print = fingerprint(config);
  if (cached?.fingerprint !== print) {
    await cached?.client.close().catch(() => undefined);
    try {
      cached = { fingerprint: print, client: buildClient(config) };
    } catch (error) {
      // A missing CA file is a configuration error, not a transient failure:
      // continuing would mean an unverified TLS session.
      throw errors.providerNotConfigured(
        `Proxmox (${error instanceof Error ? error.message : 'TLS configuration is invalid'})`,
      );
    }

    if (!config.rejectUnauthorized && !warnedAboutTls) {
      warnedAboutTls = true;
      logger().warn(
        'Proxmox TLS verification is disabled for the active connection. Supply a CA certificate path and re-enable it.',
      );
    }
  }

  return cached.client;
}

export function lastSuccessAt(): string | null {
  return cached?.client.lastSuccessIso ?? null;
}

/** GET a Proxmox path and unwrap the `{ data }` envelope. */
export async function get<T>(
  path: string,
  query?: Record<string, string | number>,
): Promise<T> {
  const response = await (await client()).json<PveEnvelope<T>>({ path, query });
  return response?.data as T;
}

/**
 * GET that tolerates a missing endpoint by returning null. Used for optional
 * endpoints such as the QEMU guest agent, which is not installed on every VM.
 */
export async function getOptional<T>(path: string): Promise<T | null> {
  try {
    return await get<T>(path);
  } catch {
    return null;
  }
}

/**
 * POST a guest lifecycle command. Returns the UPID, Proxmox's task identifier, so
 * the operation record can be correlated with the cluster task log.
 */
export async function postCommand(
  path: string,
  body?: Record<string, string | number>,
): Promise<string> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body ?? {})) {
    params.set(key, String(value));
  }

  const response = await (await client()).json<PveEnvelope<string>>({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: params.toString(),
    retries: 0,
    timeoutMs: 20_000,
  });

  return typeof response?.data === 'string' ? response.data : '';
}

export async function closeClient(): Promise<void> {
  await cached?.client.close().catch(() => undefined);
  cached = null;
}
