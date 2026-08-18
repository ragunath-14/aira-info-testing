import { Redis } from 'ioredis';
import type { ConnectionTestResult } from '@airaos/types';
import { redactString } from '../../utils/redaction.js';
import { testFailure, testSuccess } from '../contract.js';

/**
 * Redis connection test (spec sections 20, 30).
 *
 * PING plus a single INFO section — cheap, and enough to report version and
 * memory. Deliberately no KEYS or SCAN: those are O(n) on a production cache.
 */
export interface RedisConfig {
  host: string;
  port: number;
  password: string | null;
  tls: boolean;
  db: number;
}

export function buildClient(config: RedisConfig): Redis {
  return new Redis({
    host: config.host,
    port: config.port,
    password: config.password ?? undefined,
    db: config.db,
    tls: config.tls ? {} : undefined,
    connectionName: 'airaos-console-test',
    // Fail fast: a connection test must not hang on an unreachable host.
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    retryStrategy: () => null,
  });
}

export async function testConnection(config: RedisConfig): Promise<ConnectionTestResult> {
  const started = Date.now();
  const client = buildClient(config);

  try {
    await client.connect();
    await client.ping();
    const latencyMs = Date.now() - started;

    const details: Array<{ label: string; value: string }> = [
      { label: 'Database index', value: String(config.db) },
      { label: 'TLS', value: config.tls ? 'enabled' : 'disabled' },
      { label: 'Password', value: config.password ? 'set' : 'none' },
    ];

    try {
      const info = await client.info('server');
      const version = /redis_version:([^\r\n]+)/.exec(info)?.[1];
      if (version) details.push({ label: 'Version', value: version });

      const memory = await client.info('memory');
      const used = /used_memory_human:([^\r\n]+)/.exec(memory)?.[1];
      if (used) details.push({ label: 'Memory used', value: used.trim() });
    } catch {
      // INFO can be disabled by ACL; PING already proved reachability.
      details.push({ label: 'INFO', value: 'not permitted for this user' });
    }

    return testSuccess('redis', 'Connection successful.', latencyMs, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Redis is unreachable.';
    const isAuth = /NOAUTH|WRONGPASS|invalid password|Authentication/i.test(message);

    return testFailure(
      'redis',
      isAuth
        ? 'Redis rejected the credentials. Check the password, or clear it if the server has none.'
        : redactString(message),
      isAuth ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_UNAVAILABLE',
      null,
    );
  } finally {
    // disconnect rather than quit: the socket may never have opened.
    client.disconnect();
  }
}
