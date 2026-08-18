'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuditEvent, AuditResult, Paginated } from '@airaos/types';
import { FileText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, Input, Select } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { formatRelative, formatTimestamp } from '@/lib/utils';

/**
 * Audit log (spec section 30).
 *
 * Append-only and hash-chained. The verify action recomputes the chain and reports
 * the first record whose hash does not match, which is how a deleted or edited row
 * becomes visible rather than silently disappearing.
 */

const RESULT_TONE: Record<AuditResult, 'success' | 'danger' | 'warning'> = {
  success: 'success',
  failure: 'danger',
  denied: 'warning',
};

export default function AuditPage() {
  return (
    <PermissionGate permission="audit.view">
      <Audit />
    </PermissionGate>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [verification, setVerification] = useState<{
    verified: boolean;
    checkedCount: number;
    firstBrokenSequence: number | null;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const actions = useQuery({
    queryKey: ['audit', 'actions'],
    queryFn: () => api.get<{ items: string[] }>('audit/actions'),
    staleTime: 300_000,
  });

  const events = useQuery({
    queryKey: ['audit', action, result, search, page],
    queryFn: () =>
      api.get<Paginated<AuditEvent>>('audit', {
        action: action || undefined,
        result: result || undefined,
        search: search || undefined,
        page,
        pageSize: 100,
      }),
    refetchInterval: 60_000,
  });

  const verify = async () => {
    setVerifying(true);
    try {
      setVerification(
        await api.get<{ verified: boolean; checkedCount: number; firstBrokenSequence: number | null }>(
          'audit/verify',
        ),
      );
    } finally {
      setVerifying(false);
    }
  };

  const columns: Array<Column<AuditEvent>> = [
    {
      key: 'sequence',
      header: '#',
      sortable: true,
      width: '5rem',
      value: (row) => row.sequence,
      render: (row) => <span className="mono text-2xs text-muted-foreground">{row.sequence}</span>,
    },
    {
      key: 'when',
      header: 'When',
      sortable: true,
      value: (row) => row.occurredAt,
      render: (row) => (
        <span className="text-xs text-muted-foreground" title={formatTimestamp(row.occurredAt)}>
          {formatRelative(row.occurredAt)}
        </span>
      ),
    },
    {
      key: 'user',
      header: 'Operator',
      sortable: true,
      value: (row) => row.userEmail,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs">{row.userEmail}</p>
          <p className="truncate text-2xs text-muted-foreground">{row.userRoles.join(', ')}</p>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      sortable: true,
      value: (row) => row.action,
      render: (row) => <span className="mono text-xs">{row.action}</span>,
    },
    {
      key: 'resource',
      header: 'Resource',
      sortable: true,
      value: (row) => row.resourceLabel ?? row.resourceId,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs">{row.resourceLabel ?? row.resourceId ?? '—'}</p>
          <p className="text-2xs text-muted-foreground">{row.resourceKind}</p>
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
          <span className="text-2xs text-muted-foreground">—</span>
        ),
    },
    {
      key: 'result',
      header: 'Result',
      sortable: true,
      value: (row) => row.result,
      render: (row) => <Badge tone={RESULT_TONE[row.result]}>{row.result}</Badge>,
    },
    {
      key: 'message',
      header: 'Detail',
      value: (row) => row.message,
      render: (row) => (
        <div className="min-w-0">
          <p className="max-w-[26rem] truncate text-xs" title={row.message ?? undefined}>
            {row.message ?? '—'}
          </p>
          <p className="mono truncate text-2xs text-muted-foreground">
            {row.ipAddress ?? 'no ip'} · req {row.requestId.slice(0, 8)}
          </p>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="Audit logs"
      description="Every privileged action, including denials. Append-only and hash-chained."
      actions={
        <Button variant="secondary" size="sm" loading={verifying} onClick={() => void verify()}>
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Verify chain
        </Button>
      }
    >
      {verification ? (
        <div
          className={
            verification.verified
              ? 'mb-3 flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success'
              : 'mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'
          }
          role="status"
        >
          {verification.verified ? (
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span>
            {verification.verified
              ? `Chain intact across the last ${verification.checkedCount} record(s). No record has been altered or removed.`
              : `Chain verification failed at sequence ${verification.firstBrokenSequence}. A record was altered or removed — treat this as a security incident and preserve the database.`}
          </span>
        </div>
      ) : null}

      {events.error ? (
        <QueryError error={events.error} onRetry={() => void events.refetch()} context="Audit trail" />
      ) : (
        <div className="space-y-3">
          <DataTable
            rows={events.data?.items ?? []}
            columns={columns}
            rowKey={(row) => row.id}
            loading={events.isLoading}
            searchable={false}
            dense
            emptyTitle="No audit events"
            emptyDescription="Privileged actions appear here as they happen."
            toolbar={
              <>
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  placeholder="Search operator, resource or message…"
                  className="h-8 w-56 text-xs"
                  aria-label="Search audit events"
                />
                <Select
                  value={action}
                  onChange={(event) => {
                    setAction(event.target.value);
                    setPage(1);
                  }}
                  className="h-8 text-xs"
                  aria-label="Filter by action"
                >
                  <option value="">All actions</option>
                  {(actions.data?.items ?? []).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <Select
                  value={result}
                  onChange={(event) => {
                    setResult(event.target.value);
                    setPage(1);
                  }}
                  className="h-8 text-xs"
                  aria-label="Filter by result"
                >
                  <option value="">All results</option>
                  <option value="success">Success</option>
                  <option value="failure">Failure</option>
                  <option value="denied">Denied</option>
                </Select>
                {events.data?.hasMore ? (
                  <Button size="sm" variant="secondary" onClick={() => setPage((current) => current + 1)}>
                    Load older
                  </Button>
                ) : null}
              </>
            }
          />

          <Card>
            <CardBody className="space-y-1.5 py-3 text-2xs text-muted-foreground">
              <p className="flex items-start gap-1.5">
                <FileText className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                Each record stores an HMAC over its own content plus the previous record's hash. Editing
                or deleting a row breaks the chain, which the verify action detects.
              </p>
              <p className="flex items-start gap-1.5">
                <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                The application database role holds only INSERT and SELECT on this table, and triggers
                reject UPDATE and DELETE outright.
              </p>
              <p className="flex items-start gap-1.5">
                <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                Metadata is passed through secret redaction before it is stored, so no credential can
                land here.
              </p>
            </CardBody>
          </Card>
        </div>
      )}
    </PageShell>
  );
}
