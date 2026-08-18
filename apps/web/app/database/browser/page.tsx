'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DataFilterOperator, QueryResult, RelationSummary, SchemaNode } from '@airaos/types';
import { DATA_FILTER_OPERATORS } from '@airaos/types';
import { ChevronLeft, ChevronRight, Download, Filter, RefreshCw, Table2, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, EmptyState, Input, Label, Select } from '@/components/ui/primitives';
import { ConnectionPicker, useConnections } from '@/features/database/connection-picker';
import { useSession } from '@/components/layout/session-provider';
import { formatCell, formatMs, formatNumber } from '@/lib/utils';
import { cn } from '@/lib/utils';

/**
 * Data browser (spec section 20).
 *
 * Read-only by design. Filters are structured — a column, an operator and a
 * value — never a SQL fragment, so the browser cannot express anything the server
 * has not validated against the table's real column list.
 */

interface Filters {
  column: string;
  operator: DataFilterOperator;
  value: string;
}

interface BrowseResponse {
  result: QueryResult;
  total: number | null;
  totalIsEstimate: boolean;
}

const NO_VALUE_OPERATORS: DataFilterOperator[] = ['is_null', 'is_not_null'];

export default function DataBrowserPage() {
  return (
    <PermissionGate permission="database.view">
      <DataBrowser />
    </PermissionGate>
  );
}

function DataBrowser() {
  const { can } = useSession();
  const connections = useConnections();
  const [connectionId, setConnectionId] = useState('');
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [orderBy, setOrderBy] = useState('');
  const [orderDirection, setOrderDirection] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<Filters[]>([]);
  const [draft, setDraft] = useState<Filters>({ column: '', operator: 'eq', value: '' });

  const schemas = useQuery({
    queryKey: ['db', 'schemas', connectionId],
    queryFn: () => api.get<{ items: SchemaNode[] }>(`databases/connections/${connectionId}/schemas`),
    enabled: Boolean(connectionId),
  });

  const relations = useQuery({
    queryKey: ['db', 'relations', connectionId, schema],
    queryFn: () =>
      api.get<{ items: RelationSummary[] }>(
        `databases/connections/${connectionId}/schemas/${schema}/relations`,
      ),
    enabled: Boolean(connectionId && schema),
  });

  const payload = {
    connectionId,
    schema,
    table,
    page,
    pageSize,
    orderBy: orderBy || null,
    orderDirection,
    filters: filters.map((filter) => ({
      column: filter.column,
      operator: filter.operator,
      value: NO_VALUE_OPERATORS.includes(filter.operator) ? null : filter.value,
    })),
    columns: null,
  };

  const data = useQuery({
    queryKey: ['db', 'browse', connectionId, schema, table, page, pageSize, orderBy, orderDirection, filters],
    queryFn: () => api.post<BrowseResponse>(`databases/connections/${connectionId}/browse`, payload),
    enabled: Boolean(connectionId && schema && table),
  });

  const columns = data.data?.result.columns ?? [];
  const total = data.data?.total;
  const totalPages = total !== null && total !== undefined ? Math.max(1, Math.ceil(total / pageSize)) : null;

  return (
    <PageShell
      title="Data browser"
      description="Read-only, paginated table data with structured filters. Rows are capped server-side."
    >
      <Card className="mb-3">
        <CardBody className="space-y-3 py-3">
          <ConnectionPicker
            connections={connections.data?.items ?? []}
            value={connectionId}
            onChange={(next) => {
              setConnectionId(next);
              setSchema('');
              setTable('');
              setFilters([]);
              setPage(1);
            }}
          />

          {connectionId ? (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="browse-schema">Schema</Label>
                <Select
                  id="browse-schema"
                  value={schema}
                  onChange={(event) => {
                    setSchema(event.target.value);
                    setTable('');
                    setFilters([]);
                    setPage(1);
                  }}
                  className="h-8 w-44 text-xs"
                >
                  <option value="">Select…</option>
                  {(schemas.data?.items ?? [])
                    .filter((entry) => !entry.isSystem)
                    .map((entry) => (
                      <option key={entry.name} value={entry.name}>
                        {entry.name}
                      </option>
                    ))}
                </Select>
              </div>

              <div>
                <Label htmlFor="browse-table">Table or view</Label>
                <Select
                  id="browse-table"
                  value={table}
                  onChange={(event) => {
                    setTable(event.target.value);
                    setFilters([]);
                    setOrderBy('');
                    setPage(1);
                  }}
                  className="h-8 w-56 text-xs"
                  disabled={!schema}
                >
                  <option value="">Select…</option>
                  {(relations.data?.items ?? []).map((relation) => (
                    <option key={relation.name} value={relation.name}>
                      {relation.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <Label htmlFor="browse-order">Sort by</Label>
                <Select
                  id="browse-order"
                  value={orderBy}
                  onChange={(event) => {
                    setOrderBy(event.target.value);
                    setPage(1);
                  }}
                  className="h-8 w-44 text-xs"
                  disabled={columns.length === 0}
                >
                  <option value="">Primary key</option>
                  {columns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <Label htmlFor="browse-direction">Direction</Label>
                <Select
                  id="browse-direction"
                  value={orderDirection}
                  onChange={(event) => setOrderDirection(event.target.value as 'asc' | 'desc')}
                  className="h-8 text-xs"
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </Select>
              </div>

              <div>
                <Label htmlFor="browse-size">Rows</Label>
                <Select
                  id="browse-size"
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setPage(1);
                  }}
                  className="h-8 text-xs"
                >
                  {[50, 100, 200, 500].map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </Select>
              </div>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => void data.refetch()}
                loading={data.isFetching}
                disabled={!table}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Refresh
              </Button>

              {can('database.admin') || can('logs.export') ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!table}
                  onClick={() =>
                    void api.downloadPost(
                      `databases/connections/${connectionId}/browse/export`,
                      payload,
                      `${schema}.${table}.csv`,
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Export CSV
                </Button>
              ) : null}
            </div>
          ) : null}

          {table && columns.length > 0 ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="filter-column">Filter column</Label>
                  <Select
                    id="filter-column"
                    value={draft.column}
                    onChange={(event) => setDraft({ ...draft, column: event.target.value })}
                    className="h-8 w-40 text-xs"
                  >
                    <option value="">Select…</option>
                    {columns.map((column) => (
                      <option key={column.name} value={column.name}>
                        {column.name}
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <Label htmlFor="filter-operator">Operator</Label>
                  <Select
                    id="filter-operator"
                    value={draft.operator}
                    onChange={(event) =>
                      setDraft({ ...draft, operator: event.target.value as DataFilterOperator })
                    }
                    className="h-8 text-xs"
                  >
                    {DATA_FILTER_OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {operator.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </Select>
                </div>

                {!NO_VALUE_OPERATORS.includes(draft.operator) ? (
                  <div>
                    <Label htmlFor="filter-value">Value</Label>
                    <Input
                      id="filter-value"
                      value={draft.value}
                      onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                      className="h-8 w-48 text-xs"
                    />
                  </div>
                ) : null}

                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!draft.column}
                  onClick={() => {
                    setFilters((current) => [...current, draft]);
                    setDraft({ column: '', operator: 'eq', value: '' });
                    setPage(1);
                  }}
                >
                  <Filter className="h-3.5 w-3.5" aria-hidden />
                  Add filter
                </Button>
              </div>

              {filters.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {filters.map((filter, index) => (
                    <span
                      key={`${filter.column}-${filter.operator}-${index}`}
                      className="inline-flex items-center gap-1 rounded border border-border bg-surface-sunken px-2 py-0.5 text-2xs"
                    >
                      <span className="mono">{filter.column}</span>
                      <span className="text-muted-foreground">{filter.operator.replace(/_/g, ' ')}</span>
                      {!NO_VALUE_OPERATORS.includes(filter.operator) ? (
                        <span className="mono">{filter.value}</span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setFilters((current) => current.filter((_, position) => position !== index));
                          setPage(1);
                        }}
                        aria-label={`Remove filter on ${filter.column}`}
                        className="rounded hover:bg-accent"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {!connectionId || !table ? (
        <EmptyState
          icon={<Table2 className="h-6 w-6" aria-hidden />}
          title="Select a table"
          description="Choose a connection, schema and table to browse its rows."
        />
      ) : data.error ? (
        <QueryError error={data.error} onRetry={() => void data.refetch()} context="Table data" />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="mono">
                {schema}.{table}
              </span>
              {total !== null && total !== undefined ? (
                <span>
                  {formatNumber(total)} row(s)
                  {data.data?.totalIsEstimate ? (
                    <Badge tone="neutral" className="ml-1" title="Exact counts are avoided on very large tables">
                      estimate
                    </Badge>
                  ) : null}
                </span>
              ) : null}
              {data.data?.result.truncated ? (
                <Badge tone="warning">page full — increase rows or filter</Badge>
              ) : null}
              <span>{formatMs(data.data?.result.durationMs ?? null)}</span>
            </div>

            {totalPages !== null ? (
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => current - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                </Button>
                <span className="text-muted-foreground">
                  {page} / {totalPages}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="max-h-[60vh] overflow-auto">
            <table className="data-grid">
              <thead>
                <tr>
                  <th className="w-12">#</th>
                  {columns.map((column) => (
                    <th key={column.name}>
                      <div className="flex flex-col">
                        <span>{column.name}</span>
                        <span className="font-normal normal-case text-muted-foreground">
                          {column.dataType}
                        </span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(data.data?.result.rows ?? []).map((row, index) => (
                  <tr key={index}>
                    <td className="text-2xs text-muted-foreground">
                      {(page - 1) * pageSize + index + 1}
                    </td>
                    {columns.map((column) => {
                      const cell = formatCell(row[column.name]);
                      return (
                        <td
                          key={column.name}
                          className={cn('mono max-w-[24rem] truncate', cell.isNull && 'text-muted-foreground italic')}
                          title={cell.text}
                        >
                          {cell.text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(data.data?.result.rows ?? []).length === 0 && !data.isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No rows match these filters.
            </p>
          ) : null}
        </Card>
      )}

      <p className="mt-3 text-2xs text-muted-foreground">
        This view is read-only. Every request runs as a SELECT on a read-only session with a statement
        timeout and a row cap.
      </p>
    </PageShell>
  );
}
