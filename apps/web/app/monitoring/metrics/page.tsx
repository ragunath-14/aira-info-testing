'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { GrafanaLink, MetricSummary } from '@airaos/types';
import { ArrowUpRight, BarChart3, Info } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Card, CardBody, CardHeader, Input, Label, Select } from '@/components/ui/primitives';
import { MetricCard } from '@/components/shared/metric';

/**
 * Metrics page (spec sections 13, 14).
 *
 * Summary metrics only. Grafana stays the deep-observability tool and is linked
 * out to rather than embedded — duplicating it here would be a second dashboard
 * to maintain, and embedding it would mean loosening the CSP.
 *
 * The browser picks from a preset catalogue; it never sends PromQL.
 */

interface PresetsResponse {
  items: Array<{ key: string; label: string; unit: string; targetLabel: string }>;
  configured: boolean;
  grafana: GrafanaLink[];
}

/**
 * Every preset in the backend catalogue, grouped for display. Keep this in sync
 * with providers/prometheus/presets.ts: a preset missing here is one an operator
 * can never see. The total is 24, which splits into exactly two batches of 12 —
 * the API's per-request cap.
 */
const GROUPS: Array<{ label: string; presets: string[] }> = [
  {
    label: 'Infrastructure',
    presets: ['node_cpu', 'node_memory', 'node_disk', 'node_filesystem', 'node_load', 'node_network'],
  },
  {
    label: 'Applications',
    presets: ['app_request_rate', 'app_error_rate', 'app_latency_p95', 'app_status_codes'],
  },
  { label: 'Containers', presets: ['container_cpu', 'container_memory', 'container_restarts'] },
  {
    label: 'PostgreSQL',
    presets: [
      'pg_connections',
      'pg_database_size',
      'pg_cache_hit_ratio',
      'pg_locks',
      'pg_transactions',
      'pg_replication_lag',
    ],
  },
  {
    label: 'Redis',
    presets: ['redis_memory', 'redis_commands', 'redis_hit_rate', 'redis_evictions', 'redis_connections'],
  },
];

export default function MetricsPage() {
  return (
    <PermissionGate permission="infra.view">
      <Metrics />
    </PermissionGate>
  );
}

function Metrics() {
  const [target, setTarget] = useState('');
  const [rangeMinutes, setRangeMinutes] = useState(60);

  const presets = useQuery({
    queryKey: ['metrics', 'presets'],
    queryFn: () => api.get<PresetsResponse>('monitoring/presets'),
    staleTime: 300_000,
  });

  const metrics = useQuery({
    queryKey: ['metrics', 'values', target, rangeMinutes],
    queryFn: () =>
      api.post<{ items: MetricSummary[] }>('monitoring/metrics', {
        requests: GROUPS.flatMap((group) => group.presets)
          // The API caps a batch at 12, so the request is chunked by group order.
          .slice(0, 12)
          .map((preset) => ({ preset, target: target || undefined, withSeries: true, rangeMinutes })),
      }),
    enabled: presets.data?.configured ?? false,
    refetchInterval: 30_000,
  });

  const secondBatch = useQuery({
    queryKey: ['metrics', 'values2', target, rangeMinutes],
    queryFn: () =>
      api.post<{ items: MetricSummary[] }>('monitoring/metrics', {
        requests: GROUPS.flatMap((group) => group.presets)
          .slice(12, 24)
          .map((preset) => ({ preset, target: target || undefined, withSeries: true, rangeMinutes })),
      }),
    enabled: presets.data?.configured ?? false,
    refetchInterval: 30_000,
  });

  const byKey = new Map(
    [...(metrics.data?.items ?? []), ...(secondBatch.data?.items ?? [])].map((metric) => [
      metric.key,
      metric,
    ]),
  );

  return (
    <PageShell
      title="Metrics"
      description="Operational summary from Prometheus. Grafana remains the tool for deep analysis."
      actions={
        <div className="flex items-end gap-2">
          <div>
            <Label htmlFor="metric-target">Target filter</Label>
            <Input
              id="metric-target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="instance / job / container"
              className="h-8 w-56 text-xs"
            />
          </div>
          <div>
            <Label htmlFor="metric-range">Range</Label>
            <Select
              id="metric-range"
              value={rangeMinutes}
              onChange={(event) => setRangeMinutes(Number(event.target.value))}
              className="h-8 text-xs"
            >
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={360}>6 hours</option>
              <option value={1440}>24 hours</option>
              <option value={10080}>7 days</option>
            </Select>
          </div>
        </div>
      }
    >
      {presets.error ? (
        <QueryError error={presets.error} onRetry={() => void presets.refetch()} context="Prometheus" />
      ) : null}

      {presets.data && !presets.data.configured ? (
        <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Prometheus is not configured on this console instance. Set PROMETHEUS_URL to populate this
            page. Until then, nothing here is reported as healthy — it is reported as not collected.
          </span>
        </div>
      ) : null}

      <div className="space-y-5">
        {GROUPS.map((group) => (
          <section key={group.label}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <BarChart3 className="h-4 w-4 text-muted-foreground" aria-hidden />
              {group.label}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {group.presets.map((key) => {
                const metric = byKey.get(key);
                const definition = presets.data?.items.find((item) => item.key === key);
                return (
                  <MetricCard
                    key={key}
                    metric={
                      metric ?? {
                        key,
                        label: definition?.label ?? key,
                        unit: (definition?.unit as MetricSummary['unit']) ?? 'count',
                        value: null,
                        series: null,
                        warnAbove: null,
                        criticalAbove: null,
                        unavailableReason: presets.data?.configured
                          ? 'Waiting for the first sample.'
                          : 'Prometheus is not configured.',
                      }
                    }
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {(presets.data?.grafana ?? []).length > 0 ? (
        <Card className="mt-5">
          <CardHeader
            title="Grafana"
            description="Deep observability lives in Grafana. These links open it in a new tab."
          />
          <CardBody className="flex flex-wrap gap-2">
            {presets.data?.grafana.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                {link.label}
                <ArrowUpRight className="h-3 w-3" aria-hidden />
              </a>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <p className="mt-4 text-2xs text-muted-foreground">
        Metric expressions are built server-side from a fixed preset catalogue. The browser cannot
        submit PromQL, which keeps arbitrary queries off this surface.
      </p>
    </PageShell>
  );
}
