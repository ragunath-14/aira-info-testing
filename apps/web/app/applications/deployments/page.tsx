'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeploymentSummary, Paginated } from '@airaos/types';
import { CheckCircle2, GitCommit, Rocket, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, CardHeader, Textarea } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { useSession } from '@/components/layout/session-provider';
import { formatMs, formatRelative, shortSha } from '@/lib/utils';

/**
 * Deployments page (spec section 10).
 *
 * The console records deployments and gates production behind a second approver;
 * CI does the actual rollout. Nothing here can run arbitrary code — a deployment
 * names a version and a commit that CI has already built.
 */

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  succeeded: 'success',
  running: 'info',
  pending: 'info',
  awaiting_approval: 'warning',
  failed: 'danger',
  rolled_back: 'warning',
  cancelled: 'neutral',
};

export default function DeploymentsPage() {
  return (
    <PermissionGate permission="application.view">
      <Deployments />
    </PermissionGate>
  );
}

function Deployments() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [decisionFor, setDecisionFor] = useState<DeploymentSummary | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deployments = useQuery({
    queryKey: ['deployments', page],
    queryFn: () => api.get<Paginated<DeploymentSummary>>('deployments', { page, pageSize: 50 }),
    refetchInterval: 20_000,
  });

  const awaiting = (deployments.data?.items ?? []).filter(
    (deployment) => deployment.status === 'awaiting_approval',
  );

  const decide = async (deployment: DeploymentSummary, approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`deployments/${deployment.id}/approval`, { approve, note: note || undefined });
      setDecisionFor(null);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['deployments'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The decision could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const columns: Array<Column<DeploymentSummary>> = [
    {
      key: 'application',
      header: 'Application',
      sortable: true,
      value: (row) => row.applicationKey,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.applicationKey}</p>
          <p className="text-2xs text-muted-foreground">{row.branch ?? 'unknown branch'}</p>
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
      key: 'version',
      header: 'Release',
      sortable: true,
      value: (row) => row.version,
      render: (row) => (
        <div>
          <p className="text-sm">{row.version}</p>
          <p className="mono flex items-center gap-1 text-2xs text-muted-foreground">
            <GitCommit className="h-3 w-3" aria-hidden />
            {shortSha(row.commitSha)}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      value: (row) => row.status,
      render: (row) => (
        <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status.replace(/_/g, ' ')}</Badge>
      ),
    },
    {
      key: 'who',
      header: 'Triggered by',
      sortable: true,
      value: (row) => row.triggeredByEmail,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs">{row.triggeredByEmail}</p>
          {row.approvedByEmail ? (
            <p className="truncate text-2xs text-muted-foreground">
              approved by {row.approvedByEmail}
            </p>
          ) : row.environment === 'production' ? (
            <p className="text-2xs text-warning">awaiting a second approver</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      sortable: true,
      value: (row) => row.durationMs,
      render: (row) => <span className="text-xs">{formatMs(row.durationMs)}</span>,
    },
    {
      key: 'when',
      header: 'When',
      sortable: true,
      value: (row) => row.finishedAt ?? row.startedAt,
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {formatRelative(row.finishedAt ?? row.startedAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (row) =>
        row.status === 'awaiting_approval' && can('application.deploy.production') ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setDecisionFor(row);
              setNote('');
              setError(null);
            }}
          >
            Review
          </Button>
        ) : row.ciRunUrl ? (
          <a
            href={row.ciRunUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-primary hover:underline"
          >
            CI run
          </a>
        ) : null,
    },
  ];

  return (
    <PageShell
      title="Deployments"
      description="A record of what was deployed, by whom, and who approved it. Rollouts are executed by CI."
    >
      {deployments.error ? (
        <QueryError
          error={deployments.error}
          onRetry={() => void deployments.refetch()}
          context="Deployment history"
        />
      ) : (
        <div className="space-y-4">
          {awaiting.length > 0 ? (
            <Card className="border-warning/40">
              <CardHeader
                title={`${awaiting.length} deployment(s) awaiting production approval`}
                description="A production deployment must be approved by someone other than the operator who requested it."
              />
              <CardBody className="space-y-2">
                {awaiting.map((deployment) => (
                  <div
                    key={deployment.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Rocket className="h-4 w-4 text-muted-foreground" aria-hidden />
                        <p className="text-sm font-medium">
                          {deployment.applicationKey} → {deployment.version}
                        </p>
                        <EnvironmentBadge environment={deployment.environment} size="sm" />
                      </div>
                      <p className="mt-0.5 text-2xs text-muted-foreground">
                        Requested by {deployment.triggeredByEmail} · commit{' '}
                        <span className="mono">{shortSha(deployment.commitSha)}</span>
                        {deployment.message ? ` · ${deployment.message}` : ''}
                      </p>
                    </div>
                    {can('application.deploy.production') ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setDecisionFor(deployment);
                          setNote('');
                          setError(null);
                        }}
                      >
                        Review
                      </Button>
                    ) : (
                      <span className="text-2xs text-muted-foreground">
                        Requires application.deploy.production
                      </span>
                    )}
                  </div>
                ))}
              </CardBody>
            </Card>
          ) : null}

          <DataTable
            rows={deployments.data?.items ?? []}
            columns={columns}
            rowKey={(row) => row.id}
            loading={deployments.isLoading}
            searchPlaceholder="Search by application, version or operator…"
            emptyTitle="No deployments recorded"
            emptyDescription="Deployments triggered through the console or reported by CI appear here."
            toolbar={
              deployments.data && deployments.data.hasMore ? (
                <Button size="sm" variant="secondary" onClick={() => setPage((current) => current + 1)}>
                  Load older
                </Button>
              ) : null
            }
          />
        </div>
      )}

      {decisionFor ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 p-4 pt-[12vh] backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setDecisionFor(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Review production deployment"
            className="w-full max-w-lg rounded-lg border border-border bg-surface-raised shadow-lg"
          >
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Review production deployment</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Approving records your identity against this release and allows it to proceed.
              </p>
            </div>

            <div className="space-y-3 px-4 py-4">
              <EnvironmentBadge environment={decisionFor.environment} showFullLabel />

              <dl className="space-y-1 rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">Application</dt>
                  <dd>{decisionFor.applicationKey}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">Version</dt>
                  <dd>{decisionFor.version}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">Commit</dt>
                  <dd className="mono">{decisionFor.commitSha}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">Requested by</dt>
                  <dd>{decisionFor.triggeredByEmail}</dd>
                </div>
              </dl>

              <div className="space-y-1">
                <label htmlFor="approval-note" className="text-xs font-medium text-muted-foreground">
                  Note (recorded in the audit trail)
                </label>
                <Textarea
                  id="approval-note"
                  rows={2}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="e.g. Verified in staging, change window agreed with support"
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
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
              <Button variant="ghost" onClick={() => setDecisionFor(null)} disabled={busy}>
                Cancel
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outlineDanger"
                  loading={busy}
                  onClick={() => void decide(decisionFor, false)}
                >
                  <ThumbsDown className="h-3.5 w-3.5" aria-hidden />
                  Reject
                </Button>
                <Button variant="primary" loading={busy} onClick={() => void decide(decisionFor, true)}>
                  <ThumbsUp className="h-3.5 w-3.5" aria-hidden />
                  Approve
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <p className="mt-4 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        The console never runs arbitrary commands or scripts as part of a deployment. It records the
        release and hands it to CI.
      </p>
    </PageShell>
  );
}
