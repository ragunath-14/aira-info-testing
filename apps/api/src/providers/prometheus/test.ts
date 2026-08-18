import type { ConnectionTestResult } from '@airaos/types';
import { ProviderHttpClient } from '../../utils/http.js';
import { redactString } from '../../utils/redaction.js';
import { testFailure, testSuccess } from '../contract.js';

/**
 * Prometheus connection test (spec sections 21, 30).
 */
export interface PrometheusConfig {
  url: string;
  username: string | null;
  password: string | null;
}

export function buildClient(config: PrometheusConfig): ProviderHttpClient {
  const headers: Record<string, string> = {};
  if (config.username && config.password) {
    headers.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }

  return new ProviderHttpClient({
    provider: 'Prometheus',
    baseUrl: `${config.url.replace(/\/+$/, '')}/api/v1`,
    defaultHeaders: headers,
    timeoutMs: 10_000,
    retries: 1,
  });
}

/**
 * Runs `count(up)` rather than a real metric query: it is O(series-count) at
 * worst, needs no knowledge of the estate's labels, and tells the operator
 * whether anything is actually being scraped — a reachable Prometheus with zero
 * targets is a misconfiguration worth surfacing here (spec section 30).
 */
export async function testConnection(config: PrometheusConfig): Promise<ConnectionTestResult> {
  const started = Date.now();
  const http = buildClient(config);

  try {
    const response = await http.json<{
      status: string;
      data: { result: Array<{ value: [number, string] }> };
      error?: string;
    }>({ path: '/query', query: { query: 'count(up)' } });

    if (response.status !== 'success') {
      return testFailure(
        'prometheus',
        `Prometheus rejected the query: ${redactString(response.error ?? 'unknown error')}`,
        'PROVIDER_UNAVAILABLE',
        Date.now() - started,
      );
    }

    const targets = Number(response.data.result[0]?.value?.[1] ?? 0);
    const latencyMs = Date.now() - started;

    const details: Array<{ label: string; value: string }> = [
      { label: 'Scrape targets', value: String(targets) },
      { label: 'Authentication', value: config.username ? 'basic auth' : 'none' },
    ];

    // Also report how many are down; that is the number an operator cares about.
    try {
      const down = await http.json<{ data: { result: Array<{ value: [number, string] }> } }>({
        path: '/query',
        query: { query: 'count(up == 0)' },
      });
      details.push({
        label: 'Targets down',
        value: String(Number(down.data.result[0]?.value?.[1] ?? 0)),
      });
    } catch {
      // Optional detail only.
    }

    if (targets === 0) {
      return testSuccess(
        'prometheus',
        'Prometheus is reachable but is not scraping any targets yet.',
        latencyMs,
        details,
      );
    }

    return testSuccess('prometheus', 'Connection successful.', latencyMs, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Prometheus is unreachable.';
    const isAuth = /credential|401|403|unauthor/i.test(message);
    return testFailure(
      'prometheus',
      isAuth
        ? 'Prometheus rejected the credentials. Check the username and password.'
        : redactString(message),
      isAuth ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_UNAVAILABLE',
      null,
    );
  } finally {
    await http.close().catch(() => undefined);
  }
}
