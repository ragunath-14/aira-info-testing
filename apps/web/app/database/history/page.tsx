'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Paginated, QueryHistoryEntry, SqlClassification } from '@airaos/types';
import { FileClock, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Select } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/shared/data-table';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { useConnections } from '@/features/database/connection-picker';
import { formatMs, formatNumber, formatRelative, formatTimestamp } from '@/lib/utils';

/**
 * Query history (spec section 24).
 *
 * Shows a literal-stripped preview rather than the raw statement, so browsing
 * history does not become a way to read customer data out of other people's
 * queries. Full text is retained only for statements that changed something.
 */

const CLASSIFICATION_TONE: Record<SqlClassification, 'success' | 'warning' | 'danger' | 'neutral'> = {
  READ: 'success',
  WRITE: 'warning',
  DDL: 'warning',
  DESTRUCTIVE: 'danger',
  UNKNOWN: 'danger',
};

export default function QueryHistoryPage() {
  return (
    <PermissionGate permission="database.view">
      <History />
    </PermissionGate>
  );
}

function History() {
  const connections = useConnections();
  const [connectionId, setConnectionId] = useState('');
  const [classification, setClassification] = useState('');
  const [page, setPage] = useState(1);

  const history = useQuery({
    queryKey: ['db', 'history', connectionId, classification, page],
    queryFn: () =>
      api.get<Paginated<QueryHistoryEntry>>('databases/history', {
        connectionId: connectionId || undefined,
        classification: classification || undefined,
        page,
        pageSize: 50,
      }),
    refetchInterval: 30_000,
  });

  const columns: Array<Column<QueryHistoryEntry>> = [
    {
      key: 'when',
      header: 'When',
      sortable: true,
      value: (row) => row.executedAt,
      render: (row) => (
        <span className="text-xs text-muted-foreground" title={formatTimestamp(row.executedAt)}>
          {formatRelative(row.executedAt)}
        </span>
      ),
    },
    {
      key: 'user',
      header: 'Operator',
      sortable: true,
      value: (row) => row.userEmail,
      render: (row) => <span className="truncate text-xs">{row.userEmail}</span>,
    },
    {
      key: 'connection',
      header: 'Target',
      sortable: true,
      value: (row) => row.connectionName,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs">{row.connectionName}</span>
          <EnvironmentBadge environment={row.environment} size="sm" />
        </div>
      ),
    },
    {
      key: 'classification',
      header: 'Class',
      sortable: true,
      value: (row) => row.classification,
      render: (row) => (
        <Badge tone={CLASSIFICATION_TONE[row.classification]}>{row.classification}</Badge>
      ),
    },
    {
      key: 'query',
      header: 'Statement (literals removed)',
      value: (row) => row.queryPreview,
      render: (row) => (
        <span className="mono block max-w-[36rem] truncate text-xs" title={row.queryPreview}>
          {row.queryPreview}
        </span>
      ),
    },
    {
      key: 'result',
      header: 'Result',
      sortable: true,
      value: (row) => (row.success ? 1 : 0),
      render: (row) =>
        row.success ? (
          <div className="text-xs">
            <span className="text-success">ok</span>
            <span className="ml-1 text-muted-foreground">
              {row.rowsAffected !== null
                ? `${formatNumber(row.rowsAffected)} affected`
                : `${formatNumber(row.rowsReturned)} rows`}
            </span>
          </div>
        ) : (
          <div className="text-xs">
            <span className="text-destructive">failed</span>
            {row.errorCode ? (
              <span className="mono ml-1 text-muted-foreground">{row.errorCode}</span>
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
  ];

  return (
    <PageShell
      title="Query history"
      description="Every statement the console has run, including refusals. Values are stripped from the stored preview."
    >
      {history.error ? (
        <QueryError error={history.error} onRetry={() => void history.refetch()} context="Query history" />
      ) : (
        <div className="space-y-3">
          <DataTable
            rows={history.data?.items ?? []}
            columns={columns}
            rowKey={(row) => row.id}
            loading={history.isLoading}
            searchPlaceholder="Search operator or statement…"
            emptyTitle="No queries recorded"
            emptyDescription="Statements run through the SQL editor and data browser appear here."
            toolbar={
              <>
                <Select
                  value={connectionId}
                  onChange={(event) => {
                    setConnectionId(event.target.value);
                    setPage(1);
                  }}
                  className="h-8 text-xs"
                  aria-label="Filter by connection"
                >
                  <option value="">All connections</option>
                  {(connections.data?.items ?? []).map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </Select>
                <Select
                  value={classification}
                  onChange={(event) => {
                    setClassification(event.target.value);
                    setPage(1);
                  }}
                  className="h-8 text-xs"
                  aria-label="Filter by classification"
                >
                  <option value="">All classes</option>
                  {(['READ', 'WRITE', 'DDL', 'DESTRUCTIVE', 'UNKNOWN'] as const).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                {history.data?.hasMore ? (
                  <Button size="sm" variant="secondary" onClick={() => setPage((current) => current + 1)}>
                    Load older
                  </Button>
                ) : null}
              </>
            }
          />

          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <ShieldCheck className="h-3 w-3" aria-hidden />
            Previews have string literals and numbers replaced with placeholders. Full statement text is
            kept only for statements that changed data, where an incident review would need it.
          </p>

          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <FileClock className="h-3 w-3" aria-hidden />
            History is append-only: the database grants withhold UPDATE and DELETE on this table.
          </p>
        </div>
      )}
    </PageShell>
  );
}
