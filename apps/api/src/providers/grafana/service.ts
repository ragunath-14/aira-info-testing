import type { GrafanaLink, SubsystemHealth } from '@airaos/types';
import { ProviderHttpClient } from '../../utils/http.js';
import { logger } from '../../utils/logger.js';
import { redactString } from '../../utils/redaction.js';
import { testFailure, testSuccess } from '../contract.js';
import type { ConnectionTestResult } from '@airaos/types';

/**
 * Grafana adapter (spec section 22).
 *
 * Scope is deliberately narrow: the console links out to Grafana rather than
 * embedding or reimplementing it. This adapter exists to validate the connection
 * and to build deep links — the API token is used for health checks only and
 * never appears in a URL handed to a browser.
 */

export interface GrafanaConfig {
  url: string;
  apiToken: string | null;
  organisationId: number | null;
}

interface GrafanaHealthResponse {
  commit?: string;
  database?: string;
  version?: string;
}

function client(config: GrafanaConfig): ProviderHttpClient {
  return new ProviderHttpClient({
    provider: 'Grafana',
    baseUrl: `${config.url.replace(/\/+$/, '')}/api`,
    defaultHeaders: config.apiToken
      ? { authorization: `Bearer ${config.apiToken}` }
      : {},
    timeoutMs: 8000,
    retries: 1,
  });
}

/**
 * Cheap credential and reachability probe.
 *
 * `/api/health` needs no authentication, so it confirms Grafana is reachable. When
 * a token is supplied, `/api/org` is also called because that is what actually
 * proves the token works — a health check alone would pass with a bad token and
 * report a false success.
 */
export async function testConnection(config: GrafanaConfig): Promise<ConnectionTestResult> {
  const started = Date.now();
  const http = client(config);

  try {
    const health = await http.json<GrafanaHealthResponse>({ path: '/health' });
    const details: Array<{ label: string; value: string }> = [];

    if (health.version) details.push({ label: 'Version', value: health.version });
    if (health.database) details.push({ label: 'Grafana database', value: health.database });

    if (config.apiToken) {
      try {
        const org = await http.json<{ id: number; name: string }>({ path: '/org' });
        details.push({ label: 'Organisation', value: org.name ?? String(org.id) });
        details.push({ label: 'Token', value: 'accepted' });
      } catch {
        return testFailure(
          'grafana',
          'Grafana is reachable but rejected the API token. Check the token and its role.',
          'PROVIDER_AUTH_FAILED',
          Date.now() - started,
        );
      }
    } else {
      details.push({ label: 'Token', value: 'none — deep links only' });
    }

    return testSuccess(
      'grafana',
      'Grafana is reachable.',
      Date.now() - started,
      details,
    );
  } catch (error) {
    return testFailure(
      'grafana',
      redactString(error instanceof Error ? error.message : 'Grafana is unreachable.'),
      'PROVIDER_UNAVAILABLE',
      null,
    );
  } finally {
    await http.close().catch(() => undefined);
  }
}

export async function health(config: GrafanaConfig | null): Promise<SubsystemHealth> {
  const base = {
    key: 'grafana',
    label: 'Grafana',
    configured: config !== null,
    lastCheckedAt: new Date().toISOString(),
  };

  if (!config) {
    return {
      ...base,
      state: 'unknown',
      detail: 'No Grafana connection configured.',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }

  const result = await testConnection(config);
  return {
    ...base,
    state: result.ok ? 'healthy' : 'down',
    detail: result.message,
    lastSuccessAt: result.ok ? result.testedAt : null,
    latencyMs: result.latencyMs,
  };
}

/**
 * Dashboard deep links. Built from the connection's URL so they follow whatever
 * Grafana the operator configured, and never carry the API token.
 */
export function links(config: GrafanaConfig | null): GrafanaLink[] {
  if (!config?.url) return [];
  const base = config.url.replace(/\/+$/, '');
  const suffix = config.organisationId ? `?orgId=${config.organisationId}` : '';

  return [
    { label: 'Infrastructure overview', url: `${base}/d/airaos-infra${suffix}`, dashboardUid: 'airaos-infra' },
    { label: 'Application metrics', url: `${base}/d/airaos-apps${suffix}`, dashboardUid: 'airaos-apps' },
    { label: 'PostgreSQL', url: `${base}/d/airaos-postgres${suffix}`, dashboardUid: 'airaos-postgres' },
    { label: 'Redis', url: `${base}/d/airaos-redis${suffix}`, dashboardUid: 'airaos-redis' },
    { label: 'Explore', url: `${base}/explore${suffix}`, dashboardUid: null },
  ];
}

/** Lists dashboards, used to confirm the token has read access. Optional. */
export async function listDashboards(
  config: GrafanaConfig,
): Promise<Array<{ uid: string; title: string; url: string }>> {
  if (!config.apiToken) return [];
  const http = client(config);
  try {
    const results = await http.json<Array<{ uid: string; title: string; url: string }>>({
      path: '/search',
      query: { type: 'dash-db', limit: 50 },
    });
    const base = config.url.replace(/\/+$/, '');
    return (results ?? []).map((entry) => ({
      uid: entry.uid,
      title: entry.title,
      url: `${base}${entry.url}`,
    }));
  } catch (error) {
    logger().debug({ err: error }, 'grafana dashboard list unavailable');
    return [];
  } finally {
    await http.close().catch(() => undefined);
  }
}
