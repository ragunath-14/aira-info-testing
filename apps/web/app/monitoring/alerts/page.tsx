'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Alert, AlertSeverity } from '@airaos/types';
import { AlertTriangle, BellRing, CheckCheck, ExternalLink, Info } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, Input, Label, Select, Textarea } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { useSession } from '@/components/layout/session-provider';
import { formatRelative } from '@/lib/utils';

/**
 * Alerts page (spec section 15).
 *
 * Alertmanager decides what is firing; the console records who owns it.
 * Acknowledging is explicitly not silencing — the copy says so, because an
 * operator who thinks "ack" hides the alert from the team will be surprised
 * later.
 */

interface AlertsResponse {
  items: Alert[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  configured: boolean;
  counts: { critical: number; warning: number; info: number; unacknowledged: number };
}

const SEVERITY_TONE: Record<AlertSeverity, 'danger' | 'warning' | 'info'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

export default function AlertsPage() {
  return (
    <PermissionGate permission="alerts.view">
      <Alerts />
    </PermissionGate>
  );
}

function Alerts() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [severity, setSeverity] = useState('');
  const [acknowledged, setAcknowledged] = useState('');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{ alert: Alert; mode: 'ack' | 'resolve' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alerts = useQuery({
    queryKey: ['alerts', severity, acknowledged, search],
    queryFn: () =>
      api.get<AlertsResponse>('alerts', {
        severity: severity || undefined,
        acknowledged: acknowledged || undefined,
        search: search || undefined,
        pageSize: 200,
      }),
    refetchInterval: 20_000,
  });

  const submit = async () => {
    if (!dialog) return;
    setBusy(true);
    setError(null);
    try {
      if (dialog.mode === 'ack') {
        await api.post('alerts/acknowledge', {
          fingerprint: dialog.alert.fingerprint,
          note: note || undefined,
        });
      } else {
        await api.post('alerts/resolve', {
          fingerprint: dialog.alert.fingerprint,
          resolutionDetail: note,
        });
      }
      setDialog(null);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['alerts'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<Alert>> = [
    {
      key: 'severity',
      header: 'Severity',
      sortable: true,
      width: '6rem',
      value: (row) => ({ critical: 0, warning: 1, info: 2 })[row.severity],
      render: (row) => <Badge tone={SEVERITY_TONE[row.severity]}>{row.severity}</Badge>,
    },
    {
      key: 'name',
      header: 'Alert',
      sortable: true,
      value: (row) => row.name,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.name}</p>
          <p className="truncate text-2xs text-muted-foreground" title={row.summary}>
            {row.summary}
          </p>
        </div>
      ),
    },
    {
      key: 'environment',
      header: 'Environment',
      sortable: true,
      value: (row) => row.environment,
      render: (row) =>
        row.environment ? (
          <EnvironmentBadge environment={row.environment} size="sm" />
        ) : (
          <Badge tone="neutral" title="This alert has no environment label">
            unlabelled
          </Badge>
        ),
    },
    {
      key: 'resource',
      header: 'Resource',
      sortable: true,
      value: (row) => row.resource,
      render: (row) => <span className="mono text-xs">{row.resource ?? '—'}</span>,
    },
    {
      key: 'since',
      header: 'Firing for',
      sortable: true,
      value: (row) => row.startsAt,
      render: (row) => (
        <span className="text-xs text-muted-foreground" title={row.startsAt}>
          {formatRelative(row.startsAt)}
        </span>
      ),
    },
    {
      key: 'ack',
      header: 'Ownership',
      sortable: true,
      value: (row) => (row.acknowledgement ? 1 : 0),
      render: (row) =>
        row.acknowledgement ? (
          <div className="min-w-0">
            <Badge tone="info">acknowledged</Badge>
            <p className="truncate text-2xs text-muted-foreground">
              {row.acknowledgement.acknowledgedByEmail} ·{' '}
              {formatRelative(row.acknowledgement.acknowledgedAt)}
            </p>
            {row.acknowledgement.resolvedAt ? (
              <p className="text-2xs text-success">resolved</p>
            ) : null}
          </div>
        ) : (
          <Badge tone="warning">unowned</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <div className="flex items-center gap-1">
          {row.runbookUrl ? (
            <a
              href={row.runbookUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Runbook
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : null}
          {can('alerts.manage') ? (
            row.acknowledgement && !row.acknowledgement.resolvedAt ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDialog({ alert: row, mode: 'resolve' });
                  setNote('');
                  setError(null);
                }}
              >
                Resolve
              </Button>
            ) : !row.acknowledgement ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDialog({ alert: row, mode: 'ack' });
                  setNote('');
                  setError(null);
                }}
              >
                Acknowledge
              </Button>
            ) : null
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="Alerts"
      description="Firing alerts from Alertmanager, with console-side ownership and resolution notes."
      actions={
        alerts.data ? (
          <div className="flex items-center gap-2 text-xs">
            <Badge tone="danger">{alerts.data.counts.critical} critical</Badge>
            <Badge tone="warning">{alerts.data.counts.warning} warning</Badge>
            <Badge tone="info">{alerts.data.counts.info} info</Badge>
            <Badge tone="neutral">{alerts.data.counts.unacknowledged} unowned</Badge>
          </div>
        ) : null
      }
    >
      {alerts.error ? (
        <QueryError error={alerts.error} onRetry={() => void alerts.refetch()} context="Alertmanager" />
      ) : (
        <div className="space-y-3">
          {alerts.data && !alerts.data.configured ? (
            <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Alertmanager is not configured. Set ALERTMANAGER_URL — without it the console cannot
                tell you whether anything is firing, so this page stays empty rather than implying all
                is well.
              </span>
            </div>
          ) : null}

          <DataTable
            rows={alerts.data?.items ?? []}
            columns={columns}
            rowKey={(row) => row.fingerprint}
            loading={alerts.isLoading}
            searchable={false}
            emptyTitle={alerts.data?.configured ? 'Nothing is firing' : 'Alertmanager not configured'}
            emptyDescription={
              alerts.data?.configured
                ? 'No alerts match the current filters.'
                : 'Configure Alertmanager to see alerts here.'
            }
            toolbar={
              <>
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search alerts…"
                  className="h-8 w-48 text-xs"
                  aria-label="Search alerts"
                />
                <Select
                  value={severity}
                  onChange={(event) => setSeverity(event.target.value)}
                  className="h-8 text-xs"
                  aria-label="Filter by severity"
                >
                  <option value="">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </Select>
                <Select
                  value={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.value)}
                  className="h-8 text-xs"
                  aria-label="Filter by ownership"
                >
                  <option value="">Any ownership</option>
                  <option value="false">Unowned</option>
                  <option value="true">Acknowledged</option>
                </Select>
              </>
            }
          />
        </div>
      )}

      {dialog ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 p-4 pt-[14vh] backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setDialog(null);
          }}
        >
          <Card className="w-full max-w-lg">
            <CardBody className="space-y-3">
              <div className="flex items-start gap-2">
                {dialog.mode === 'ack' ? (
                  <BellRing className="mt-0.5 h-4 w-4 text-warning" aria-hidden />
                ) : (
                  <CheckCheck className="mt-0.5 h-4 w-4 text-success" aria-hidden />
                )}
                <div>
                  <h2 className="text-sm font-semibold">
                    {dialog.mode === 'ack' ? 'Acknowledge alert' : 'Record resolution'}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {dialog.mode === 'ack'
                      ? 'This records that you own the alert. It does not silence it, and the underlying condition is unchanged.'
                      : 'Describe what fixed it. The note is kept with the alert history.'}
                  </p>
                </div>
              </div>

              <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  <p className="text-sm font-medium">{dialog.alert.name}</p>
                  {dialog.alert.environment ? (
                    <EnvironmentBadge environment={dialog.alert.environment} size="sm" />
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{dialog.alert.summary}</p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="alert-note">
                  {dialog.mode === 'ack' ? 'Note (optional)' : 'Resolution detail (required)'}
                </Label>
                <Textarea
                  id="alert-note"
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={
                    dialog.mode === 'ack'
                      ? 'e.g. Investigating, tracked in INC-1042'
                      : 'e.g. Restarted the worker; queue drained and the alert cleared'
                  }
                />
              </div>

              {error ? (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={dialog.mode === 'resolve' && note.trim().length === 0}
                  onClick={() => void submit()}
                >
                  {dialog.mode === 'ack' ? 'Acknowledge' : 'Record resolution'}
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      ) : null}
    </PageShell>
  );
}
