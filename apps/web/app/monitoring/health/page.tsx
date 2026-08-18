'use client';

import { useQuery } from '@tanstack/react-query';
import type { DashboardOverview } from '@airaos/types';
import { Activity, CircleHelp } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Card, CardBody, CardHeader, Field } from '@/components/ui/primitives';
import { HealthBadge } from '@/components/shared/status';
import { ScoreRing } from '@/components/shared/metric';
import { formatMs, formatRelative } from '@/lib/utils';

/**
 * Health page.
 *
 * A per-subsystem view of the same data the overview summarises, including the
 * explicit list of subsystems that did not report. That list is the point: it is
 * how an operator discovers a monitoring gap rather than mistaking it for calm.
 */
export default function HealthPage() {
  return (
    <PermissionGate permission="infra.view">
      <Health />
    </PermissionGate>
  );
}

function Health() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardOverview>('dashboard'),
    refetchInterval: 20_000,
  });

  const selfHealth = useQuery({
    queryKey: ['self-health'],
    // The API's /health sits outside /api/v1, so it has its own thin route
    // handler on this origin rather than going through the versioned proxy.
    queryFn: async () => {
      const response = await fetch('/api/health', { cache: 'no-store' }).catch(() => null);
      if (!response?.ok) return null;
      return (await response.json()) as {
        status: string;
        version: string;
        uptimeSeconds: number;
        checks: Array<{ name: string; status: string; latencyMs: number | null; detail: string | null }>;
      };
    },
    refetchInterval: 60_000,
    retry: false,
  });

  return (
    <PageShell
      title="Health"
      description="Every subsystem the console monitors, and every one it cannot see."
    >
      {error ? <QueryError error={error} onRetry={() => void refetch()} context="Health" /> : null}

      {data ? (
        <div className="space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-center gap-6">
              <ScoreRing score={data.healthScore} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {data.subsystems.length - data.unreportedSubsystems.length} of{' '}
                  {data.subsystems.length} subsystems reporting
                </p>
                {data.unreportedSubsystems.length > 0 ? (
                  <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
                      <CircleHelp className="h-3.5 w-3.5" aria-hidden />
                      Not counted in the score
                    </p>
                    <p className="mt-0.5 text-xs text-warning/90">
                      {data.unreportedSubsystems.join(', ')} — either unconfigured or unreachable.
                      These are gaps in coverage, not evidence of health.
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Every subsystem is configured and reporting.
                  </p>
                )}
              </div>
            </CardBody>
          </Card>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.subsystems.map((subsystem) => (
              <Card key={subsystem.key}>
                <CardHeader
                  title={subsystem.label}
                  actions={<HealthBadge state={subsystem.state} />}
                />
                <CardBody className="pt-1">
                  <p className="mb-2 text-xs text-muted-foreground">{subsystem.detail}</p>
                  <Field label="Configured" value={subsystem.configured ? 'yes' : 'no'} />
                  <Field label="Latency" value={formatMs(subsystem.latencyMs)} />
                  <Field
                    label="Last success"
                    value={formatRelative(subsystem.lastSuccessAt)}
                    title={subsystem.lastSuccessAt ?? undefined}
                  />
                  <Field label="Last checked" value={formatRelative(subsystem.lastCheckedAt)} />
                </CardBody>
              </Card>
            ))}
          </div>

          {selfHealth.data ? (
            <Card>
              <CardHeader
                title="Console itself"
                description={`Version ${selfHealth.data.version} · up ${Math.round(selfHealth.data.uptimeSeconds / 60)} minute(s)`}
                actions={
                  <HealthBadge
                    state={
                      selfHealth.data.status === 'ok'
                        ? 'healthy'
                        : selfHealth.data.status === 'degraded'
                          ? 'degraded'
                          : 'down'
                    }
                  />
                }
              />
              <CardBody className="pt-1">
                {selfHealth.data.checks.map((check) => (
                  <Field
                    key={check.name}
                    label={check.name.replace(/_/g, ' ')}
                    value={
                      <span className="flex items-center gap-2">
                        {check.status === 'skipped' ? (
                          <span className="text-xs text-muted-foreground">not configured</span>
                        ) : (
                          <HealthBadge
                            state={
                              check.status === 'ok'
                                ? 'healthy'
                                : check.status === 'degraded'
                                  ? 'degraded'
                                  : 'down'
                            }
                          />
                        )}
                        {check.latencyMs !== null ? (
                          <span className="text-2xs text-muted-foreground">
                            {formatMs(check.latencyMs)}
                          </span>
                        ) : null}
                      </span>
                    }
                  />
                ))}
              </CardBody>
            </Card>
          ) : null}

          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Activity className="h-3 w-3" aria-hidden />
            The console exposes /health, /health/live and /health/ready for load balancers and uptime
            checks.
          </p>
        </div>
      ) : isLoading ? null : null}
    </PageShell>
  );
}
