import type { Redis } from 'ioredis';
import { logger } from '../../utils/logger.js';
import { resolve } from '../../connections/resolver.js';
import { buildClient, type RedisConfig } from './test.js';

/**
 * Redis connection used for console cache and for the Redis overview page.
 *
 * Deliberately limited: the console reports on Redis but does not offer key
 * browsing or mutation in V1 (spec section 27). Only INFO, DBSIZE and PING are
 * ever issued.
 */

let connection: Redis | null = null;
let connectionKey: string | null = null;

async function activeConfig(): Promise<RedisConfig | null> {
  const resolved = await resolve('redis');
  return resolved ? (resolved.config as unknown as RedisConfig) : null;
}

/** Async because configuration now comes from the Connection Manager. */
export async function configured(): Promise<boolean> {
  return (await activeConfig()) !== null;
}

/**
 * The shared connection for the Redis overview page. Rebuilt when the resolved
 * target changes, so saving a connection takes effect without a restart.
 */
export async function redis(): Promise<Redis | null> {
  const cfg = await activeConfig();
  if (!cfg) return null;

  const key = `${cfg.host}:${cfg.port}/${cfg.db}:${cfg.tls ? 'tls' : 'plain'}:${cfg.password ? 'auth' : 'noauth'}`;
  if (connection && connectionKey === key) return connection;

  if (connection) {
    connection.disconnect();
    connection = null;
  }

  const client = buildClient(cfg);
  client.on('error', (error) => {
    logger().debug({ err: error }, 'redis connection error');
  });

  try {
    await client.connect();
  } catch (error) {
    logger().debug({ err: error }, 'redis connection failed');
    client.disconnect();
    return null;
  }

  connection = client;
  connectionKey = key;
  return connection;
}

export async function closeRedis(): Promise<void> {
  if (connection) {
    try {
      await connection.quit();
    } catch {
      connection.disconnect();
    }
    connection = null;
    connectionKey = null;
  }
}
