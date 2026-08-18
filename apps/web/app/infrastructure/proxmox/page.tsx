'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProxmoxCluster, ProxmoxGuest, ProxmoxNode, ProxmoxStorage } from '@airaos/types';
import { RefreshCw, Server, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { HealthDot, stateFromRunning } from '@/components/shared/status';
import { UsageBar } from '@/components/shared/metric';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useOperation, type OperationTarget } from '@/hooks/use-operation';
import { formatBytes, formatDuration, formatPercent } from '@/lib/utils';

/**
 * Proxmox page (spec section 8).
 *
 * Cluster and node health, then the guest inventory. Lifecycle operations are
 * offered only where the console permits them at all — hard stop, for instance,
 * is unavailable in staging and production regardless of role.
 */

interface Overview {
  cluster: ProxmoxCluster;
  nodes: ProxmoxNode[];
  guests: ProxmoxGuest[];
  stale: boolean;
}

interface GuestDetail {
  guest: ProxmoxGuest;
  snapshots: Array<{ name: string; snaptime?: number; description?: string }>;
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

export default function ProxmoxPage() {
  return (
    <PermissionGate permission="proxmox.view">
      <Proxmox />
    </PermissionGate>
  );
}

function Proxmox() {
  const [selected, setSelected] = useState<number | null>(null);
  const operation = useOperation();

  const overview = useQuery({
    queryKey: ['pve', 'overview'],
    queryFn: () => api.get<Overview>('proxmox/overview'),
    refetchInterval: 30_000,
  });

  const storage = useQuery({
    queryKey: ['pve', 'storage'],
    queryFn: () => api.get<{ items: ProxmoxStorage[] }>('proxmox/storage'),
    refetchInterval: 120_000,
  });

  const columns: Array<Column<ProxmoxGuest>> = [
    {
      key: 'status',
      header: '',
      width: '2rem',
      value: (row) => row.status,
      render: (row) => <HealthDot state={stateFromRunning(row.status)} />,
    },
    {
      key: 'vmid',
      header: 'VMID',
      sortable: true,
      width: '5rem',
      value: (row) => row.vmid,
      render: (row) => <span className="mono text-xs">{row.vmid}</span>,
    },
    {
      key: 'name',
      header: 'Guest',
      sortable: true,
      value: (row) => row.name,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="text-2xs text-muted-foreground">
            {row.type === 'qemu' ? 'VM' : 'container'} on {row.node}
            {row.haManaged ? ' · HA' : ''}
          </p>
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
      key: 'cpu',
      header: 'CPU',
      sortable: true,
      value: (row) => row.cpuPercent,
      render: (row) => (
        <span className="text-xs">
          {formatPercent(row.cpuPercent)}
          {row.cpuCount ? <span className="text-muted-foreground"> / {row.cpuCount}c</span> : null}
        </span>
      ),
    },
    {
      key: 'memory',
      header: 'Memory',
      sortable: true,
      value: (row) =>
        row.memoryUsedBytes && row.memoryTotalBytes
          ? (row.memoryUsedBytes / row.memoryTotalBytes) * 100
          : null,
      render: (row) => <UsageBar used={row.memoryUsedBytes} total={row.memoryTotalBytes} />,
    },
    {
      key: 'disk',
      header: 'Disk',
      sortable: true,
      value: (row) =>
        row.diskUsedBytes && row.diskTotalBytes ? (row.diskUsedBytes / row.diskTotalBytes) * 100 : null,
      render: (row) => <UsageBar used={row.diskUsedBytes} total={row.diskTotalBytes} />,
    },
    {
      key: 'uptime',
      header: 'Uptime',
      sortable: true,
      value: (row) => row.uptimeSeconds,
      render: (row) => (
        <span className="text-xs text-muted-foreground">{formatDuration(row.uptimeSeconds)}</span>
      ),
    },
  ];

  return (
    <PageShell
      title="Proxmox"
      description="Physical infrastructure: cluster health, nodes, virtual machines and containers."
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void overview.refetch()}
          loading={overview.isFetching}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </Button>
      }
    >
      {overview.error ? (
        <QueryError error={overview.error} onRetry={() => void overview.refetch()} context="Proxmox" />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title={overview.data?.cluster.name ?? 'Standalone node'}
              description={
                overview.data
                  ? `${overview.data.cluster.onlineNodeCount}/${overview.data.cluster.nodeCount} node(s) online` +
                    (overview.data.cluster.quorate === null
                      ? ''
                      : overview.data.cluster.quorate
                        ? ' · quorate'
                        : ' · NOT QUORATE')
                  : undefined
              }
              actions={
                overview.data?.cluster.quorate === false ? (
                  <Badge tone="danger">quorum lost</Badge>
                ) : null
              }
            />
            <CardBody className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(overview.data?.nodes ?? []).map((node) => (
                <div key={node.node} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <HealthDot state={node.status === 'online' ? 'healthy' : 'down'} />
                      <p className="text-sm font-medium">{node.node}</p>
                    </div>
                    {node.pveVersion ? (
                      <span className="text-2xs text-muted-foreground">{node.pveVersion}</span>
                    ) : null}
                  </div>
                  <div className="mt-2 space-y-1.5">
                    <UsageBar
                      used={node.memoryUsedBytes}
                      total={node.memoryTotalBytes}
                      label={`RAM ${formatBytes(node.memoryUsedBytes)} / ${formatBytes(node.memoryTotalBytes)}`}
                    />
                    <UsageBar
                      used={node.rootfsUsedBytes}
                      total={node.rootfsTotalBytes}
                      label={`Root ${formatBytes(node.rootfsUsedBytes)} / ${formatBytes(node.rootfsTotalBytes)}`}
                    />
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 text-2xs text-muted-foreground">
                    <div className="flex justify-between">
                      <dt>CPU</dt>
                      <dd>{formatPercent(node.cpuPercent)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Load</dt>
                      <dd>{node.loadAverage?.[0]?.toFixed(2) ?? '—'}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Uptime</dt>
                      <dd>{formatDuration(node.uptimeSeconds)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Guests</dt>
                      <dd>
                        {node.guestCounts.qemuRunning + node.guestCounts.lxcRunning}/
                        {node.guestCounts.qemuTotal + node.guestCounts.lxcTotal}
                      </dd>
                    </div>
                  </dl>
                </div>
              ))}
            </CardBody>
          </Card>

          <DataTable
            rows={overview.data?.guests ?? []}
            columns={columns}
            rowKey={(row) => `${row.node}-${row.vmid}`}
            loading={overview.isLoading}
            searchPlaceholder="Search by name, vmid or tag…"
            onRowClick={(row) => setSelected(row.vmid)}
            emptyTitle="No guests visible"
            emptyDescription="Either the cluster has no guests, or none are tagged with an environment your role can see."
          />

          <Card>
            <CardHeader title="Storage" description="Cluster storage utilisation." />
            <CardBody className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(storage.data?.items ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No storage reported.</p>
              ) : (
                (storage.data?.items ?? []).map((entry) => (
                  <div key={`${entry.node}-${entry.storage}`} className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{entry.storage}</p>
                      <Badge tone={entry.active ? 'success' : 'neutral'}>{entry.type}</Badge>
                    </div>
                    <p className="text-2xs text-muted-foreground">
                      {entry.node} · {entry.content.join(', ') || 'no content types'}
                    </p>
                    <UsageBar
                      className="mt-2"
                      used={entry.usedBytes}
                      total={entry.totalBytes}
                      label={`${formatBytes(entry.usedBytes)} / ${formatBytes(entry.totalBytes)}`}
                    />
                  </div>
                ))
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {selected !== null ? (
        <GuestDrawer vmid={selected} onClose={() => setSelected(null)} onOperation={operation.request} />
      ) : null}

      <ConfirmDialog
        request={operation.confirmRequest}
        open={operation.open}
        submitting={operation.submitting}
        error={operation.error}
        onCancel={operation.cancel}
        onConfirm={operation.confirm}
      />
    </PageShell>
  );
}

function GuestDrawer({
  vmid,
  onClose,
  onOperation,
}: {
  vmid: number;
  onClose: () => void;
  onOperation: (target: OperationTarget) => void;
}) {
  const detail = useQuery({
    queryKey: ['pve', 'guest', vmid],
    queryFn: () => api.get<GuestDetail>(`proxmox/guests/${vmid}`),
  });

  const guest = detail.data?.guest;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-xl flex-col border-l border-border bg-surface shadow-xl"
      aria-label="Guest detail"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 className="truncate text-sm font-semibold">{guest?.name ?? `vmid ${vmid}`}</h2>
            {guest ? <EnvironmentBadge environment={guest.environment} size="sm" /> : null}
          </div>
          {guest ? (
            <p className="mono mt-0.5 text-2xs text-muted-foreground">
              {guest.type} {guest.vmid} · node {guest.node}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {detail.error ? (
          <QueryError error={detail.error} onRetry={() => void detail.refetch()} context="Guest detail" />
        ) : null}

        {guest ? (
          <>
            <Card>
              <CardHeader title="Details" />
              <CardBody className="pt-1">
                <Field label="Status" value={guest.status} />
                <Field label="CPU" value={`${formatPercent(guest.cpuPercent)} of ${guest.cpuCount ?? '?'} core(s)`} />
                <Field
                  label="Memory"
                  value={`${formatBytes(guest.memoryUsedBytes)} / ${formatBytes(guest.memoryTotalBytes)}`}
                />
                <Field
                  label="Disk"
                  value={`${formatBytes(guest.diskUsedBytes)} / ${formatBytes(guest.diskTotalBytes)}`}
                />
                <Field label="Network in / out" value={`${formatBytes(guest.networkInBytes)} / ${formatBytes(guest.networkOutBytes)}`} />
                <Field label="Uptime" value={formatDuration(guest.uptimeSeconds)} />
                <Field
                  label="IP addresses"
                  value={guest.ipAddresses.length > 0 ? guest.ipAddresses.join(', ') : 'not reported'}
                  mono
                />
                <Field label="Tags" value={guest.tags.join(', ') || '—'} />
                <Field label="HA managed" value={guest.haManaged ? 'yes' : 'no'} />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Backup"
                description="Read from the node's vzdump task log. Unverified unless a completed task was found."
              />
              <CardBody className="pt-1">
                <Field label="Status" value={guest.backup.status ?? 'no backup task found'} />
                <Field
                  label="Last backup"
                  value={guest.backup.lastBackupAt ? guest.backup.lastBackupAt : 'not reported'}
                />
                <Field
                  label="Verified"
                  value={
                    guest.backup.verified ? (
                      <Badge tone="success">completed task found</Badge>
                    ) : (
                      <Badge tone="warning">unverified</Badge>
                    )
                  }
                />
                <Field label="Snapshots" value={guest.snapshotCount ?? 0} />
              </CardBody>
            </Card>

            {(detail.data?.snapshots ?? []).length > 0 ? (
              <Card>
                <CardHeader title="Snapshots" />
                <CardBody className="pt-1">
                  {detail.data?.snapshots.map((snapshot) => (
                    <Field
                      key={snapshot.name}
                      label={snapshot.name}
                      value={
                        snapshot.snaptime
                          ? new Date(snapshot.snaptime * 1000).toISOString().slice(0, 19).replace('T', ' ')
                          : snapshot.description ?? '—'
                      }
                    />
                  ))}
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                title="Operations"
                description="Confirmed, executed server-side and recorded in the audit trail."
              />
              <CardBody className="space-y-2">
                {(detail.data?.capabilities ?? []).length === 0 ? (
                  <EmptyState
                    title="No operations available"
                    description="Your role does not permit guest lifecycle actions in this environment."
                  />
                ) : (
                  (detail.data?.capabilities ?? []).map((capability) => (
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
                        variant={capability.impact === 'service_downtime' ? 'outlineDanger' : 'secondary'}
                        disabled={!capability.allowed}
                        onClick={() =>
                          onOperation({
                            operationKey: capability.key as OperationTarget['operationKey'],
                            resourceId: String(guest.vmid),
                            environment: guest.environment,
                            resourceLabel: guest.name,
                            title: capability.label,
                            description: capability.description,
                            impact: capability.impact as OperationTarget['impact'],
                            requiresTypedConfirmation: capability.requiresTypedConfirmation,
                            requiresSecondApproval: capability.requiresSecondApproval,
                            invalidate: [
                              ['pve', 'overview'],
                              ['pve', 'guest', String(guest.vmid)],
                              ['dashboard'],
                            ],
                          })
                        }
                      >
                        Run
                      </Button>
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
          </>
        ) : null}
      </div>
    </aside>
  );
}
