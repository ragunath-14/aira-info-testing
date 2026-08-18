import { createHash } from 'node:crypto';
import { errors } from '../../utils/errors.js';
import type { ProviderHttpClient } from '../../utils/http.js';
import { resolve } from '../../connections/resolver.js';
import { buildClient, type DigitalOceanConfig } from './test.js';
import type { DoLinks, DoListMeta } from './types.js';

/**
 * DigitalOcean API client.
 *
 * Configuration comes from the Connection Manager, falling back to .env
 * (spec sections 7, 28, 29). Clients are cached by a fingerprint of the resolved
 * config, so saving a new token swaps the client on the next call without a
 * restart — and without two connections ever sharing one client.
 *
 * Two tokens are supported: a read-scoped token for all monitoring, and an
 * optional write-scoped token used only by the allowlisted power actions. When the
 * write token is absent, write actions are refused rather than silently falling
 * back to the read token, which is what keeps a read-only deployment read-only.
 *
 * There is deliberately no generic passthrough method: callers name the endpoint
 * they need (never expose a DO API proxy to the browser).
 */

interface CachedClient {
  fingerprint: string;
  client: ProviderHttpClient;
}

let readCache: CachedClient | null = null;
let writeCache: CachedClient | null = null;

/** Identifies a config without keeping the token itself in the cache key. */
function fingerprint(config: DigitalOceanConfig, write: boolean): string {
  const token = write ? (config.writeApiToken ?? '') : config.apiToken;
  return createHash('sha256').update(`${config.apiUrl}|${token}`).digest('hex').slice(0, 16);
}

async function activeConfig(): Promise<DigitalOceanConfig | null> {
  const resolved = await resolve('digitalocean');
  return resolved ? (resolved.config as unknown as DigitalOceanConfig) : null;
}

export async function isConfigured(): Promise<boolean> {
  return (await activeConfig()) !== null;
}

export async function isWriteConfigured(): Promise<boolean> {
  const config = await activeConfig();
  return Boolean(config?.writeApiToken);
}

async function read(): Promise<ProviderHttpClient> {
  const config = await activeConfig();
  if (!config?.apiToken) throw errors.providerNotConfigured('DigitalOcean');

  const print = fingerprint(config, false);
  if (readCache?.fingerprint !== print) {
    await readCache?.client.close().catch(() => undefined);
    readCache = { fingerprint: print, client: buildClient(config) };
  }
  return readCache.client;
}

async function write(): Promise<ProviderHttpClient> {
  const config = await activeConfig();
  if (!config?.writeApiToken) {
    throw errors.operationNotAllowed(
      'This connection has no DigitalOcean write token, so droplet power actions are disabled. Add one to the connection to enable them.',
      { reason: 'write token not configured' },
    );
  }

  const print = fingerprint(config, true);
  if (writeCache?.fingerprint !== print) {
    await writeCache?.client.close().catch(() => undefined);
    writeCache = { fingerprint: print, client: buildClient(config, true) };
  }
  return writeCache.client;
}

export function lastSuccessAt(): string | null {
  return readCache?.client.lastSuccessIso ?? null;
}

/**
 * Fetches every page of a list endpoint, capped so a runaway account cannot make
 * one request iterate forever.
 */
export async function listAll<T>(
  path: string,
  collectionKey: string,
  options: { perPage?: number; maxPages?: number; query?: Record<string, string | number> } = {},
): Promise<T[]> {
  const perPage = options.perPage ?? 200;
  const maxPages = options.maxPages ?? 10;
  const items: T[] = [];
  const client = await read();

  for (let page = 1; page <= maxPages; page += 1) {
    // The collection key varies per endpoint, so the envelope is read as an
    // index signature and the two known fields are typed explicitly.
    const response = await client.json<
      Record<string, unknown> & { links?: DoLinks; meta?: DoListMeta }
    >({
      path,
      query: { ...options.query, page, per_page: perPage },
    });

    const chunk = response[collectionKey];
    if (!Array.isArray(chunk)) break;
    items.push(...(chunk as T[]));

    // Stop as soon as DigitalOcean reports no further page.
    if (!response.links?.pages?.next) break;
  }

  return items;
}

export async function getOne<T>(path: string, key: string): Promise<T> {
  const response = await (await read()).json<Record<string, unknown>>({ path });
  const value = response[key];
  if (value === undefined || value === null) {
    throw errors.notFound('DigitalOcean resource');
  }
  return value as T;
}

export async function getRaw<T>(path: string, query?: Record<string, string | number>): Promise<T> {
  return (await read()).json<T>({ path, query });
}

/**
 * Posts a droplet action. The action name comes from the operations registry,
 * never from the request body.
 */
export async function postDropletAction(
  dropletId: string,
  action: { type: string; name?: string },
): Promise<{ id: number; status: string }> {
  const response = await (await write()).json<{ action: { id: number; status: string } }>({
    method: 'POST',
    path: `/droplets/${encodeURIComponent(dropletId)}/actions`,
    body: action,
    retries: 0,
    timeoutMs: 20_000,
  });
  return response.action;
}

export async function getAction(actionId: string): Promise<{ id: number; status: string }> {
  const response = await (await read()).json<{ action: { id: number; status: string } }>({
    path: `/actions/${encodeURIComponent(actionId)}`,
  });
  return response.action;
}

export async function closeClients(): Promise<void> {
  await Promise.allSettled([readCache?.client.close(), writeCache?.client.close()]);
  readCache = null;
  writeCache = null;
}
