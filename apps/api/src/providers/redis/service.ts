import type { RedisOverview, SubsystemHealth } from '@airaos/types';
import { config } from '../../config.js';
import { providerCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { configured, redis } from './client.js';

/**
 * Redis overview (spec section 27).
 *
 * Everything here comes from INFO. Rates that Redis reports only as cumulative
 * counters are turned into per-second figures by comparing consecutive samples,
 * which is why the previous sample is kept in memory.
 */

interface Sample {
  at: number;
  commandsProcessed: number;
}

let previousSample: Sample | null = null;

function parseInfo(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses the `db0:keys=12,expires=3,avg_ttl=0` lines from INFO keyspace. */
function parseKeyspace(info: Record<string, string>): Array<{ db: string; keys: number; expires: number }> {
  const entries: Array<{ db: string; keys: number; expires: number }> = [];
  for (const [key, value] of Object.entries(info)) {
    if (!/^db\d+$/.test(key)) continue;
    const keys = Number(/keys=(\d+)/.exec(value)?.[1] ?? 0);
    const expires = Number(/expires=(\d+)/.exec(value)?.[1] ?? 0);
    entries.push({ db: key, keys, expires });
  }
  return entries;
}

async function loadOverview(): Promise<RedisOverview> {
  const cfg = config();
  const client = await redis();

  const base: RedisOverview = {
    configured: await configured(),
    state: 'unknown',
    environment: cfg.APP_ENV,
    version: null,
    uptimeSeconds: null,
    usedMemoryBytes: null,
    maxMemoryBytes: null,
    connectedClients: null,
    blockedClients: null,
    commandsProcessed: null,
    opsPerSecond: null,
    keyspaceHits: null,
    keyspaceMisses: null,
    hitRate: null,
    evictedKeys: null,
    expiredKeys: null,
    totalKeys: null,
    keyspace: [],
    message: null,
  };

  if (!client) {
    return { ...base, message: 'Redis is not configured on this console instance.' };
  }

  try {
    const raw = await client.info();
    const info = parseInfo(raw);

    const hits = num(info['keyspace_hits']);
    const misses = num(info['keyspace_misses']);
    const commandsProcessed = num(info['total_commands_processed']);
    const keyspace = parseKeyspace(info);

    // Prefer Redis's own instantaneous figure; fall back to a delta if absent.
    let opsPerSecond = num(info['instantaneous_ops_per_sec']);
    if (opsPerSecond === null && commandsProcessed !== null && previousSample) {
      const elapsedSeconds = (Date.now() - previousSample.at) / 1000;
      if (elapsedSeconds > 0) {
        opsPerSecond = Math.max(
          0,
          Number(((commandsProcessed - previousSample.commandsProcessed) / elapsedSeconds).toFixed(2)),
        );
      }
    }
    if (commandsProcessed !== null) {
      previousSample = { at: Date.now(), commandsProcessed };
    }

    const maxMemory = num(info['maxmemory']);

    return {
      ...base,
      state: 'healthy',
      version: info['redis_version'] ?? null,
      uptimeSeconds: num(info['uptime_in_seconds']),
      usedMemoryBytes: num(info['used_memory']),
      // maxmemory 0 means "no limit", which is not the same as "unknown".
      maxMemoryBytes: maxMemory && maxMemory > 0 ? maxMemory : null,
      connectedClients: num(info['connected_clients']),
      blockedClients: num(info['blocked_clients']),
      commandsProcessed,
      opsPerSecond,
      keyspaceHits: hits,
      keyspaceMisses: misses,
      hitRate:
        hits !== null && misses !== null && hits + misses > 0
          ? Number(((hits / (hits + misses)) * 100).toFixed(2))
          : null,
      evictedKeys: num(info['evicted_keys']),
      expiredKeys: num(info['expired_keys']),
      totalKeys: keyspace.reduce((total, entry) => total + entry.keys, 0),
      keyspace,
      message: null,
    };
  } catch (error) {
    logger().debug({ err: error }, 'redis INFO failed');
    return {
      ...base,
      state: 'down',
      message: error instanceof Error ? error.message : 'Redis is unreachable.',
    };
  }
}

export async function overview(): Promise<{ value: RedisOverview; cachedAgeMs?: number }> {
  const result = await providerCache.wrap('redis:overview', 10_000, loadOverview, {
    fallbackToStale: true,
  });
  return { value: result.value, cachedAgeMs: result.cachedAgeMs };
}

export async function health(): Promise<SubsystemHealth> {
  const base = {
    key: 'redis',
    label: 'Redis',
    configured: await configured(),
    lastCheckedAt: new Date().toISOString(),
  };

  if (!(await configured())) {
    return {
      ...base,
      state: 'unknown',
      detail: 'No Redis URL configured.',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }

  const client = await redis();
  if (!client) {
    return {
      ...base,
      state: 'down',
      detail: 'Redis connection could not be established.',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }

  const started = Date.now();
  try {
    await client.ping();
    return {
      ...base,
      state: 'healthy',
      detail: 'PING succeeded.',
      lastSuccessAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      state: 'down',
      detail: error instanceof Error ? error.message : 'Unknown error',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }
}
