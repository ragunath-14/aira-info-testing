'use client';

import { useQuery } from '@tanstack/react-query';
import type { MetricSummary, RedisOverview } from '@airaos/types';
import { Info, Zap } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Card, CardBody, CardHeader, Field } from '@/components/ui/primitives';
import { HealthBadge } from '@/components/shared/status';
import { MetricCard, UsageBar } from '@/components/shared/metric';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { formatBytes, formatDuration, formatNumber } from '@/lib/utils';

/**
 * Redis overview (spec section 27).
 *
 * Reporting only. V1 deliberately offers no key browsing or mutation: an
 * unrestricted key editor against a production cache is a foot-gun with no
 * matching operational need.
 */
export default function RedisPage() {
  return (
    <PermissionGate permission="infra.view">
      <RedisView />
    </PermissionGate>
  );
}

function RedisView() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['redis'],
    queryFn: () => api.get<RedisOverview>('monitoring/redis'),
    refetchInterval: 15_000,
  });

  const metrics: MetricSummary[] = data
    ? [
        {
          key: 'memory',
          label: 'Memory used',
          unit: 'bytes',
          value: data.usedMemoryBytes,
          series: null,
          warnAbove: null,
          criticalAbove: null,
          unavailableReason: data.usedMemoryBytes === null ? 'INFO did not report memory usage.' : null,
        },
        {
          key: 'ops',
          label: 'Operations / second',
          unit: 'rps',
          value: data.opsPerSecond,
          series: null,
          warnAbove: null,
          criticalAbove: null,
          unavailableReason: data.opsPerSecond === null ? 'Not reported by this Redis version.' : null,
        },
        {
          key: 'hit_rate',
          label: 'Hit rate',
          unit: 'percent',
          value: data.hitRate,
          series: null,
          warnAbove: null,
          criticalAbove: null,
          unavailableReason: data.hitRate === null ? 'No keyspace hits or misses recorded yet.' : null,
        },
        {
          key: 'clients',
          label: 'Connected clients',
          unit: 'count',
          value: data.connectedClients,
          series: null,
          warnAbove: null,
          criticalAbove: null,
          unavailableReason: data.connectedClients === null ? 'Not reported.' : null,
        },
        {
          key: 'evictions',
          label: 'Evicted keys',
          unit: 'count',
          value: data.evictedKeys,
          series: null,
          warnAbove: 1,
          criticalAbove: 1000,
          unavailableReason: data.evictedKeys === null ? 'Not reported.' : null,
        },
        {
          key: 'keys',
          label: 'Keys',
          unit: 'count',
          value: data.totalKeys,
          series: null,
          warnAbove: null,
          criticalAbove: null,
          unavailableReason: data.totalKeys === null ? 'Keyspace not reported.' : null,
        },
      ]
    : [];

  return (
    <PageShell
      title="Redis"
      description="Cache and queue health. Read-only: the console does not expose key manipulation."
      actions={
        data ? (
          <div className="flex items-center gap-2">
            <EnvironmentBadge environment={data.environment} size="sm" />
            <HealthBadge state={data.state} />
          </div>
        ) : null
      }
    >
      {error ? <QueryError error={error} onRetry={() => void refetch()} context="Redis" /> : null}

      {data && !data.configured ? (
        <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {data.message ?? 'Redis is not configured.'} Set REDIS_URL to enable this page. Without it
            the console also falls back to in-process rate limiting, which does not hold across API
            replicas.
          </span>
        </div>
      ) : null}

      {data?.configured ? (
        <div className="space-y-4">
          {data.message ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {data.message}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {metrics.map((metric) => (
              <MetricCard key={metric.key} metric={metric} />
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Server" />
              <CardBody className="pt-1">
                <Field label="Version" value={data.version ?? '—'} mono />
                <Field label="Uptime" value={formatDuration(data.uptimeSeconds)} />
                <Field
                  label="Memory"
                  value={
                    data.maxMemoryBytes ? (
                      <UsageBar
                        used={data.usedMemoryBytes}
                        total={data.maxMemoryBytes}
                        label={`${formatBytes(data.usedMemoryBytes)} / ${formatBytes(data.maxMemoryBytes)}`}
                      />
                    ) : (
                      `${formatBytes(data.usedMemoryBytes)} (no maxmemory set)`
                    )
                  }
                />
                <Field label="Connected clients" value={formatNumber(data.connectedClients)} />
                <Field label="Blocked clients" value={formatNumber(data.blockedClients)} />
                <Field label="Commands processed" value={formatNumber(data.commandsProcessed)} />
                <Field label="Keyspace hits" value={formatNumber(data.keyspaceHits)} />
                <Field label="Keyspace misses" value={formatNumber(data.keyspaceMisses)} />
                <Field label="Expired keys" value={formatNumber(data.expiredKeys)} />
                <Field label="Evicted keys" value={formatNumber(data.evictedKeys)} />
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Keyspace" description="Per-database key counts from INFO keyspace." />
              <CardBody className="pt-1">
                {data.keyspace.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No databases hold keys, or the keyspace section was empty.
                  </p>
                ) : (
                  data.keyspace.map((entry) => (
                    <Field
                      key={entry.db}
                      label={entry.db}
                      value={`${formatNumber(entry.keys)} key(s) · ${formatNumber(entry.expires)} with TTL`}
                    />
                  ))
                )}
              </CardBody>
            </Card>
          </div>

          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Zap className="h-3 w-3" aria-hidden />
            The console issues only INFO, DBSIZE and PING. There is no route that reads, writes or
            deletes a key.
          </p>
        </div>
      ) : isLoading ? null : null}
    </PageShell>
  );
}
