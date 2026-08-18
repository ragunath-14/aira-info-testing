'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Connection,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTestResult,
  ConnectionType,
  ResolvedProviderStatus,
} from '@airaos/types';
import { CONNECTION_TYPE_PRESENTATION } from '@airaos/types';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Info,
  Pencil,
  Plug,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, Field } from '@/components/ui/primitives';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { useSession } from '@/components/layout/session-provider';
import {
  ConnectionForm,
  ConnectionTypePicker,
  initialValues,
  toPayload,
  type FormValues,
} from '@/features/connections/connection-form';
import { formatMs, formatRelative } from '@/lib/utils';

/**
 * Settings → Connections (spec sections 3-6, 33).
 *
 * The single place infrastructure integrations are configured. Saving a connection
 * here is all that is required — the dashboards resolve it automatically, with no
 * .env editing and no per-module setup.
 */

interface ConnectionsResponse {
  items: Connection[];
  summary: ConnectionSummary;
  sources: ResolvedProviderStatus[];
}

interface TypeCatalogue {
  items: Array<{
    type: ConnectionType;
    label: string;
    description: string;
    transport: string;
    icon: string;
    credentialOptional: boolean;
  }>;
}

const STATUS_PRESENTATION: Record<
  ConnectionStatus,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; Icon: typeof CheckCircle2 }
> = {
  connected: { label: 'Connected', tone: 'success', Icon: CheckCircle2 },
  degraded: { label: 'Degraded', tone: 'warning', Icon: AlertTriangle },
  offline: { label: 'Offline', tone: 'danger', Icon: XCircle },
  // Never rendered as healthy: an untested connection has proven nothing.
  not_tested: { label: 'Not tested', tone: 'neutral', Icon: CircleHelp },
};

type Dialog =
  | { mode: 'pick' }
  | { mode: 'create'; type: ConnectionType }
  | { mode: 'edit'; connection: Connection }
  | { mode: 'delete'; connection: Connection }
  | null;

export default function ConnectionsPage() {
  return (
    <PermissionGate permission="settings.view">
      <Connections />
    </PermissionGate>
  );
}

function Connections() {
  const { can, environments } = useSession();
  const queryClient = useQueryClient();

  const [dialog, setDialog] = useState<Dialog>(null);
  const [values, setValues] = useState<FormValues>({});
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<ConnectionsResponse>('connections'),
    refetchInterval: 60_000,
  });

  const catalogue = useQuery({
    queryKey: ['connections', 'types'],
    queryFn: () => api.get<TypeCatalogue>('connections/types'),
    staleTime: 300_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['connections'] });
    // A new connection changes what the dashboards can see.
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const closeDialog = () => {
    if (saving || testing) return;
    setDialog(null);
    setValues({});
    setTestResult(null);
    setError(null);
  };

  const startCreate = (type: ConnectionType) => {
    setDialog({ mode: 'create', type });
    setValues(initialValues(type, environments[0] ?? 'development'));
    setTestResult(null);
    setError(null);
  };

  const startEdit = (connection: Connection) => {
    // Secrets are never sent to the browser, so their inputs start blank and are
    // only submitted if the operator types a replacement.
    const base = initialValues(connection.type, connection.environment);
    setDialog({ mode: 'edit', connection });
    setValues({
      ...base,
      ...(connection.configuration as unknown as FormValues),
      name: connection.name,
      environment: connection.environment,
      description: connection.description ?? '',
    });
    setTestResult(null);
    setError(null);
  };

  const activeType =
    dialog?.mode === 'create' ? dialog.type : dialog?.mode === 'edit' ? dialog.connection.type : null;

  const runTest = async () => {
    if (!activeType) return;
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const result = await api.post<ConnectionTestResult>(
        'connections/test',
        toPayload(activeType, values),
      );
      setTestResult(result);
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The test could not be run.');
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!dialog || !activeType) return;
    setSaving(true);
    setError(null);
    try {
      if (dialog.mode === 'create') {
        await api.post('connections', toPayload(activeType, values));
      } else if (dialog.mode === 'edit') {
        await api.patch(`connections/${dialog.connection.id}`, toPayload(activeType, values));
      }
      setDialog(null);
      setValues({});
      setTestResult(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The connection could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const testSaved = async (connection: Connection) => {
    setRowBusy(connection.id);
    try {
      await api.post(`connections/${connection.id}/test`);
      await refresh();
    } finally {
      setRowBusy(null);
    }
  };

  const toggleEnabled = async (connection: Connection) => {
    setRowBusy(connection.id);
    try {
      await api.post(`connections/${connection.id}/enabled`, { isEnabled: !connection.isEnabled });
      await refresh();
    } finally {
      setRowBusy(null);
    }
  };

  const remove = async (connection: Connection) => {
    setSaving(true);
    setError(null);
    try {
      await api.delete(`connections/${connection.id}`);
      setDialog(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The connection could not be removed.');
    } finally {
      setSaving(false);
    }
  };

  const items = connections.data?.items ?? [];
  const summary = connections.data?.summary;
  const sources = connections.data?.sources ?? [];
  const fromEnvironment = sources.filter((source) => source.source === 'environment');

  // Save is gated on a successful test, except when editing without touching
  // anything that would change the connection's behaviour.
  const canSave = testResult?.ok === true;

  return (
    <PageShell
      title="Connections"
      description="Configure every infrastructure integration here. Saved connections are used by the dashboards automatically."
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={connections.isFetching}
            onClick={() => void connections.refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Refresh
          </Button>
          {can('settings.manage') ? (
            <Button variant="primary" size="sm" onClick={() => setDialog({ mode: 'pick' })}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add connection
            </Button>
          ) : null}
        </div>
      }
    >
      {connections.error ? (
        <QueryError
          error={connections.error}
          onRetry={() => void connections.refetch()}
          context="Connections"
        />
      ) : (
        <div className="space-y-4">
          {summary ? (
            <Card>
              <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
                <span className="text-sm font-medium">{summary.total} connection(s)</span>
                {(['connected', 'degraded', 'offline', 'not_tested'] as ConnectionStatus[])
                  .filter((status) => summary.byStatus[status] > 0)
                  .map((status) => {
                    const presentation = STATUS_PRESENTATION[status];
                    return (
                      <Badge key={status} tone={presentation.tone}>
                        <presentation.Icon className="h-3 w-3" aria-hidden />
                        {summary.byStatus[status]} {presentation.label.toLowerCase()}
                      </Badge>
                    );
                  })}
                {summary.missingTypes.length > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Not configured: {summary.missingTypes.map((type) => CONNECTION_TYPE_PRESENTATION[type].label).join(', ')}
                  </span>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          {fromEnvironment.length > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {fromEnvironment.map((source) => CONNECTION_TYPE_PRESENTATION[source.type].label).join(', ')}{' '}
                {fromEnvironment.length === 1 ? 'is' : 'are'} still configured from environment
                variables. That keeps working, but adding a connection here replaces it and makes it
                manageable without editing files or restarting.
              </span>
            </div>
          ) : null}

          {items.length === 0 && !connections.isLoading ? (
            <EmptyState
              icon={<Plug className="h-6 w-6" aria-hidden />}
              title="No connections yet"
              description="Add a connection to let the console reach your infrastructure. Nothing needs to change in a configuration file."
              action={
                can('settings.manage') ? (
                  <Button variant="primary" size="sm" onClick={() => setDialog({ mode: 'pick' })}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add connection
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {items.map((connection) => {
              const presentation = STATUS_PRESENTATION[connection.status];
              const typeInfo = CONNECTION_TYPE_PRESENTATION[connection.type];

              return (
                <Card
                  key={connection.id}
                  className={`env-${connection.environment} border-l-2 ${
                    connection.isEnabled ? '' : 'opacity-60'
                  }`}
                >
                  <CardHeader
                    title={
                      <span className="flex items-center gap-2">
                        {connection.name}
                        <EnvironmentBadge environment={connection.environment} size="sm" />
                      </span>
                    }
                    description={typeInfo.label}
                    actions={
                      <Badge tone={presentation.tone}>
                        <presentation.Icon className="h-3 w-3" aria-hidden />
                        {presentation.label}
                      </Badge>
                    }
                  />
                  <CardBody className="space-y-2 pt-1">
                    <div>
                      {Object.entries(connection.configuration as unknown as Record<string, unknown>)
                        .filter(([, value]) => value !== null && value !== undefined && value !== '')
                        .slice(0, 5)
                        .map(([key, value]) => (
                          <Field
                            key={key}
                            label={key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                            value={String(value)}
                            mono
                          />
                        ))}
                      <Field
                        label="credential"
                        value={
                          connection.hasCredential ? (
                            <Badge tone="success">stored, encrypted</Badge>
                          ) : (
                            <Badge tone="neutral">none</Badge>
                          )
                        }
                      />
                      <Field label="latency" value={formatMs(connection.latencyMs)} />
                      <Field
                        label="last success"
                        value={formatRelative(connection.lastSuccessAt)}
                        title={connection.lastSuccessAt ?? undefined}
                      />
                    </div>

                    {connection.lastError ? (
                      <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-2xs text-destructive">
                        {connection.lastError}
                      </p>
                    ) : null}

                    {connection.description ? (
                      <p className="text-2xs text-muted-foreground">{connection.description}</p>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={rowBusy === connection.id}
                        onClick={() => void testSaved(connection)}
                      >
                        <Plug className="h-3.5 w-3.5" aria-hidden />
                        Test
                      </Button>
                      {can('settings.manage') ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => startEdit(connection)}>
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title={connection.isEnabled ? 'Disable' : 'Enable'}
                            loading={rowBusy === connection.id}
                            onClick={() => void toggleEnabled(connection)}
                          >
                            <Power className="h-3.5 w-3.5" aria-hidden />
                            {connection.isEnabled ? 'Disable' : 'Enable'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => {
                              setDialog({ mode: 'delete', connection });
                              setError(null);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>

          <Card>
            <CardHeader title="How credentials are handled" />
            <CardBody>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  Secrets are encrypted with AES-256-GCM before storage, bound to the connection they
                  belong to, and never returned by any endpoint.
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  The browser never receives a credential. Editing a connection leaves secret fields
                  blank; type a value only to replace it.
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  Every add, edit, test, enable, disable and delete is recorded in the audit trail.
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden />
                  Each system is reached over its own native protocol. There is no SSH access.
                </li>
              </ul>
            </CardBody>
          </Card>
        </div>
      )}

      {dialog ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-4 pt-[8vh] backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog.mode === 'pick'
                ? 'Select a connection type'
                : dialog.mode === 'delete'
                  ? 'Remove connection'
                  : 'Connection details'
            }
            className="w-full max-w-xl rounded-lg border border-border bg-surface-raised shadow-lg"
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">
                  {dialog.mode === 'pick'
                    ? 'Add a connection'
                    : dialog.mode === 'create'
                      ? `New ${CONNECTION_TYPE_PRESENTATION[dialog.type].label} connection`
                      : dialog.mode === 'edit'
                        ? `Edit ${dialog.connection.name}`
                        : `Remove ${dialog.connection.name}`}
                </h2>
                {dialog.mode === 'create' || dialog.mode === 'edit' ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Test the connection before saving.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={closeDialog}
                className="rounded p-1 text-muted-foreground hover:bg-accent"
                aria-label="Close"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            <div className="px-4 py-4">
              {dialog.mode === 'pick' ? (
                <ConnectionTypePicker
                  types={catalogue.data?.items ?? []}
                  onSelect={startCreate}
                />
              ) : dialog.mode === 'delete' ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    Remove this connection from the console? The infrastructure itself is untouched,
                    but any dashboard relying on it will report it as not configured.
                  </p>
                  <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
                    <Field label="Name" value={dialog.connection.name} />
                    <Field
                      label="Type"
                      value={CONNECTION_TYPE_PRESENTATION[dialog.connection.type].label}
                    />
                    <Field
                      label="Environment"
                      value={<EnvironmentBadge environment={dialog.connection.environment} size="sm" />}
                    />
                  </div>
                  {error ? (
                    <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      {error}
                    </p>
                  ) : null}
                </div>
              ) : activeType ? (
                <ConnectionForm
                  type={activeType}
                  values={values}
                  onChange={setValues}
                  testResult={testResult}
                  testing={testing}
                  error={error}
                  editing={dialog.mode === 'edit'}
                />
              ) : null}
            </div>

            {dialog.mode !== 'pick' ? (
              <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
                <Button variant="ghost" onClick={closeDialog} disabled={saving || testing}>
                  Cancel
                </Button>

                {dialog.mode === 'delete' ? (
                  <Button
                    variant="danger"
                    loading={saving}
                    onClick={() => void remove(dialog.connection)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Remove connection
                  </Button>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="secondary" loading={testing} onClick={() => void runTest()}>
                      <Plug className="h-3.5 w-3.5" aria-hidden />
                      Test connection
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!canSave}
                      loading={saving}
                      title={canSave ? undefined : 'Run a successful test first'}
                      onClick={() => void save()}
                    >
                      Save connection
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </PageShell>
  );
}
