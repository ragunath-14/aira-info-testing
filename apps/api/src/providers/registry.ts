import type { ConnectionTestResult, ConnectionType } from '@airaos/types';
import { testFailure } from './contract.js';
import { logger } from '../utils/logger.js';
import * as digitalOceanTest from './digitalocean/test.js';
import * as proxmoxTest from './proxmox/test.js';
import * as postgresTest from './databases/test.js';
import * as redisTest from './redis/test.js';
import * as prometheusTest from './prometheus/test.js';
import * as grafana from './grafana/service.js';

/**
 * Provider registry (spec sections 24, 36).
 *
 * The one place that maps a connection type to its adapter. Everything above this
 * line — the connections service, the routes, the UI — works with
 * `ConnectionType` and never names a provider, so adding AWS or Hetzner later
 * means adding an adapter plus a schema and one entry here.
 *
 * Types are separated from the credentials they need by `contract.ts`, so nothing
 * outside an adapter knows what a given provider's secret looks like.
 */

/** Splits a resolved config into the shape its adapter expects. */
type Tester = (config: Record<string, unknown>) => Promise<ConnectionTestResult>;

const TESTERS: Record<ConnectionType, Tester> = {
  digitalocean: (config) =>
    digitalOceanTest.testConnection(config as unknown as digitalOceanTest.DigitalOceanConfig),
  proxmox: (config) => proxmoxTest.testConnection(config as unknown as proxmoxTest.ProxmoxConfig),
  postgres: (config) => postgresTest.testConnection(config as unknown as postgresTest.PostgresConfig),
  redis: (config) => redisTest.testConnection(config as unknown as redisTest.RedisConfig),
  prometheus: (config) =>
    prometheusTest.testConnection(config as unknown as prometheusTest.PrometheusConfig),
  grafana: (config) => grafana.testConnection(config as unknown as grafana.GrafanaConfig),
};

/**
 * Probes a candidate or stored configuration.
 *
 * Never throws: adapters return a failure result, and anything that escapes them
 * is converted here. The caller renders the message directly, so an exception
 * leaking through would show a stack trace to an operator.
 */
export async function testConnection(
  type: ConnectionType,
  config: Record<string, unknown>,
): Promise<ConnectionTestResult> {
  const tester = TESTERS[type];
  if (!tester) {
    return testFailure(type, `No adapter is registered for "${type}".`, 'PROVIDER_NOT_CONFIGURED');
  }

  try {
    return await tester(config);
  } catch (error) {
    logger().error({ err: error, type }, 'connection tester threw');
    return testFailure(
      type,
      'The connection test could not be completed. The request id below appears in the logs.',
      'INTERNAL_ERROR',
    );
  }
}

/** Connection types this build can actually talk to. */
export function supportedTypes(): ConnectionType[] {
  return Object.keys(TESTERS) as ConnectionType[];
}
