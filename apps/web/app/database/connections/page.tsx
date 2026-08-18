'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DatabaseConnection, DatabaseConnectionStatus, WriteModeWindow } from '@airaos/types';
import { Database, Lock, PlugZap, ShieldCheck, Unlock } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, CardHeader, Field } from '@/components/ui/primitives';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { HealthBadge } from '@/components/shared/status';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useOperation } from '@/hooks/use-operation';
import { useSession } from '@/components/layout/session-provider';
import { formatBytes, formatMs, formatNumber, formatRelative } from '@/lib/utils';

/**
 * Database connections (spec section 17).
 *
 * Credentials are never part of any response, so nothing on this page can leak
 * one. The read-only state and any open write window are shown per connection,
 * because "am I about to write to production?" must be answerable at a glance.
 */

interface ConnectionRow extends DatabaseConnection {
  readOnly: boolean;
  writeWindow: WriteModeWindow | null;
}

export default function ConnectionsPage() {
  return (
    <PermissionGate permission="database.view">
      <Connections />
    </PermissionGate>
  );
}

function Connections() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const operation = useOperation();
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const connections = useQuery({
    queryKey: ['db', 'connections'],
    queryFn: () => api.get<{ items: ConnectionRow[] }>('databases/connections'),
    refetchInterval: 60_000,
  });

  const test = async (connection: ConnectionRow) => {
    setTesting(connection.id);
    try {
      const result = await api.post<{ ok: boolean; latencyMs: number; message: string | null }>(
        `databases/connections/${connection.id}/test`,
      );
      setTestResult((current) => ({
        ...current,
        [connection.id]: result.ok
          ? `Connected in ${formatMs(result.latencyMs)}`
          : (result.message ?? 'Connection failed'),
      }));
    } catch (caught) {
      setTestResult((current) => ({
        ...current,
        [connection.id]:
          caught instanceof ApiClientError ? caught.message : 'The test could not be run.',
      }));
    } finally {
      setTesting(null);
    }
  };

  const closeWriteWindow = async (connection: ConnectionRow) => {
    await api.delete(`databases/write-windows/${connection.id}`);
    await queryClient.invalidateQueries({ queryKey: ['db', 'connections'] });
    await queryClient.invalidateQueries({ queryKey: ['session'] });
  };

  return (
    <PageShell
      title="Database connections"
      description="Registered PostgreSQL targets. The browser never connects to a database directly — every query goes through the API."
    >
      {connections.error ? (
        <QueryError
          error={connections.error}
          onRetry={() => void connections.refetch()}
          context="Database connections"
        />
      ) : (
        <div className="space-y-4">
          {(connections.data?.items ?? []).length === 0 ? (
            <Card>
              <CardBody className="py-10 text-center">
                <Database className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
                <p className="mt-2 text-sm font-medium">No database connections registered</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  A database admin can register one. Credentials are encrypted at rest and never
                  returned by the API.
                </p>
              </CardBody>
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {(connections.data?.items ?? []).map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                testing={testing === connection.id}
                testResult={testResult[connection.id]}
                onTest={() => void test(connection)}
                onCloseWriteWindow={() => void closeWriteWindow(connection)}
                onActivateWriteMode={() =>
                  operation.request({
                    operationKey: 'activate_database_write_mode',
                    resourceId: connection.id,
                    environment: connection.environment,
                    resourceLabel: connection.name,
                    title: 'Activate write mode',
                    description:
                      'Opens a time-limited window in which data-changing statements are permitted on this connection. Every statement is logged with your identity.',
                    impact: 'data_changing',
                    requiresTypedConfirmation: true,
                    requiresSecondApproval: false,
                    warnings:
                      connection.environment === 'production'
                        ? [
                            'This is a production database. Prefer a reviewed migration over an ad-hoc statement.',
                            'Schema changes (CREATE, ALTER, DROP) remain blocked in production even with write mode open.',
                          ]
                        : undefined,
                    confirmLabel: 'Open write window',
                    metadata: { minutes: 15 },
                    invalidate: [
                      ['db', 'connections'],
                      ['session'],
                    ],
                  })
                }
                canWrite={can('database.write')}
              />
            ))}
          </div>

          <Card>
            <CardHeader title="How access works" description="The policy the backend enforces." />
            <CardBody>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  Production connections are read-only by default. Only SELECT and EXPLAIN run without
                  a write window.
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  A write window is per connection, per operator, and expires on its own.
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  Production schema changes are refused entirely. Use a reviewed migration.
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  Read sessions run inside a read-only transaction, so a misclassified write would be
                  refused by PostgreSQL itself.
                </li>
              </ul>
            </CardBody>
          </Card>
        </div>
      )}

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

function ConnectionCard({
  connection,
  testing,
  testResult,
  onTest,
  onActivateWriteMode,
  onCloseWriteWindow,
  canWrite,
}: {
  connection: ConnectionRow;
  testing: boolean;
  testResult?: string;
  onTest: () => void;
  onActivateWriteMode: () => void;
  onCloseWriteWindow: () => void;
  canWrite: boolean;
}) {
  const status = useQuery({
    queryKey: ['db', 'status', connection.id],
    queryFn: () =>
      api.get<DatabaseConnectionStatus>(`databases/connections/${connection.id}/status`),
    refetchInterval: 60_000,
  });

  return (
    <Card className={`env-${connection.environment} border-l-2`}>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {connection.name}
            <EnvironmentBadge environment={connection.environment} size="sm" />
          </span>
        }
        description={`${connection.host}:${connection.port}/${connection.database}`}
        actions={
          status.data ? <HealthBadge state={status.data.state} /> : null
        }
      />
      <CardBody className="space-y-3 pt-1">
        <div>
          <Field label="User" value={connection.username} mono />
          <Field label="TLS" value={connection.sslMode} />
          <Field label="Provider" value={connection.provider.replace(/_/g, ' ')} />
          <Field label="Server" value={status.data?.serverVersion ?? '—'} />
          <Field
            label="Size"
            value={
              status.data?.databaseSizeBytes === null || status.data?.databaseSizeBytes === undefined
                ? '—'
                : formatBytes(status.data.databaseSizeBytes)
            }
          />
          <Field
            label="Connections"
            value={
              status.data
                ? `${formatNumber(status.data.activeConnections)} / ${formatNumber(status.data.maxConnections)}`
                : '—'
            }
          />
          <Field
            label="Cache hit ratio"
            value={status.data?.cacheHitRatio !== null && status.data?.cacheHitRatio !== undefined ? `${status.data.cacheHitRatio}%` : '—'}
          />
          <Field
            label="Slow queries"
            value={
              status.data?.slowQueryCount === null
                ? 'pg_stat_statements not installed'
                : formatNumber(status.data?.slowQueryCount)
            }
          />
          <Field label="Role" value={status.data?.replicationRole ?? '—'} />
          <Field
            label="Backup"
            value={
              status.data?.backup.verified ? (
                <Badge tone="success">verified {formatRelative(status.data.backup.lastBackupAt)}</Badge>
              ) : (
                <Badge tone="warning" title={status.data?.backup.status ?? undefined}>
                  unverified
                </Badge>
              )
            }
          />
        </div>

        {status.data?.message ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-2xs text-destructive">
            {status.data.message}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            {connection.writeWindow ? (
              <>
                <Unlock className="h-3.5 w-3.5 text-destructive" aria-hidden />
                <span className="text-xs font-medium text-destructive">
                  Write mode open — expires {formatRelative(connection.writeWindow.expiresAt)}
                </span>
              </>
            ) : (
              <>
                <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <span className="text-xs text-muted-foreground">
                  {connection.readOnly ? 'Read-only' : 'Writes allowed with a window'}
                </span>
              </>
            )}
          </div>

          {connection.writeWindow ? (
            <Button size="sm" variant="outlineDanger" onClick={onCloseWriteWindow}>
              Close now
            </Button>
          ) : canWrite ? (
            <Button size="sm" variant="secondary" onClick={onActivateWriteMode}>
              Open write window
            </Button>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="secondary" onClick={onTest} loading={testing}>
            <PlugZap className="h-3.5 w-3.5" aria-hidden />
            Test connection
          </Button>
          {testResult ? (
            <span className="truncate text-2xs text-muted-foreground" title={testResult}>
              {testResult}
            </span>
          ) : null}
        </div>

        {connection.description ? (
          <p className="text-2xs text-muted-foreground">{connection.description}</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
