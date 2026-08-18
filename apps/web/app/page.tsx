'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { DashboardOverview } from '@airaos/types';
import { ENVIRONMENTS } from '@airaos/types';
import {
  AlertTriangle,
  ArrowUpRight,
  Cloud,
  Database,
  Info,
  Rocket,
  Server,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Card, CardBody, CardHeader, Skeleton } from '@/components/ui/primitives';
import { HealthBadge, HealthDot } from '@/components/shared/status';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { ScoreRing } from '@/components/shared/metric';
import { formatBytes, formatNumber, formatRelative } from '@/lib/utils';

/**
 * Unified overview (spec section 5).
 *
 * The health score deliberately excludes subsystems that did not report, and the
 * page says which those were — a console that shows 100% because half the estate
 * is unmonitored is worse than one that admits the gap.
 */
export default function OverviewPage() {
  return (
    <PermissionGate permission="infra.view">
      <Overview />
    </PermissionGate>
  );
}

function Overview() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardOverview>('dashboard'),
    refetchInterval: 30_000,
  });

  return (
    <PageShell
      title="Overview"
      description="What is running, where, and whether it is healthy."
      actions={
        data ? (
          <span className="text-xs text-muted-foreground">
            Updated {formatRelative(data.generatedAt)}
          </span>
        ) : null
      }
    >
      {error ? (
        <QueryError error={error} onRetry={() => void refetch()} context="The dashboard" />
      ) : null}

      {isLoading && !data ? <OverviewSkeleton /> : null}

      {data ? (
        <div className="space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-center gap-6">
              <ScoreRing
                score={data.healthScore}
                caption={
                  data.unreportedSubsystems.length > 0
                    ? `Scored across ${data.subsystems.length - data.unreportedSubsystems.length} reporting subsystem(s). Not counted: ${data.unreportedSubsystems.join(', ')}.`
                    : `Scored across all ${data.subsystems.length} subsystems.`
                }
              />

              <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4">
                {data.subsystems.map((subsystem) => (
                  <div key={subsystem.key} className="flex items-start gap-2">
                    <HealthDot state={subsystem.state} className="mt-1.5" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{subsystem.label}</p>
                      <p className="truncate text-2xs text-muted-foreground" title={subsystem.detail}>
                        {subsystem.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              icon={<Cloud className="h-4 w-4" aria-hidden />}
              title="DigitalOcean"
              href="/infrastructure/digitalocean"
              configured={data.digitalocean.configured}
              unconfiguredNote="No API token configured."
              rows={[
                ['Droplets', formatNumber(data.digitalocean.dropletTotal)],
                ['Active', formatNumber(data.digitalocean.dropletActive)],
                ['Powered off', formatNumber(data.digitalocean.dropletOff)],
                ['Regions', data.digitalocean.regions.join(', ') || '—'],
              ]}
              footer={
                <div className="flex flex-wrap gap-1">
                  {ENVIRONMENTS.filter(
                    (environment) => data.digitalocean.byEnvironment[environment] > 0,
                  ).map((environment) => (
                    <Badge key={environment} tone="outline">
                      <EnvironmentBadge environment={environment} size="sm" />
                      {data.digitalocean.byEnvironment[environment]}
                    </Badge>
                  ))}
                </div>
              }
            />

            <SummaryCard
              icon={<Server className="h-4 w-4" aria-hidden />}
              title="Proxmox"
              href="/infrastructure/proxmox"
              configured={data.proxmox.configured}
              unconfiguredNote="No API URL or token configured."
              rows={[
                ['Cluster', data.proxmox.clusterName ?? 'standalone'],
                ['Nodes online', `${data.proxmox.nodeOnline} / ${data.proxmox.nodeTotal}`],
                ['VMs running', `${data.proxmox.qemuRunning} / ${data.proxmox.qemuTotal}`],
                ['Containers running', `${data.proxmox.lxcRunning} / ${data.proxmox.lxcTotal}`],
              ]}
            />

            <SummaryCard
              icon={<Rocket className="h-4 w-4" aria-hidden />}
              title="Applications"
              href="/applications/services"
              configured={data.applications.total > 0}
              unconfiguredNote="No applications registered yet."
              rows={[
                ['Healthy', formatNumber(data.applications.healthy)],
                ['Degraded', formatNumber(data.applications.degraded)],
                ['Down', formatNumber(data.applications.down)],
                ['Not probed', formatNumber(data.applications.unknown)],
              ]}
              footer={
                data.applications.deploying > 0 ? (
                  <Badge tone="info">{data.applications.deploying} deployment(s) in flight</Badge>
                ) : null
              }
            />

            <SummaryCard
              icon={<Database className="h-4 w-4" aria-hidden />}
              title="Databases"
              href="/database/connections"
              configured={data.databases.total > 0}
              unconfiguredNote="No database connections registered."
              rows={[
                ['Connections', formatNumber(data.databases.total)],
                ['Reachable', formatNumber(data.databases.reachable)],
                ['Unreachable', formatNumber(data.databases.unreachable)],
                [
                  'Total size',
                  data.databases.totalSizeBytes === null
                    ? 'not reported'
                    : formatBytes(data.databases.totalSizeBytes),
                ],
              ]}
              footer={
                <Badge tone={data.databases.productionReadOnly ? 'success' : 'warning'}>
                  {data.databases.productionReadOnly
                    ? 'Production read-only'
                    : 'A production connection allows writes'}
                </Badge>
              }
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title="Active alerts"
                description={`${data.alerts.critical} critical · ${data.alerts.warning} warning · ${data.alerts.info} info · ${data.alerts.unacknowledged} unacknowledged`}
                actions={
                  <Link
                    href="/monitoring/alerts"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    All alerts
                    <ArrowUpRight className="h-3 w-3" aria-hidden />
                  </Link>
                }
              />
              <CardBody className="p-0">
                {data.recentAlerts.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                    Nothing is firing right now.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {data.recentAlerts.map((alert) => (
                      <li key={alert.fingerprint} className="flex items-start gap-3 px-4 py-2.5">
                        {alert.severity === 'critical' ? (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                        ) : alert.severity === 'warning' ? (
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                        ) : (
                          <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" aria-hidden />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium">{alert.name}</p>
                            {alert.environment ? (
                              <EnvironmentBadge environment={alert.environment} size="sm" />
                            ) : (
                              <Badge tone="neutral">no environment label</Badge>
                            )}
                            {alert.acknowledgement ? (
                              <Badge tone="info">
                                ack by {alert.acknowledgement.acknowledgedByEmail}
                              </Badge>
                            ) : null}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">{alert.summary}</p>
                        </div>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {formatRelative(alert.startsAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Cache and queue" description="Redis, used for cache and jobs." />
              <CardBody className="space-y-3">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {data.redis.configured ? (
                    <HealthBadge state={data.redis.reachable ? 'healthy' : 'down'} />
                  ) : (
                    <Badge tone="neutral">Not configured</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {data.redis.configured
                    ? 'Memory, hit rate, evictions and connection counts are on the Redis page.'
                    : 'Set REDIS_URL to enable the Redis overview and shared rate limiting.'}
                </p>
                <Link
                  href="/redis"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Open Redis
                  <ArrowUpRight className="h-3 w-3" aria-hidden />
                </Link>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Environment policy"
              description="Guardrails applied by the console, not by convention."
            />
            <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {ENVIRONMENTS.map((environment) => (
                <div key={environment} className={`env-${environment} tone-surface rounded-md border p-3`}>
                  <EnvironmentBadge environment={environment} showFullLabel size="sm" />
                  <p className="mt-2 text-xs opacity-90">
                    {environment === 'production'
                      ? 'Databases read-only by default. Deployments need a second approver. Destructive VM and droplet actions are unavailable.'
                      : environment === 'staging'
                        ? 'Controlled write access. Deployments allowed. Hard stops unavailable.'
                        : environment === 'testing'
                          ? 'Developer access. All lifecycle operations available.'
                          : 'Full developer access.'}
                  </p>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}

function SummaryCard({
  icon,
  title,
  href,
  configured,
  unconfiguredNote,
  rows,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  href: string;
  configured: boolean;
  unconfiguredNote: string;
  rows: Array<[string, string]>;
  footer?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {icon}
            {title}
          </span>
        }
        actions={
          <Link href={href} className="text-xs text-primary hover:underline" aria-label={`Open ${title}`}>
            Open
          </Link>
        }
      />
      <CardBody className="space-y-2">
        {configured ? (
          <>
            <dl className="space-y-1">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 text-sm">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="truncate text-right" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {footer}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{unconfiguredNote}</p>
        )}
      </CardBody>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex gap-6">
          <Skeleton className="h-24 w-24 rounded-full" />
          <div className="flex-1 space-y-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-4 w-2/3" />
            ))}
          </div>
        </CardBody>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index}>
            <CardBody className="space-y-2">
              <Skeleton className="h-4 w-24" />
              {Array.from({ length: 4 }, (_, row) => (
                <Skeleton key={row} className="h-3 w-full" />
              ))}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
