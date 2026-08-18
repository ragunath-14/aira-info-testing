'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  BackupState,
  DoFirewall,
  DoSnapshot,
  DoVolume,
  Droplet,
  DropletMetrics,
} from '@airaos/types';
import { Cloud, Power, PowerOff, RefreshCw, Camera, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError, StaleNotice } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { HealthDot, stateFromRunning } from '@/components/shared/status';
import { MetricCard } from '@/components/shared/metric';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useOperation, type OperationTarget } from '@/hooks/use-operation';
import { useSession } from '@/components/layout/session-provider';
import { formatBytes, formatDuration, formatNumber, formatRelative } from '@/lib/utils';

/**
 * DigitalOcean page (spec section 7).
 *
 * Read-only by default. The four power actions appear only when the API says the
 * operator holds the permission for that droplet's environment, and each goes
 * through the confirmation dialog and the audited operations endpoint.
 */

interface DropletsResponse {
  items: Droplet[];
  stale: boolean;
}

interface DropletDetail {
  droplet: Droplet;
  backup: BackupState;
  snapshots: DoSnapshot[];
  volumes: DoVolume[];
  firewalls: DoFirewall[];
  capabilities: Array<{
    key: string;
    label: string;
    description: string;
    allowed: boolean;
    reason: string | null;
    impact: string;
    requiresTypedConfirmation: boolean;
    requiresSecondApproval: boolean;
  }>;
}

export default function DigitalOceanPage() {
  return (
    <PermissionGate permission="digitalocean.view">
      <DigitalOcean />
    </PermissionGate>
  );
}

function DigitalOcean() {
  const [selected, setSelected] = useState<string | null>(null);
  const operation = useOperation();

  const droplets = useQuery({
    queryKey: ['do', 'droplets'],
    queryFn: () => api.get<DropletsResponse>('digitalocean/droplets'),
    refetchInterval: 45_000,
  });

  const columns: Array<Column<Droplet>> = [
    {
      key: 'status',
      header: '',
      width: '2rem',
      value: (row) => row.status,
      render: (row) => <HealthDot state={stateFromRunning(row.status)} />,
    },
    {
      key: 'name',
      header: 'Droplet',
      sortable: true,
      value: (row) => row.name,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="mono truncate text-2xs text-muted-foreground">{row.id}</p>
        </div>
      ),
    },
    {
      key: 'environment',
      header: 'Environment',
      sortable: true,
      value: (row) => row.environment,
      render: (row) => <EnvironmentBadge environment={row.environment} size="sm" />,
    },
    {
      key: 'region',
      header: 'Region',
      sortable: true,
      value: (row) => row.region.slug,
      render: (row) => <span className="text-xs">{row.region.slug}</span>,
    },
    {
      key: 'size',
      header: 'Size',
      sortable: true,
      value: (row) => row.size.vcpus,
      render: (row) => (
        <span className="text-xs">
          {row.size.vcpus} vCPU · {formatBytes(row.size.memoryMb * 1024 * 1024, 0)} ·{' '}
          {row.size.diskGb} GB
        </span>
      ),
    },
    {
      key: 'ip',
      header: 'Public IP',
      value: (row) => row.networks.publicIpv4,
      render: (row) => <span className="mono text-xs">{row.networks.publicIpv4 ?? '—'}</span>,
    },
    {
      key: 'age',
      header: 'Age',
      sortable: true,
      value: (row) => row.ageSeconds,
      render: (row) => (
        <span className="text-xs text-muted-foreground" title={row.createdAt}>
          {formatDuration(row.ageSeconds)}
        </span>
      ),
    },
    {
      key: 'monitoring',
      header: 'Agent',
      value: (row) => (row.monitoringEnabled ? 'yes' : 'no'),
      render: (row) =>
        row.monitoringEnabled ? (
          <Badge tone="success">metrics</Badge>
        ) : (
          <Badge tone="neutral" title="Install the DigitalOcean agent for memory, disk and load">
            no agent
          </Badge>
        ),
    },
  ];

  return (
    <PageShell
      title="DigitalOcean"
      description="Production droplets, storage and firewall configuration. Read-only unless your role permits power actions."
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void droplets.refetch()}
          loading={droplets.isFetching}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </Button>
      }
    >
      {droplets.error ? (
        <QueryError
          error={droplets.error}
          onRetry={() => void droplets.refetch()}
          context="DigitalOcean"
        />
      ) : (
        <div className="space-y-3">
          {droplets.data?.stale ? (
            <StaleNotice cachedAgeMs={0} />
          ) : null}

          <DataTable
            rows={droplets.data?.items ?? []}
            columns={columns}
            rowKey={(row) => row.id}
            loading={droplets.isLoading}
            searchPlaceholder="Search by name, id, IP or tag…"
            onRowClick={(row) => setSelected(row.id)}
            emptyTitle="No droplets visible"
            emptyDescription="Either the account has no droplets, or none are tagged with an environment your role can see."
          />
        </div>
      )}

      {selected ? (
        <DropletDrawer
          dropletId={selected}
          onClose={() => setSelected(null)}
          onOperation={operation.request}
        />
      ) : null}

      <ConfirmDialog
        request={operation.confirmRequest}
        open={operation.open}
        submitting={operation.submitting}
        error={operation.error}
        onCancel={operation.cancel}
        onConfirm={operation.confirm}
      />

      {operation.lastResult ? (
        <div
          className="fixed bottom-4 right-4 z-40 max-w-sm rounded-md border border-border bg-surface-raised p-3 shadow-lg"
          role="status"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm">{operation.lastResult.message}</p>
            <button
              type="button"
              onClick={operation.dismissResult}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <p className="mt-1 text-2xs text-muted-foreground">
            Recorded in the audit trail. Status: {operation.lastResult.status.replace(/_/g, ' ')}.
          </p>
        </div>
      ) : null}
    </PageShell>
  );
}

const ACTION_ICONS: Record<string, typeof Power> = {
  reboot_droplet: RefreshCw,
  power_on_droplet: Power,
  power_off_droplet: PowerOff,
  snapshot_droplet: Camera,
};

function DropletDrawer({
  dropletId,
  onClose,
  onOperation,
}: {
  dropletId: string;
  onClose: () => void;
  onOperation: (target: OperationTarget) => void;
}) {
  const { can } = useSession();

  const detail = useQuery({
    queryKey: ['do', 'droplet', dropletId],
    queryFn: () => api.get<DropletDetail>(`digitalocean/droplets/${dropletId}`),
  });

  const metrics = useQuery({
    queryKey: ['do', 'droplet', dropletId, 'metrics'],
    queryFn: () => api.get<DropletMetrics>(`digitalocean/droplets/${dropletId}/metrics`),
    refetchInterval: 30_000,
  });

  const droplet = detail.data?.droplet;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-xl flex-col border-l border-border bg-surface shadow-xl"
      aria-label="Droplet detail"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 className="truncate text-sm font-semibold">{droplet?.name ?? dropletId}</h2>
            {droplet ? <EnvironmentBadge environment={droplet.environment} size="sm" /> : null}
          </div>
          {droplet ? (
            <p className="mono mt-0.5 text-2xs text-muted-foreground">
              {droplet.id} · {droplet.region.name}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {detail.error ? (
          <QueryError error={detail.error} onRetry={() => void detail.refetch()} context="Droplet detail" />
        ) : null}

        {droplet ? (
          <>
            <Card>
              <CardHeader title="Details" />
              <CardBody className="pt-1">
                <Field label="Status" value={droplet.status} />
                <Field label="Size" value={droplet.size.slug} mono />
                <Field label="vCPU / RAM / Disk" value={`${droplet.size.vcpus} / ${formatBytes(droplet.size.memoryMb * 1024 * 1024, 0)} / ${droplet.size.diskGb} GB`} />
                <Field label="Public IPv4" value={droplet.networks.publicIpv4 ?? '—'} mono />
                <Field label="Private IPv4" value={droplet.networks.privateIpv4 ?? '—'} mono />
                <Field label="IPv6" value={droplet.networks.ipv6 ?? '—'} mono />
                <Field label="Image" value={droplet.image.name ?? '—'} />
                <Field label="Created" value={formatRelative(droplet.createdAt)} title={droplet.createdAt} />
                <Field label="Monitoring agent" value={droplet.monitoringEnabled ? 'installed' : 'not installed'} />
                <Field
                  label="Tags"
                  value={droplet.tags.length > 0 ? droplet.tags.join(', ') : '—'}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Backups"
                description="Reported by DigitalOcean. The console does not assume a backup exists."
              />
              <CardBody className="pt-1">
                <Field
                  label="Enabled"
                  value={detail.data?.backup.enabled ? 'yes' : 'no'}
                />
                <Field label="Status" value={detail.data?.backup.status ?? 'unknown'} />
                <Field
                  label="Last backup"
                  value={
                    detail.data?.backup.lastBackupAt
                      ? formatRelative(detail.data.backup.lastBackupAt)
                      : 'not reported'
                  }
                />
                <Field
                  label="Verified"
                  value={
                    detail.data?.backup.verified ? (
                      <Badge tone="success">a completed backup was found</Badge>
                    ) : (
                      <Badge tone="warning">unverified</Badge>
                    )
                  }
                />
              </CardBody>
            </Card>

            <div className="grid gap-3 sm:grid-cols-2">
              {metrics.data ? (
                <>
                  <MetricCard
                    metric={{
                      key: 'cpu',
                      label: 'CPU',
                      unit: 'percent',
                      value: latest(metrics.data.cpuPercent),
                      series: metrics.data.cpuPercent,
                      warnAbove: 80,
                      criticalAbove: 92,
                      unavailableReason:
                        metrics.data.cpuPercent.length === 0 ? 'No CPU samples returned.' : null,
                    }}
                  />
                  <MetricCard
                    metric={{
                      key: 'memory',
                      label: 'Memory',
                      unit: 'percent',
                      value: latest(metrics.data.memoryPercent),
                      series: metrics.data.memoryPercent,
                      warnAbove: 85,
                      criticalAbove: 94,
                      unavailableReason:
                        metrics.data.memoryPercent === null
                          ? 'Requires the DigitalOcean monitoring agent on the droplet.'
                          : null,
                    }}
                  />
                  <MetricCard
                    metric={{
                      key: 'disk',
                      label: 'Filesystem',
                      unit: 'percent',
                      value: latest(metrics.data.diskPercent),
                      series: metrics.data.diskPercent,
                      warnAbove: 80,
                      criticalAbove: 90,
                      unavailableReason:
                        metrics.data.diskPercent === null
                          ? 'Requires the DigitalOcean monitoring agent on the droplet.'
                          : null,
                    }}
                  />
                  <MetricCard
                    metric={{
                      key: 'net_in',
                      label: 'Network in',
                      unit: 'bytes',
                      value: latest(metrics.data.networkInBytes),
                      series: metrics.data.networkInBytes,
                      warnAbove: null,
                      criticalAbove: null,
                      unavailableReason:
                        metrics.data.networkInBytes.length === 0
                          ? 'No bandwidth samples returned.'
                          : null,
                    }}
                  />
                </>
              ) : null}
            </div>

            {detail.data && detail.data.volumes.length > 0 ? (
              <Card>
                <CardHeader title="Attached volumes" />
                <CardBody className="pt-1">
                  {detail.data.volumes.map((volume) => (
                    <Field
                      key={volume.id}
                      label={volume.name}
                      value={`${volume.sizeGb} GB · ${volume.filesystemType ?? 'raw'}`}
                    />
                  ))}
                </CardBody>
              </Card>
            ) : null}

            {detail.data && detail.data.firewalls.length > 0 ? (
              <Card>
                <CardHeader title="Firewalls" />
                <CardBody className="space-y-3 pt-1">
                  {detail.data.firewalls.map((firewall) => (
                    <div key={firewall.id}>
                      <p className="text-sm font-medium">{firewall.name}</p>
                      <ul className="mt-1 space-y-0.5 text-2xs text-muted-foreground">
                        {firewall.inboundRules.map((rule, index) => (
                          <li key={`in-${index}`} className="mono">
                            in {rule.protocol}/{rule.ports} ← {rule.sources.join(', ') || 'any'}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                title="Snapshots"
                description={`${formatNumber(detail.data?.snapshots.length ?? 0)} snapshot(s)`}
              />
              <CardBody className="pt-1">
                {detail.data?.snapshots.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No snapshots for this droplet.</p>
                ) : (
                  detail.data?.snapshots.slice(0, 10).map((snapshot) => (
                    <Field
                      key={snapshot.id}
                      label={snapshot.name}
                      value={`${snapshot.sizeGb} GB · ${formatRelative(snapshot.createdAt)}`}
                    />
                  ))
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Operations"
                description="Each action is confirmed, executed server-side and recorded."
              />
              <CardBody className="space-y-2">
                {(detail.data?.capabilities ?? []).length === 0 ? (
                  <EmptyState
                    title="No operations available"
                    description="Your role does not permit power actions on droplets in this environment."
                  />
                ) : (
                  (detail.data?.capabilities ?? []).map((capability) => {
                    const Icon = ACTION_ICONS[capability.key] ?? RefreshCw;
                    return (
                      <div
                        key={capability.key}
                        className="flex items-start justify-between gap-3 rounded-md border border-border p-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{capability.label}</p>
                          <p className="text-2xs text-muted-foreground">{capability.description}</p>
                          {!capability.allowed && capability.reason ? (
                            <p className="mt-1 text-2xs text-warning">{capability.reason}</p>
                          ) : null}
                        </div>
                        <Button
                          size="sm"
                          variant={
                            capability.impact === 'service_downtime' ? 'outlineDanger' : 'secondary'
                          }
                          disabled={!capability.allowed}
                          onClick={() =>
                            onOperation({
                              operationKey: capability.key as OperationTarget['operationKey'],
                              resourceId: droplet.id,
                              environment: droplet.environment,
                              resourceLabel: droplet.name,
                              title: capability.label,
                              description: capability.description,
                              impact: capability.impact as OperationTarget['impact'],
                              requiresTypedConfirmation: capability.requiresTypedConfirmation,
                              requiresSecondApproval: capability.requiresSecondApproval,
                              invalidate: [
                                ['do', 'droplets'],
                                ['do', 'droplet', droplet.id],
                                ['dashboard'],
                              ],
                            })
                          }
                        >
                          <Icon className="h-3.5 w-3.5" aria-hidden />
                          Run
                        </Button>
                      </div>
                    );
                  })
                )}
                {!can('digitalocean.reboot') ? (
                  <p className="text-2xs text-muted-foreground">
                    Power actions require the digitalocean.reboot or digitalocean.power permission.
                  </p>
                ) : null}
              </CardBody>
            </Card>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function latest(series: Array<{ t: string; v: number }> | null): number | null {
  if (!series || series.length === 0) return null;
  return series[series.length - 1]?.v ?? null;
}
