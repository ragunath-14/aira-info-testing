'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApplicationStatus } from '@airaos/types';
import { Boxes, RefreshCw, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { HealthBadge, HealthDot } from '@/components/shared/status';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useOperation, type OperationTarget } from '@/hooks/use-operation';
import { formatDuration, formatMs, formatRelative, shortSha } from '@/lib/utils';

/**
 * Services page (spec sections 9, 11).
 *
 * Registry entry, live health, container state and last deployment for each
 * service. Restart controls appear only for services whose registry entry opts
 * into console operations *and* where the operator's role permits it.
 */

interface ServicesResponse {
  items: ApplicationStatus[];
}

interface ApplicationDetail {
  application: ApplicationStatus['application'];
  health: ApplicationStatus['health'];
  container: ApplicationStatus['container'];
  releases: Array<{ version: string; commitSha: string; branch: string; promotedFrom: string | null }>;
  rollbackTarget: { version: string; commitSha: string } | null;
  recentLogs: Array<{ id: string; timestamp: string; level: string; message: string }>;
  deployments: Array<{ id: string; version: string; status: string; finishedAt: string | null }>;
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

export default function ServicesPage() {
  return (
    <PermissionGate permission="application.view">
      <Services />
    </PermissionGate>
  );
}

function Services() {
  const [selected, setSelected] = useState<string | null>(null);
  const operation = useOperation();

  const services = useQuery({
    queryKey: ['applications'],
    queryFn: () => api.get<ServicesResponse>('applications'),
    refetchInterval: 20_000,
  });

  const columns: Array<Column<ApplicationStatus>> = [
    {
      key: 'health',
      header: '',
      width: '2rem',
      value: (row) => row.health.state,
      render: (row) => <HealthDot state={row.health.state} />,
    },
    {
      key: 'name',
      header: 'Service',
      sortable: true,
      value: (row) => row.application.name,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.application.name}</p>
          <p className="mono truncate text-2xs text-muted-foreground">
            {row.application.key} · {row.application.kind}
          </p>
        </div>
      ),
    },
    {
      key: 'environment',
      header: 'Environment',
      sortable: true,
      value: (row) => row.application.environment,
      render: (row) => <EnvironmentBadge environment={row.application.environment} size="sm" />,
    },
    {
      key: 'state',
      header: 'Health',
      sortable: true,
      value: (row) => row.health.state,
      render: (row) => (
        <div className="space-y-0.5">
          <HealthBadge state={row.health.state} />
          {row.health.message ? (
            <p className="max-w-[16rem] truncate text-2xs text-muted-foreground" title={row.health.message}>
              {row.health.message}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'latency',
      header: 'Response',
      sortable: true,
      value: (row) => row.health.responseTimeMs,
      render: (row) => (
        <span className="text-xs">
          {formatMs(row.health.responseTimeMs)}
          {row.health.httpStatus ? (
            <span className="text-muted-foreground"> · {row.health.httpStatus}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'version',
      header: 'Version',
      sortable: true,
      value: (row) => row.application.version,
      render: (row) => (
        <div>
          <p className="text-xs">{row.application.version ?? '—'}</p>
          <p className="mono text-2xs text-muted-foreground">{shortSha(row.application.commitSha)}</p>
        </div>
      ),
    },
    {
      key: 'container',
      header: 'Container',
      value: (row) => row.container?.state ?? null,
      render: (row) =>
        row.container ? (
          <div>
            <Badge tone={row.container.state === 'running' ? 'success' : 'danger'}>
              {row.container.state}
            </Badge>
            <p className="text-2xs text-muted-foreground">
              {row.container.restartCount > 0
                ? `${row.container.restartCount} restart(s)`
                : formatDuration(row.container.uptimeSeconds)}
            </p>
          </div>
        ) : (
          <span className="text-2xs text-muted-foreground">not visible</span>
        ),
    },
    {
      key: 'deployment',
      header: 'Last deploy',
      sortable: true,
      value: (row) => row.lastDeployment?.finishedAt ?? null,
      render: (row) =>
        row.lastDeployment ? (
          <div>
            <p className="text-xs">{row.lastDeployment.status}</p>
            <p className="text-2xs text-muted-foreground">
              {formatRelative(row.lastDeployment.finishedAt ?? row.lastDeployment.startedAt)}
            </p>
          </div>
        ) : (
          <span className="text-2xs text-muted-foreground">none recorded</span>
        ),
    },
  ];

  return (
    <PageShell
      title="Services"
      description="AIRAOS applications, their health endpoints, container state and last deployment."
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void services.refetch()}
          loading={services.isFetching}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </Button>
      }
    >
      {services.error ? (
        <QueryError error={services.error} onRetry={() => void services.refetch()} context="Services" />
      ) : (
        <DataTable
          rows={services.data?.items ?? []}
          columns={columns}
          rowKey={(row) => row.application.id}
          loading={services.isLoading}
          searchPlaceholder="Search services…"
          onRowClick={(row) => setSelected(row.application.id)}
          emptyTitle="No services registered"
          emptyDescription="Add applications to the registry to monitor their health and deployments."
        />
      )}

      {selected ? (
        <ServiceDrawer
          applicationId={selected}
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
    </PageShell>
  );
}

function ServiceDrawer({
  applicationId,
  onClose,
  onOperation,
}: {
  applicationId: string;
  onClose: () => void;
  onOperation: (target: OperationTarget) => void;
}) {
  const detail = useQuery({
    queryKey: ['application', applicationId],
    queryFn: () => api.get<ApplicationDetail>(`applications/${applicationId}`),
    refetchInterval: 20_000,
  });

  const application = detail.data?.application;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-xl flex-col border-l border-border bg-surface shadow-xl"
      aria-label="Service detail"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 className="truncate text-sm font-semibold">{application?.name ?? 'Service'}</h2>
            {application ? <EnvironmentBadge environment={application.environment} size="sm" /> : null}
          </div>
          {application ? (
            <p className="mono mt-0.5 text-2xs text-muted-foreground">
              {application.key} · {application.host ?? 'host unknown'}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {detail.error ? (
          <QueryError error={detail.error} onRetry={() => void detail.refetch()} context="Service detail" />
        ) : null}

        {application && detail.data ? (
          <>
            <Card>
              <CardHeader title="Health" />
              <CardBody className="pt-1">
                <Field label="State" value={<HealthBadge state={detail.data.health.state} />} />
                <Field label="HTTP status" value={detail.data.health.httpStatus ?? '—'} />
                <Field label="Response time" value={formatMs(detail.data.health.responseTimeMs)} />
                <Field label="Endpoint" value={application.healthUrl ?? 'not registered'} mono />
                <Field label="Last success" value={formatRelative(detail.data.health.lastSuccessAt)} />
                <Field label="Last failure" value={formatRelative(detail.data.health.lastFailureAt)} />
                {detail.data.health.message ? (
                  <Field label="Message" value={detail.data.health.message} />
                ) : null}
              </CardBody>
            </Card>

            {detail.data.health.dependencies.length > 0 ? (
              <Card>
                <CardHeader title="Dependencies" description="Reported by the service's own health endpoint." />
                <CardBody className="pt-1">
                  {detail.data.health.dependencies.map((dependency) => (
                    <Field
                      key={dependency.name}
                      label={dependency.name}
                      value={<HealthBadge state={dependency.state} />}
                    />
                  ))}
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader title="Registry" />
              <CardBody className="pt-1">
                <Field label="Repository" value={application.repository ?? '—'} />
                <Field label="Branch" value={application.branch ?? '—'} />
                <Field label="Version" value={application.version ?? '—'} />
                <Field label="Commit" value={shortSha(application.commitSha)} mono />
                <Field label="Port" value={application.port ?? '—'} />
                <Field label="Container" value={application.containerName ?? '—'} mono />
                <Field label="Owner" value={application.ownerTeam ?? '—'} />
                <Field
                  label="Console operations"
                  value={
                    application.operationsEnabled ? (
                      <Badge tone="info">enabled</Badge>
                    ) : (
                      <Badge tone="neutral">disabled</Badge>
                    )
                  }
                />
                <Field
                  label="Depends on"
                  value={application.dependsOn.length > 0 ? application.dependsOn.join(', ') : '—'}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                title="Operations"
                description="Every action is confirmed, executed server-side and audited."
              />
              <CardBody className="space-y-2">
                {detail.data.capabilities.length === 0 ? (
                  <EmptyState
                    title="No operations available"
                    description="Your role does not permit actions on services in this environment."
                  />
                ) : (
                  detail.data.capabilities.map((capability) => (
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
                        disabled={!capability.allowed || !application.operationsEnabled}
                        title={
                          application.operationsEnabled
                            ? undefined
                            : 'This service is not enabled for console operations.'
                        }
                        onClick={() =>
                          onOperation({
                            operationKey: capability.key as OperationTarget['operationKey'],
                            resourceId: application.id,
                            environment: application.environment,
                            resourceLabel: application.name,
                            title: capability.label,
                            description: capability.description,
                            impact: capability.impact as OperationTarget['impact'],
                            requiresTypedConfirmation: capability.requiresTypedConfirmation,
                            requiresSecondApproval: capability.requiresSecondApproval,
                            warnings:
                              application.dependsOn.length > 0
                                ? [`Depends on: ${application.dependsOn.join(', ')}`]
                                : undefined,
                            invalidate: [['applications'], ['application', application.id], ['dashboard']],
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

            <Card>
              <CardHeader title="Recent log lines" description="Redacted before leaving the API." />
              <CardBody className="p-0">
                {detail.data.recentLogs.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">
                    No buffered log lines for this service.
                  </p>
                ) : (
                  <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                    {detail.data.recentLogs.map((entry) => (
                      <li key={entry.id} className="px-3 py-1.5">
                        <span className="mono text-2xs text-muted-foreground">
                          {entry.timestamp.slice(11, 19)}
                        </span>{' '}
                        <span
                          className={
                            entry.level === 'error' || entry.level === 'fatal'
                              ? 'text-destructive'
                              : entry.level === 'warn'
                                ? 'text-warning'
                                : ''
                          }
                        >
                          {entry.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </>
        ) : null}
      </div>
    </aside>
  );
}
