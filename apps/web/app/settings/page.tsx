'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Lock, Settings as SettingsIcon, XCircle } from 'lucide-react';
import { api, ApiClientError } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input } from '@/components/ui/primitives';
import { useSession } from '@/components/layout/session-provider';
import { formatRelative } from '@/lib/utils';

/**
 * Settings page (spec section 34).
 *
 * Operational policy only. Secret-bearing variables are reported as configured or
 * not — never echoed — and the two guardrail settings (production read-only,
 * production deployment approval) are shown as fixed, because the API refuses to
 * turn them off.
 */

interface SettingsResponse {
  settings: Array<{
    key: string;
    value: string | number | boolean | null;
    description: string | null;
    updatedByEmail: string | null;
    updatedAt: string;
  }>;
  runtime: {
    environment: string;
    nodeEnv: string;
    appUrl: string;
    auth: {
      ssoConfigured: boolean;
      localAuthEnabled: boolean;
      requireMfa: boolean;
      sessionTtlMinutes: number;
      idleTimeoutMinutes: number;
    };
    providers: Record<string, boolean>;
    urls: Record<string, string | null>;
    limits: Record<string, number>;
    secretsConfigured: Record<string, boolean>;
  };
}

/** Settings the API refuses to change, shown as locked rather than editable. */
const LOCKED_KEYS = new Set([
  'database.production_read_only',
  'deployments.require_production_approval',
]);

export default function SettingsPage() {
  return (
    <PermissionGate permission="settings.view">
      <Settings />
    </PermissionGate>
  );
}

function Settings() {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsResponse>('settings'),
  });

  const save = async (key: string, raw: string) => {
    setSaving(key);
    setError(null);
    try {
      // Numeric settings are sent as numbers so the stored JSON keeps its type.
      const numeric = Number(raw);
      const value = raw.trim() !== '' && Number.isFinite(numeric) ? numeric : raw;
      await api.patch('settings', { key, value });
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'The setting could not be saved.');
    } finally {
      setSaving(null);
    }
  };

  const runtime = settings.data?.runtime;

  return (
    <PageShell
      title="Settings"
      description="Operational policy and a summary of how this console instance is configured."
    >
      {error ? (
        <p
          className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {settings.error ? (
        <QueryError error={settings.error} onRetry={() => void settings.refetch()} context="Settings" />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="Policy"
              description="Cache lifetimes, retention windows and query limits."
            />
            <CardBody className="p-0">
              <div className="divide-y divide-border">
                {(settings.data?.settings ?? []).map((setting) => {
                  const locked = LOCKED_KEYS.has(setting.key);
                  const draft = drafts[setting.key];
                  const currentValue = String(setting.value ?? '');
                  return (
                    <div
                      key={setting.key}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="mono truncate text-xs font-medium">{setting.key}</p>
                          {locked ? (
                            <Badge tone="success" title="This guardrail cannot be disabled">
                              <Lock className="h-2.5 w-2.5" aria-hidden />
                              enforced
                            </Badge>
                          ) : null}
                        </div>
                        {setting.description ? (
                          <p className="text-2xs text-muted-foreground">{setting.description}</p>
                        ) : null}
                        {setting.updatedByEmail ? (
                          <p className="text-2xs text-muted-foreground">
                            Changed by {setting.updatedByEmail} {formatRelative(setting.updatedAt)}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-2">
                        {locked || !can('settings.manage') ? (
                          <span className="mono rounded border border-border bg-surface-sunken px-2 py-1 text-xs">
                            {currentValue}
                          </span>
                        ) : (
                          <>
                            <Input
                              value={draft ?? currentValue}
                              onChange={(event) =>
                                setDrafts((current) => ({ ...current, [setting.key]: event.target.value }))
                              }
                              className="mono h-8 w-28 text-xs"
                              aria-label={`Value for ${setting.key}`}
                            />
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={draft === undefined || draft === currentValue}
                              loading={saving === setting.key}
                              onClick={() => void save(setting.key, draft ?? currentValue)}
                            >
                              Save
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardBody>
          </Card>

          {runtime ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Authentication" />
                <CardBody className="pt-1">
                  <Field
                    label="AIRAOS SSO"
                    value={<ConfiguredBadge on={runtime.auth.ssoConfigured} />}
                  />
                  <Field
                    label="Local development login"
                    value={
                      runtime.auth.localAuthEnabled ? (
                        <Badge tone="warning">enabled</Badge>
                      ) : (
                        <Badge tone="success">disabled</Badge>
                      )
                    }
                  />
                  <Field
                    label="MFA required"
                    value={<ConfiguredBadge on={runtime.auth.requireMfa} />}
                  />
                  <Field label="Session lifetime" value={`${runtime.auth.sessionTtlMinutes} minutes`} />
                  <Field label="Idle timeout" value={`${runtime.auth.idleTimeoutMinutes} minutes`} />
                  <Field label="NODE_ENV" value={runtime.nodeEnv} mono />
                  <Field label="App URL" value={runtime.appUrl} mono />
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Providers" description="What this instance can reach." />
                <CardBody className="pt-1">
                  {Object.entries(runtime.providers).map(([name, on]) => (
                    <Field key={name} label={name} value={<ConfiguredBadge on={on} />} />
                  ))}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Endpoints" description="Non-secret URLs, for reference." />
                <CardBody className="pt-1">
                  {Object.entries(runtime.urls).map(([name, url]) => (
                    <Field key={name} label={name} value={url ?? 'not configured'} mono title={url ?? undefined} />
                  ))}
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  title="Secrets"
                  description="Whether each secret is set. Values are never returned by the API."
                />
                <CardBody className="pt-1">
                  {Object.entries(runtime.secretsConfigured).map(([name, on]) => (
                    <Field
                      key={name}
                      label={name}
                      value={
                        on ? (
                          <Badge tone="success">configured</Badge>
                        ) : (
                          <Badge tone="neutral">not set</Badge>
                        )
                      }
                    />
                  ))}
                </CardBody>
              </Card>

              <Card className="lg:col-span-2">
                <CardHeader title="Query limits" description="Applied to every console-issued query." />
                <CardBody className="grid gap-x-6 pt-1 sm:grid-cols-2">
                  {Object.entries(runtime.limits).map(([name, value]) => (
                    <Field key={name} label={name} value={value} />
                  ))}
                </CardBody>
              </Card>
            </div>
          ) : null}

          <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <SettingsIcon className="h-3 w-3" aria-hidden />
            Credentials are configured through the environment or a secret manager, never through this
            page. The API refuses to store a setting whose key looks like a secret.
          </p>
        </div>
      )}
    </PageShell>
  );
}

function ConfiguredBadge({ on }: { on: boolean }) {
  return on ? (
    <Badge tone="success">
      <CheckCircle2 className="h-2.5 w-2.5" aria-hidden />
      yes
    </Badge>
  ) : (
    <Badge tone="neutral">
      <XCircle className="h-2.5 w-2.5" aria-hidden />
      no
    </Badge>
  );
}
