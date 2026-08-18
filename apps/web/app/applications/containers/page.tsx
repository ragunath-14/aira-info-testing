'use client';

import { useQuery } from '@tanstack/react-query';
import type { ContainerStatus } from '@airaos/types';
import { Container, Info, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { HealthDot, stateFromRunning } from '@/components/shared/status';
import { UsageBar } from '@/components/shared/metric';
import { formatDuration, formatPercent } from '@/lib/utils';

/**
 * Containers page (spec section 11, rule 3).
 *
 * Status only. There is no exec, no shell, and no way to reach a container the
 * console has not been explicitly told about — the allowlist is displayed so
 * that boundary is visible rather than implied.
 */

interface ContainersResponse {
  items: ContainerStatus[];
  configured: boolean;
  note: string | null;
  allowlist: string[];
}

export default function ContainersPage() {
  return (
    <PermissionGate permission="application.view">
      <Containers />
    </PermissionGate>
  );
}

function Containers() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['containers'],
    queryFn: () => api.get<ContainersResponse>('containers'),
    refetchInterval: 15_000,
  });

  const columns: Array<Column<ContainerStatus>> = [
    {
      key: 'state',
      header: '',
      width: '2rem',
      value: (row) => row.state,
      render: (row) => <HealthDot state={stateFromRunning(row.state)} />,
    },
    {
      key: 'name',
      header: 'Container',
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
      key: 'image',
      header: 'Image',
      sortable: true,
      value: (row) => row.image,
      render: (row) => (
        <div className="min-w-0">
          <p className="mono truncate text-xs">{row.image}</p>
          {row.imageTag ? <p className="text-2xs text-muted-foreground">{row.imageTag}</p> : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'State',
      sortable: true,
      value: (row) => row.state,
      render: (row) => (
        <div className="space-y-0.5">
          <Badge tone={row.state === 'running' ? 'success' : 'danger'}>{row.state}</Badge>
          {row.healthStatus !== 'none' ? (
            <Badge tone={row.healthStatus === 'healthy' ? 'success' : 'warning'}>
              {row.healthStatus}
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: 'cpu',
      header: 'CPU',
      sortable: true,
      value: (row) => row.cpuPercent,
      render: (row) => <span className="text-xs">{formatPercent(row.cpuPercent)}</span>,
    },
    {
      key: 'memory',
      header: 'Memory',
      sortable: true,
      value: (row) =>
        row.memoryUsedBytes && row.memoryLimitBytes
          ? (row.memoryUsedBytes / row.memoryLimitBytes) * 100
          : null,
      render: (row) => <UsageBar used={row.memoryUsedBytes} total={row.memoryLimitBytes} />,
    },
    {
      key: 'restarts',
      header: 'Restarts',
      sortable: true,
      value: (row) => row.restartCount,
      render: (row) => (
        <span className={row.restartCount > 3 ? 'text-sm font-medium text-warning' : 'text-sm'}>
          {row.restartCount}
        </span>
      ),
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
    {
      key: 'ports',
      header: 'Ports',
      render: (row) => (
        <span className="mono text-2xs text-muted-foreground">
          {row.ports.length === 0
            ? '—'
            : row.ports
                .map((port) => `${port.host ?? '–'}→${port.container}/${port.protocol}`)
                .join(' ')}
        </span>
      ),
    },
  ];

  return (
    <PageShell
      title="Containers"
      description="Docker containers the console is permitted to observe. Restarts are performed from the service page."
    >
      {error ? (
        <QueryError error={error} onRetry={() => void refetch()} context="Container status" />
      ) : (
        <div className="space-y-4">
          {data && !data.configured ? (
            <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{data.note}</span>
            </div>
          ) : null}

          <DataTable
            rows={data?.items ?? []}
            columns={columns}
            rowKey={(row) => row.name}
            loading={isLoading}
            searchPlaceholder="Search containers…"
            emptyTitle={data?.configured ? 'No allowlisted containers found' : 'Container control is not configured'}
            emptyDescription={
              data?.configured
                ? 'The containers named in DOCKER_ALLOWED_CONTAINERS were not found on this host.'
                : 'Set DOCKER_SOCKET_PATH and DOCKER_ALLOWED_CONTAINERS to enable container status.'
            }
          />

          <Card>
            <CardHeader
              title="Access boundary"
              description="What the console can and cannot do with containers."
            />
            <CardBody className="space-y-3">
              <div>
                <p className="text-xs font-medium">Allowlist</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(data?.allowlist ?? []).length === 0 ? (
                    <span className="text-xs text-muted-foreground">none configured</span>
                  ) : (
                    data?.allowlist.map((name) => (
                      <Badge key={name} tone="outline" className="mono">
                        {name}
                      </Badge>
                    ))
                  )}
                </div>
              </div>

              <ul className="space-y-1 text-xs text-muted-foreground">
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  The Docker socket is read by the API only. It is never proxied to the browser.
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  Only start, stop, restart and log reads are implemented. There is no container exec.
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  Containers outside the allowlist are invisible and cannot be acted on.
                </li>
                <li className="flex items-start gap-1.5">
                  <Container className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  Restart controls live on each service page, where the environment and impact are shown.
                </li>
              </ul>
            </CardBody>
          </Card>
        </div>
      )}
    </PageShell>
  );
}
