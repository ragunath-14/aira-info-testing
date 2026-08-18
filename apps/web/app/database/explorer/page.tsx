'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RelationDetail, RelationSummary, SchemaNode } from '@airaos/types';
import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  FunctionSquare,
  Hash,
  Key,
  Layers,
  Puzzle,
  Table2,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Card, CardBody, CardHeader, EmptyState, Spinner } from '@/components/ui/primitives';
import { ConnectionPicker, useConnections } from '@/features/database/connection-picker';
import { formatBytes, formatNumber } from '@/lib/utils';
import { cn } from '@/lib/utils';

/**
 * Database Explorer (spec sections 18, 19, 25).
 *
 * Three panels: the object tree, the selected relation's structure, and its
 * constraints and relationships. Inspection only — schema editing belongs in
 * reviewed migrations, not in a console, so nothing here can alter a definition.
 */

interface SchemaObjects {
  functions: Array<{ schema: string; name: string; arguments: string; returns: string; kind: string }>;
  sequences: Array<{ schema: string; name: string; lastValue: string | null; increment: string }>;
  extensions: Array<{ name: string; version: string; schema: string }>;
  triggers: Array<{ schema: string; table: string; name: string; timing: string; event: string }>;
}

export default function ExplorerPage() {
  return (
    <PermissionGate permission="database.view">
      <Explorer />
    </PermissionGate>
  );
}

function Explorer() {
  const connections = useConnections();
  const [connectionId, setConnectionId] = useState('');
  const [openSchema, setOpenSchema] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ schema: string; relation: string } | null>(null);
  const [showSystem, setShowSystem] = useState(false);

  const schemas = useQuery({
    queryKey: ['db', 'schemas', connectionId],
    queryFn: () => api.get<{ items: SchemaNode[] }>(`databases/connections/${connectionId}/schemas`),
    enabled: Boolean(connectionId),
  });

  const relations = useQuery({
    queryKey: ['db', 'relations', connectionId, openSchema],
    queryFn: () =>
      api.get<{ items: RelationSummary[] }>(
        `databases/connections/${connectionId}/schemas/${openSchema}/relations`,
      ),
    enabled: Boolean(connectionId && openSchema),
  });

  const objects = useQuery({
    queryKey: ['db', 'objects', connectionId, openSchema],
    queryFn: () =>
      api.get<SchemaObjects>(`databases/connections/${connectionId}/schemas/${openSchema}/objects`),
    enabled: Boolean(connectionId && openSchema),
  });

  const detail = useQuery({
    queryKey: ['db', 'relation', connectionId, selected?.schema, selected?.relation],
    queryFn: () =>
      api.get<RelationDetail>(
        `databases/connections/${connectionId}/schemas/${selected?.schema}/relations/${selected?.relation}`,
      ),
    enabled: Boolean(connectionId && selected),
  });

  const visibleSchemas = (schemas.data?.items ?? []).filter(
    (schema) => showSystem || !schema.isSystem,
  );

  return (
    <PageShell
      title="Database explorer"
      description="Schemas, tables, views and their structure. Inspection only — schema changes go through migrations."
    >
      <div className="mb-3">
        <ConnectionPicker
          connections={connections.data?.items ?? []}
          value={connectionId}
          onChange={(next) => {
            setConnectionId(next);
            setOpenSchema(null);
            setSelected(null);
          }}
        />
      </div>

      {!connectionId ? (
        <EmptyState
          icon={<Database className="h-6 w-6" aria-hidden />}
          title="Select a connection"
          description="Pick a registered database to browse its schemas and tables."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-[18rem_1fr]">
          <Card className="overflow-hidden">
            <CardHeader
              title="Objects"
              actions={
                <label className="flex items-center gap-1 text-2xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showSystem}
                    onChange={(event) => setShowSystem(event.target.checked)}
                    className="h-3 w-3"
                  />
                  system
                </label>
              }
            />
            <CardBody className="max-h-[70vh] overflow-y-auto p-2">
              {schemas.error ? (
                <QueryError error={schemas.error} onRetry={() => void schemas.refetch()} context="Schemas" />
              ) : schemas.isLoading ? (
                <div className="flex justify-center py-6">
                  <Spinner />
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {visibleSchemas.map((schema) => {
                    const isOpen = openSchema === schema.name;
                    return (
                      <li key={schema.name}>
                        <button
                          type="button"
                          onClick={() => setOpenSchema(isOpen ? null : schema.name)}
                          aria-expanded={isOpen}
                          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-accent"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{schema.name}</span>
                          <span className="text-2xs text-muted-foreground">{schema.tableCount}</span>
                        </button>

                        {isOpen ? (
                          <div className="ml-4 border-l border-border pl-2">
                            {relations.isLoading ? (
                              <div className="py-2">
                                <Spinner className="h-3 w-3" />
                              </div>
                            ) : (
                              <ul className="space-y-0.5 py-1">
                                {(relations.data?.items ?? []).map((relation) => {
                                  const active =
                                    selected?.schema === relation.schema &&
                                    selected?.relation === relation.name;
                                  const Icon = relation.kind === 'table' || relation.kind === 'partitioned_table' ? Table2 : Eye;
                                  return (
                                    <li key={`${relation.schema}.${relation.name}`}>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setSelected({ schema: relation.schema, relation: relation.name })
                                        }
                                        className={cn(
                                          'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent',
                                          active && 'bg-primary/10 font-medium text-primary',
                                        )}
                                      >
                                        <Icon className="h-3 w-3 shrink-0" aria-hidden />
                                        <span className="min-w-0 flex-1 truncate">{relation.name}</span>
                                        {relation.estimatedRows !== null ? (
                                          <span className="text-2xs text-muted-foreground">
                                            ~{formatNumber(relation.estimatedRows)}
                                          </span>
                                        ) : null}
                                      </button>
                                    </li>
                                  );
                                })}
                                {(relations.data?.items ?? []).length === 0 ? (
                                  <li className="px-1.5 py-1 text-2xs text-muted-foreground">
                                    No tables or views.
                                  </li>
                                ) : null}
                              </ul>
                            )}

                            {objects.data ? (
                              <div className="space-y-1 border-t border-border py-1.5 text-2xs text-muted-foreground">
                                <p className="flex items-center gap-1">
                                  <FunctionSquare className="h-3 w-3" aria-hidden />
                                  {objects.data.functions.length} function(s)
                                </p>
                                <p className="flex items-center gap-1">
                                  <Hash className="h-3 w-3" aria-hidden />
                                  {objects.data.sequences.length} sequence(s)
                                </p>
                                <p className="flex items-center gap-1">
                                  <Puzzle className="h-3 w-3" aria-hidden />
                                  {objects.data.extensions.length} extension(s)
                                </p>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <div className="space-y-3">
            {!selected ? (
              <EmptyState
                icon={<Table2 className="h-6 w-6" aria-hidden />}
                title="Select a table or view"
                description="Its columns, indexes, constraints and relationships appear here."
              />
            ) : detail.error ? (
              <QueryError error={detail.error} onRetry={() => void detail.refetch()} context="Table structure" />
            ) : detail.isLoading ? (
              <div className="flex justify-center py-12">
                <Spinner />
              </div>
            ) : detail.data ? (
              <>
                <Card>
                  <CardHeader
                    title={`${detail.data.relation.schema}.${detail.data.relation.name}`}
                    description={
                      [
                        detail.data.relation.kind.replace(/_/g, ' '),
                        detail.data.relation.estimatedRows !== null
                          ? `~${formatNumber(detail.data.relation.estimatedRows)} rows (planner estimate)`
                          : null,
                        detail.data.relation.totalSizeBytes !== null
                          ? formatBytes(detail.data.relation.totalSizeBytes)
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    }
                    actions={<Badge tone="outline">{detail.data.columns.length} columns</Badge>}
                  />
                  <CardBody className="p-0">
                    <div className="overflow-x-auto">
                      <table className="data-grid">
                        <thead>
                          <tr>
                            <th>Column</th>
                            <th>Type</th>
                            <th>Nullable</th>
                            <th>Default</th>
                            <th>Keys</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.data.columns.map((column) => (
                            <tr key={column.name}>
                              <td className="mono font-medium">{column.name}</td>
                              <td className="mono text-muted-foreground">{column.dataType}</td>
                              <td>
                                {column.nullable ? (
                                  <span className="text-2xs text-muted-foreground">NULL</span>
                                ) : (
                                  <Badge tone="outline">NOT NULL</Badge>
                                )}
                              </td>
                              <td className="mono max-w-[14rem] truncate text-2xs text-muted-foreground" title={column.defaultValue ?? undefined}>
                                {column.defaultValue ?? '—'}
                              </td>
                              <td>
                                <div className="flex flex-wrap gap-1">
                                  {column.isPrimaryKey ? (
                                    <Badge tone="info">
                                      <Key className="h-2.5 w-2.5" aria-hidden />
                                      PK
                                    </Badge>
                                  ) : null}
                                  {column.isUnique && !column.isPrimaryKey ? (
                                    <Badge tone="outline">UNIQUE</Badge>
                                  ) : null}
                                  {column.foreignKey ? (
                                    <Badge tone="outline" title={`${column.foreignKey.schema}.${column.foreignKey.table}.${column.foreignKey.column}`}>
                                      FK → {column.foreignKey.table}
                                    </Badge>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardBody>
                </Card>

                <div className="grid gap-3 xl:grid-cols-2">
                  <Card>
                    <CardHeader title="Indexes" />
                    <CardBody className="space-y-2 pt-1">
                      {detail.data.indexes.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No indexes.</p>
                      ) : (
                        detail.data.indexes.map((index) => (
                          <div key={index.name} className="rounded border border-border p-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="mono truncate text-xs font-medium">{index.name}</p>
                              <div className="flex gap-1">
                                {index.isPrimary ? <Badge tone="info">primary</Badge> : null}
                                {index.isUnique && !index.isPrimary ? (
                                  <Badge tone="outline">unique</Badge>
                                ) : null}
                                {index.sizeBytes !== null ? (
                                  <span className="text-2xs text-muted-foreground">
                                    {formatBytes(index.sizeBytes)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <p className="mono mt-1 break-all text-2xs text-muted-foreground">
                              {index.definition}
                            </p>
                          </div>
                        ))
                      )}
                    </CardBody>
                  </Card>

                  <Card>
                    <CardHeader title="Constraints" />
                    <CardBody className="space-y-2 pt-1">
                      {detail.data.constraints.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No constraints.</p>
                      ) : (
                        detail.data.constraints.map((constraint) => (
                          <div key={constraint.name} className="rounded border border-border p-2">
                            <div className="flex items-center justify-between gap-2">
                              <p className="mono truncate text-xs font-medium">{constraint.name}</p>
                              <Badge tone="outline">{constraint.type.replace(/_/g, ' ')}</Badge>
                            </div>
                            <p className="mono mt-1 break-all text-2xs text-muted-foreground">
                              {constraint.definition}
                            </p>
                          </div>
                        ))
                      )}
                    </CardBody>
                  </Card>

                  <Card>
                    <CardHeader title="Foreign keys" description="Outbound references." />
                    <CardBody className="pt-1">
                      {detail.data.foreignKeys.length === 0 ? (
                        <p className="text-xs text-muted-foreground">None.</p>
                      ) : (
                        <ul className="space-y-1 text-xs">
                          {detail.data.foreignKeys.map((key) => (
                            <li key={key.name} className="mono">
                              ({key.columns.join(', ')}) → {key.referencedSchema}.{key.referencedTable}(
                              {key.referencedColumns.join(', ')})
                              {key.onDelete ? (
                                <span className="text-muted-foreground"> ON DELETE {key.onDelete}</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardBody>
                  </Card>

                  <Card>
                    <CardHeader
                      title="Referenced by"
                      description="Inbound references — check these before any destructive change."
                    />
                    <CardBody className="pt-1">
                      {detail.data.referencedBy.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Nothing references this table.</p>
                      ) : (
                        <ul className="space-y-1 text-xs">
                          {detail.data.referencedBy.map((reference) => (
                            <li key={reference.constraint} className="mono">
                              {reference.schema}.{reference.table}{' '}
                              <span className="text-muted-foreground">({reference.constraint})</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardBody>
                  </Card>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </PageShell>
  );
}
