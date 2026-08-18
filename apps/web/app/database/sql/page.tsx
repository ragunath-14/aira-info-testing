'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryResult, SqlClassification, SqlClassificationResult } from '@airaos/types';
import {
  AlertTriangle,
  Download,
  Lock,
  Play,
  ShieldAlert,
  Terminal,
  Unlock,
  X,
} from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, EmptyState, Textarea } from '@/components/ui/primitives';
import { ConnectionPicker, useConnections, type ConnectionRow } from '@/features/database/connection-picker';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useOperation } from '@/hooks/use-operation';
import { useSession } from '@/components/layout/session-provider';
import { formatCell, formatMs, formatNumber } from '@/lib/utils';
import { cn } from '@/lib/utils';

/**
 * SQL editor (spec sections 21-23).
 *
 * Everything dangerous is decided on the server. What this page adds is warning
 * the operator *before* they run something:
 *
 *  - The statement is classified as they type (server-side, debounced) and the
 *    classification is shown with the environment beside it.
 *  - A non-READ statement against a read-only connection explains that a write
 *    window is needed, and offers to open one — through the same confirmation
 *    dialog as any other privileged operation.
 *  - Nothing is executed on Enter. Running requires Ctrl/Cmd+Enter or the button.
 */

const CLASSIFICATION_TONE: Record<SqlClassification, 'success' | 'warning' | 'danger' | 'neutral'> = {
  READ: 'success',
  WRITE: 'warning',
  DDL: 'warning',
  DESTRUCTIVE: 'danger',
  UNKNOWN: 'danger',
};

interface Tab {
  id: string;
  name: string;
  sql: string;
  result: QueryResult | null;
  error: string | null;
  running: boolean;
}

const SAMPLE = 'SELECT *\nFROM information_schema.tables\nWHERE table_schema = \'public\'\nLIMIT 100;';

export default function SqlEditorPage() {
  return (
    <PermissionGate permission="database.query">
      <SqlEditor />
    </PermissionGate>
  );
}

function SqlEditor() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const connections = useConnections();
  const operation = useOperation();

  const [connectionId, setConnectionId] = useState('');
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 'tab-1', name: 'Query 1', sql: SAMPLE, result: null, error: null, running: false },
  ]);
  const [activeTab, setActiveTab] = useState('tab-1');
  const [classification, setClassification] = useState<SqlClassificationResult | null>(null);
  const [explaining, setExplaining] = useState(false);

  const current = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  const connection: ConnectionRow | undefined = connections.data?.items.find(
    (candidate) => candidate.id === connectionId,
  );

  const updateTab = (id: string, patch: Partial<Tab>) => {
    setTabs((existing) => existing.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  };

  /**
   * Classification is a server call so the browser never decides what is safe.
   * Debounced because it fires on every keystroke.
   */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!current?.sql.trim()) {
      setClassification(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      api
        .post<SqlClassificationResult>('databases/classify', { sql: current.sql })
        .then(setClassification)
        .catch(() => setClassification(null));
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [current?.sql]);

  const execute = async (sqlOverride?: string) => {
    if (!current || !connectionId) return;
    const sql = sqlOverride ?? current.sql;
    if (!sql.trim()) return;

    updateTab(current.id, { running: true, error: null });
    try {
      const outcome = await api.post<{ result: QueryResult; classification: SqlClassificationResult }>(
        'databases/execute',
        { connectionId, sql, intent: sqlOverride ? 'explain' : 'read' },
      );
      updateTab(current.id, { result: outcome.result, error: null, running: false });
      setClassification(outcome.classification);
      // A write may have changed what other pages show.
      if (outcome.classification.classification !== 'READ') {
        await queryClient.invalidateQueries({ queryKey: ['db'] });
      }
    } catch (caught) {
      updateTab(current.id, {
        running: false,
        error: caught instanceof ApiClientError ? caught.message : 'The query could not be run.',
        result: null,
      });
    }
  };

  const explain = async () => {
    if (!current) return;
    setExplaining(true);
    try {
      await execute(`EXPLAIN ${current.sql.trim().replace(/;\s*$/, '')}`);
    } finally {
      setExplaining(false);
    }
  };

  const needsWriteWindow =
    classification !== null &&
    classification.classification !== 'READ' &&
    connection !== undefined &&
    !connection.writeWindow;

  return (
    <PageShell
      title="SQL editor"
      description="Statements are classified and authorised server-side. Reads run in a read-only transaction."
    >
      <Card className="mb-3">
        <CardBody className="py-3">
          <ConnectionPicker
            connections={connections.data?.items ?? []}
            value={connectionId}
            onChange={setConnectionId}
          />
        </CardBody>
      </Card>

      {!connectionId ? (
        <EmptyState
          icon={<Terminal className="h-6 w-6" aria-hidden />}
          title="Select a connection"
          description="Pick a registered database before writing a query."
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-1 border-b border-border">
            {tabs.map((tab) => (
              <div key={tab.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'border-b-2 px-3 py-1.5 text-xs',
                    tab.id === activeTab
                      ? 'border-primary font-medium text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.name}
                </button>
                {tabs.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setTabs((existing) => existing.filter((candidate) => candidate.id !== tab.id));
                      if (activeTab === tab.id) {
                        const next = tabs.find((candidate) => candidate.id !== tab.id);
                        if (next) setActiveTab(next.id);
                      }
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent"
                    aria-label={`Close ${tab.name}`}
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                const id = `tab-${Date.now()}`;
                setTabs((existing) => [
                  ...existing,
                  {
                    id,
                    name: `Query ${existing.length + 1}`,
                    sql: '',
                    result: null,
                    error: null,
                    running: false,
                  },
                ]);
                setActiveTab(id);
              }}
              className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              + New
            </button>
          </div>

          {classification ? (
            <div
              className={cn(
                'flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs',
                classification.classification === 'READ'
                  ? 'border-border bg-surface-sunken'
                  : classification.classification === 'DESTRUCTIVE' || classification.classification === 'UNKNOWN'
                    ? 'border-destructive/40 bg-destructive/10'
                    : 'border-warning/40 bg-warning/10',
              )}
              role={classification.classification === 'READ' ? 'status' : 'alert'}
            >
              <Badge tone={CLASSIFICATION_TONE[classification.classification]}>
                {classification.classification}
              </Badge>

              {classification.statements.length > 1 ? (
                <span>{classification.statements.length} statements — the strictest applies</span>
              ) : null}

              {classification.notes.map((note) => (
                <span key={note} className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                  {note}
                </span>
              ))}

              {classification.classification === 'UNKNOWN' ? (
                <span className="font-medium">
                  This will be refused: the console only runs statements it recognises as permitted.
                </span>
              ) : null}
            </div>
          ) : null}

          {needsWriteWindow ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
              role="alert"
            >
              <div className="flex items-start gap-2 text-xs text-destructive">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  <strong>{connection?.name}</strong> is read-only. A{' '}
                  {classification?.classification} statement needs an open write window, and every
                  statement run inside it is logged with your identity.
                  {connection?.environment === 'production'
                    ? ' Production schema changes are refused regardless — use a reviewed migration.'
                    : ''}
                </span>
              </div>
              {can('database.write') && connection ? (
                <Button
                  size="sm"
                  variant="outlineDanger"
                  onClick={() =>
                    operation.request({
                      operationKey: 'activate_database_write_mode',
                      resourceId: connection.id,
                      environment: connection.environment,
                      resourceLabel: connection.name,
                      title: 'Activate write mode',
                      description:
                        'Opens a time-limited window in which data-changing statements are permitted on this connection.',
                      impact: 'data_changing',
                      requiresTypedConfirmation: true,
                      requiresSecondApproval: false,
                      confirmLabel: 'Open write window',
                      metadata: { minutes: 15 },
                      invalidate: [['db', 'connections'], ['session']],
                    })
                  }
                >
                  <Unlock className="h-3.5 w-3.5" aria-hidden />
                  Open write window
                </Button>
              ) : (
                <span className="text-2xs text-destructive">
                  Requires the database.write permission.
                </span>
              )}
            </div>
          ) : null}

          <Card>
            <CardBody className="space-y-2 p-3">
              <Textarea
                value={current?.sql ?? ''}
                onChange={(event) => current && updateTab(current.id, { sql: event.target.value })}
                onKeyDown={(event) => {
                  // Deliberately not plain Enter: a newline must never execute.
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void execute();
                  }
                }}
                rows={10}
                spellCheck={false}
                className="mono resize-y"
                placeholder="SELECT * FROM customers LIMIT 100;"
                aria-label="SQL statement"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant={
                      classification && classification.classification !== 'READ' ? 'danger' : 'primary'
                    }
                    size="sm"
                    loading={current?.running}
                    disabled={!current?.sql.trim()}
                    onClick={() => void execute()}
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden />
                    Run
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={explaining}
                    disabled={!current?.sql.trim()}
                    onClick={() => void explain()}
                    title="Runs EXPLAIN without ANALYZE, so nothing is executed"
                  >
                    Explain
                  </Button>
                  {current?.result && current.result.rows.length > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => downloadCsv(current.result!, `query-${current.id}.csv`)}
                    >
                      <Download className="h-3.5 w-3.5" aria-hidden />
                      CSV
                    </Button>
                  ) : null}
                </div>

                <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                  <Lock className="h-3 w-3" aria-hidden />
                  Ctrl/Cmd + Enter to run. Results are capped and the statement has a timeout.
                </span>
              </div>
            </CardBody>
          </Card>

          {current?.error ? (
            <QueryError error={new ApiClientError('QUERY_REJECTED', current.error, 400)} context="This query" />
          ) : null}

          {current?.result ? <ResultPanel result={current.result} /> : null}
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

function ResultPanel({ result }: { result: QueryResult }) {
  if (result.plan) {
    return (
      <Card>
        <CardBody className="p-0">
          <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            Query plan · {formatMs(result.durationMs)}
          </div>
          <pre className="mono overflow-x-auto whitespace-pre px-3 py-2 text-xs">
            {result.plan.join('\n')}
          </pre>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <Badge tone={CLASSIFICATION_TONE[result.classification]}>{result.classification}</Badge>
        <span>{formatNumber(result.rowCount)} row(s) returned</span>
        {result.rowsAffected !== null ? (
          <span className="font-medium text-foreground">
            {formatNumber(result.rowsAffected)} row(s) affected
          </span>
        ) : null}
        <span>{formatMs(result.durationMs)}</span>
        {result.truncated ? (
          <Badge tone="warning">truncated at the row cap — add a LIMIT or narrow the query</Badge>
        ) : null}
      </div>

      {result.rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {result.rowsAffected !== null
            ? 'Statement completed. No rows were returned.'
            : 'No rows matched.'}
        </p>
      ) : (
        <div className="max-h-[45vh] overflow-auto">
          <table className="data-grid">
            <thead>
              <tr>
                <th className="w-12">#</th>
                {result.columns.map((column) => (
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
              {result.rows.map((row, index) => (
                <tr key={index}>
                  <td className="text-2xs text-muted-foreground">{index + 1}</td>
                  {result.columns.map((column) => {
                    const cell = formatCell(row[column.name]);
                    return (
                      <td
                        key={column.name}
                        className={cn('mono max-w-[24rem] truncate', cell.isNull && 'italic text-muted-foreground')}
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
      )}
    </Card>
  );
}

/**
 * Client-side CSV of the result already on screen. Leading formula characters are
 * escaped so opening the file in a spreadsheet cannot execute anything.
 */
function downloadCsv(result: QueryResult, filename: string): void {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  };

  const header = result.columns.map((column) => escape(column.name)).join(',');
  const lines = result.rows.map((row) =>
    result.columns.map((column) => escape(row[column.name])).join(','),
  );

  const blob = new Blob([[header, ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
