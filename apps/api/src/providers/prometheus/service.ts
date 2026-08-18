import type { GrafanaLink, MetricSummary, SubsystemHealth, TimeSeries } from '@airaos/types';
import { errors } from '../../utils/errors.js';
import { providerCache } from '../../utils/cache.js';
import type { ProviderHttpClient } from '../../utils/http.js';
import { logger } from '../../utils/logger.js';
import { resolve } from '../../connections/resolver.js';
import * as grafana from '../grafana/service.js';
import { buildClient, type PrometheusConfig } from './test.js';
import { METRIC_PRESETS, buildExpression, type MetricPreset } from './presets.js';

/**
 * Prometheus query client.
 *
 * Only /query and /query_range are used, and only with expressions built from
 * the preset catalogue. Admin endpoints (/admin/tsdb/*) are never called.
 */

interface PromInstantResponse {
  status: 'success' | 'error';
  data: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; value: [number, string] }>;
  };
  errorType?: string;
  error?: string;
}

interface PromRangeResponse {
  status: 'success' | 'error';
  data: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
  };
  errorType?: string;
  error?: string;
}

let httpClient: ProviderHttpClient | null = null;
let clientUrl: string | null = null;

async function activeConfig(): Promise<PrometheusConfig | null> {
  const resolved = await resolve('prometheus');
  return resolved ? (resolved.config as unknown as PrometheusConfig) : null;
}

/** Async because configuration now comes from the Connection Manager. */
export async function configured(): Promise<boolean> {
  return (await activeConfig()) !== null;
}

/** Rebuilt whenever the resolved URL changes, so a saved connection takes effect. */
async function client(): Promise<ProviderHttpClient> {
  const cfg = await activeConfig();
  if (!cfg?.url) throw errors.providerNotConfigured('Prometheus');

  if (!httpClient || clientUrl !== cfg.url) {
    await httpClient?.close().catch(() => undefined);
    httpClient = buildClient(cfg);
    clientUrl = cfg.url;
  }
  return httpClient;
}

export function lastSuccessAt(): string | null {
  return httpClient?.lastSuccessIso ?? null;
}

/** Latest value for a preset. Returns null when the series has no data. */
export async function instant(
  presetKey: string,
  target?: string,
): Promise<{ value: number | null; labels: Record<string, string> } | null> {
  const preset = requirePreset(presetKey);
  const response = await (await client()).json<PromInstantResponse>({
    path: '/query',
    query: { query: buildExpression(preset, target) },
  });

  if (response.status !== 'success') {
    throw errors.providerUnavailable('Prometheus', lastSuccessAt(), {
      promError: response.error,
    });
  }

  const first = response.data.result[0];
  if (!first) return null;
  const parsed = Number(first.value[1]);
  return { value: Number.isFinite(parsed) ? parsed : null, labels: first.metric };
}

export interface RangeSeries {
  labels: Record<string, string>;
  points: TimeSeries;
}

export async function range(
  presetKey: string,
  options: { target?: string; rangeMinutes: number; stepSeconds?: number },
): Promise<RangeSeries[]> {
  const preset = requirePreset(presetKey);
  const end = Math.floor(Date.now() / 1000);
  const start = end - options.rangeMinutes * 60;
  // Aim for roughly 200 points: enough for a readable chart, few enough to keep
  // the query cheap on a long window.
  const step = options.stepSeconds ?? Math.max(15, Math.round((end - start) / 200));

  const response = await (await client()).json<PromRangeResponse>({
    path: '/query_range',
    query: { query: buildExpression(preset, options.target), start, end, step },
  });

  if (response.status !== 'success') {
    throw errors.providerUnavailable('Prometheus', lastSuccessAt(), { promError: response.error });
  }

  return response.data.result.map((series) => ({
    labels: series.metric,
    points: series.values
      .map(([seconds, value]) => ({ t: new Date(seconds * 1000).toISOString(), v: Number(value) }))
      .filter((point) => Number.isFinite(point.v)),
  }));
}

/**
 * Builds the summary card shape used across the console. A collection failure
 * becomes `unavailableReason` rather than a zero, so an unreachable exporter is
 * never displayed as a healthy 0%.
 */
export async function summary(
  presetKey: string,
  options: { target?: string; rangeMinutes?: number; withSeries?: boolean } = {},
): Promise<MetricSummary> {
  const preset = requirePreset(presetKey);
  const cacheKey = `prom:summary:${presetKey}:${options.target ?? '*'}:${options.rangeMinutes ?? 0}:${options.withSeries ? 's' : 'v'}`;

  const base: MetricSummary = {
    key: preset.key,
    label: preset.label,
    unit: preset.unit,
    value: null,
    series: null,
    warnAbove: preset.warnAbove,
    criticalAbove: preset.criticalAbove,
    unavailableReason: null,
  };

  if (!(await configured())) {
    return { ...base, unavailableReason: 'Prometheus is not configured.' };
  }

  try {
    const result = await providerCache.wrap(
      cacheKey,
      20_000,
      async () => {
        const point = await instant(presetKey, options.target);
        let series: TimeSeries | null = null;
        if (options.withSeries) {
          const ranges = await range(presetKey, {
            target: options.target,
            rangeMinutes: options.rangeMinutes ?? 60,
          });
          series = ranges[0]?.points ?? null;
        }
        return { value: point?.value ?? null, series };
      },
      { fallbackToStale: true },
    );

    return { ...base, value: result.value.value, series: result.value.series };
  } catch (error) {
    logger().debug({ err: error, preset: presetKey }, 'metric unavailable');
    return {
      ...base,
      unavailableReason:
        error instanceof Error ? error.message : 'Metric could not be collected.',
    };
  }
}

/** Fetches several presets concurrently for a dashboard row. */
export async function summaries(
  requests: Array<{ preset: string; target?: string; withSeries?: boolean; rangeMinutes?: number }>,
): Promise<MetricSummary[]> {
  return Promise.all(
    requests.map((request) =>
      summary(request.preset, {
        target: request.target,
        withSeries: request.withSeries,
        rangeMinutes: request.rangeMinutes,
      }),
    ),
  );
}

function requirePreset(key: string): MetricPreset {
  const preset = METRIC_PRESETS[key];
  if (!preset) {
    // Unreachable through the HTTP API (the schema is an enum), but this keeps
    // internal callers honest too.
    throw errors.queryRejected(`Unknown metric preset "${key}".`);
  }
  return preset;
}

export function listPresets(): Array<Pick<MetricPreset, 'key' | 'label' | 'unit' | 'targetLabel'>> {
  return Object.values(METRIC_PRESETS).map((preset) => ({
    key: preset.key,
    label: preset.label,
    unit: preset.unit,
    targetLabel: preset.targetLabel,
  }));
}

export async function health(): Promise<SubsystemHealth> {
  const base = {
    key: 'prometheus',
    label: 'Prometheus',
    configured: await configured(),
    lastCheckedAt: new Date().toISOString(),
  };

  if (!(await configured())) {
    return {
      ...base,
      state: 'unknown',
      detail: 'No Prometheus URL configured.',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }

  const started = Date.now();
  try {
    // Also reports how many scrape targets are down, which is more useful than
    // a bare reachability check.
    const response = await (await client()).json<PromInstantResponse>({
      path: '/query',
      query: { query: 'count(up == 0)' },
    });
    const down = Number(response.data.result[0]?.value?.[1] ?? 0);
    return {
      ...base,
      state: down > 0 ? 'degraded' : 'healthy',
      detail: down > 0 ? `${down} scrape target(s) down.` : 'All scrape targets up.',
      lastSuccessAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      state: 'down',
      detail: error instanceof Error ? error.message : 'Unknown error',
      lastSuccessAt: lastSuccessAt(),
      latencyMs: null,
    };
  }
}

/**
 * Grafana deep links now come from the Grafana adapter, which owns that
 * connection. Re-exported here so existing callers keep working.
 */
export async function grafanaLinks(): Promise<GrafanaLink[]> {
  const resolved = await resolve('grafana');
  return grafana.links(resolved ? (resolved.config as unknown as grafana.GrafanaConfig) : null);
}

export async function closeClient(): Promise<void> {
  await httpClient?.close();
  httpClient = null;
}
