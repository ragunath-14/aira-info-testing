'use client';

import { useState } from 'react';
import type { ConnectionTestResult, ConnectionType, Environment } from '@airaos/types';
import { CONNECTION_TYPE_PRESENTATION } from '@airaos/types';
import { CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import { Input, Label, Select } from '@/components/ui/primitives';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { useSession } from '@/components/layout/session-provider';

/**
 * The Add / Edit Connection form (spec section 6).
 *
 * Fields are declared per type in FIELDS below, so the form renders whatever the
 * selected provider needs without a per-provider component. Secret fields are
 * marked `secret` and are rendered as password inputs; on edit they are left blank
 * and only sent when the operator actually types a new value, so an existing
 * credential is never round-tripped through the browser.
 *
 * Save stays disabled until a Test succeeds, which is the flow the spec asks for:
 * a saved connection that has never connected is a trap for whoever relies on it.
 */

interface FieldDefinition {
  name: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'select' | 'checkbox';
  placeholder?: string;
  help?: string;
  required?: boolean;
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | number | boolean;
}

const FIELDS: Record<ConnectionType, FieldDefinition[]> = {
  digitalocean: [
    {
      name: 'apiToken',
      label: 'API token (read scope)',
      type: 'password',
      required: true,
      secret: true,
      help: 'Used for all monitoring. A read-scoped token is enough.',
    },
    {
      name: 'writeApiToken',
      label: 'Write token (optional)',
      type: 'password',
      secret: true,
      help: 'Only needed for droplet power actions. Without one, they stay disabled.',
    },
    {
      name: 'apiUrl',
      label: 'API URL',
      type: 'text',
      defaultValue: 'https://api.digitalocean.com/v2',
    },
  ],
  proxmox: [
    {
      name: 'apiUrl',
      label: 'API URL',
      type: 'text',
      required: true,
      placeholder: 'https://proxmox.internal:8006/api2/json',
    },
    {
      name: 'tokenId',
      label: 'API token id',
      type: 'text',
      required: true,
      placeholder: 'console@pve!infra',
      help: 'The full user@realm!tokenname, not just the token name.',
    },
    { name: 'tokenSecret', label: 'API token secret', type: 'password', required: true, secret: true },
    {
      name: 'rejectUnauthorized',
      label: 'Verify TLS certificate',
      type: 'checkbox',
      defaultValue: true,
      help: 'Leave on. Turning it off requires a CA certificate path below.',
    },
    {
      name: 'caCertPath',
      label: 'CA certificate path (optional)',
      type: 'text',
      placeholder: '/etc/ssl/certs/proxmox-ca.pem',
      help: "Path on the API host to the cluster's CA, for verified TLS.",
    },
  ],
  postgres: [
    { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.internal' },
    { name: 'port', label: 'Port', type: 'number', defaultValue: 5432 },
    { name: 'database', label: 'Database', type: 'text', required: true, placeholder: 'airaos' },
    {
      name: 'username',
      label: 'Username',
      type: 'text',
      required: true,
      help: 'Use a read-only role. Production is read-only in the console regardless.',
    },
    { name: 'password', label: 'Password', type: 'password', required: true, secret: true },
    {
      name: 'sslMode',
      label: 'SSL mode',
      type: 'select',
      defaultValue: 'require',
      options: [
        { value: 'disable', label: 'disable' },
        { value: 'require', label: 'require' },
        { value: 'verify-ca', label: 'verify-ca' },
        { value: 'verify-full', label: 'verify-full' },
      ],
    },
  ],
  redis: [
    { name: 'host', label: 'Host', type: 'text', required: true, placeholder: 'cache.internal' },
    { name: 'port', label: 'Port', type: 'number', defaultValue: 6379 },
    {
      name: 'password',
      label: 'Password (optional)',
      type: 'password',
      secret: true,
      help: 'Leave blank if the server has no password.',
    },
    { name: 'tls', label: 'Use TLS', type: 'checkbox', defaultValue: false },
    { name: 'db', label: 'Database index', type: 'number', defaultValue: 0 },
  ],
  prometheus: [
    {
      name: 'url',
      label: 'Prometheus URL',
      type: 'text',
      required: true,
      placeholder: 'http://prometheus:9090',
    },
    { name: 'username', label: 'Username (optional)', type: 'text' },
    {
      name: 'password',
      label: 'Password (optional)',
      type: 'password',
      secret: true,
      help: 'Required only if a username is set.',
    },
  ],
  grafana: [
    {
      name: 'url',
      label: 'Grafana URL',
      type: 'text',
      required: true,
      placeholder: 'https://grafana.airaos.example',
    },
    {
      name: 'apiToken',
      label: 'API token (optional)',
      type: 'password',
      secret: true,
      help: 'Deep links work without one. A token only enables API checks.',
    },
    { name: 'organisationId', label: 'Organisation id (optional)', type: 'number' },
  ],
};

export type FormValues = Record<string, string | number | boolean | null>;

export function initialValues(type: ConnectionType, environment: Environment): FormValues {
  const values: FormValues = { name: '', environment, description: '' };
  for (const field of FIELDS[type]) {
    values[field.name] = field.defaultValue ?? (field.type === 'checkbox' ? false : '');
  }
  return values;
}

/** Strips empty strings so optional fields are omitted rather than sent blank. */
export function toPayload(type: ConnectionType, values: FormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type,
    name: String(values.name ?? '').trim(),
    environment: values.environment,
  };

  const description = String(values.description ?? '').trim();
  if (description) payload.description = description;

  for (const field of FIELDS[type]) {
    const value = values[field.name];
    if (field.type === 'checkbox') {
      payload[field.name] = Boolean(value);
      continue;
    }
    if (value === '' || value === null || value === undefined) continue;
    payload[field.name] = field.type === 'number' ? Number(value) : value;
  }

  return payload;
}

export function ConnectionForm({
  type,
  values,
  onChange,
  testResult,
  testing,
  error,
  editing = false,
}: {
  type: ConnectionType;
  values: FormValues;
  onChange: (values: FormValues) => void;
  testResult: ConnectionTestResult | null;
  testing: boolean;
  error: string | null;
  editing?: boolean;
}) {
  const { environments } = useSession();
  const presentation = CONNECTION_TYPE_PRESENTATION[type];
  const set = (name: string, value: string | number | boolean) =>
    onChange({ ...values, [name]: value });

  const environment = values.environment as Environment;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
        <p className="text-sm font-medium">{presentation.label}</p>
        <p className="text-xs text-muted-foreground">{presentation.description}</p>
        <p className="mt-1 text-2xs text-muted-foreground">
          Connects over {presentation.transport}.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="conn-name">Connection name</Label>
          <Input
            id="conn-name"
            value={String(values.name ?? '')}
            onChange={(event) => set('name', event.target.value)}
            placeholder={`${presentation.label} Production`}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="conn-environment">Environment</Label>
          <Select
            id="conn-environment"
            value={String(values.environment ?? '')}
            onChange={(event) => set('environment', event.target.value)}
            // Environment is immutable after creation: it drives the guardrails,
            // and moving a connection between environments would silently change
            // what is permitted against it.
            disabled={editing}
            className="w-full"
          >
            {environments.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          {editing ? (
            <p className="text-2xs text-muted-foreground">
              Environment cannot be changed after creation.
            </p>
          ) : null}
        </div>
      </div>

      {environment === 'production' ? (
        <div className={`env-production tone-surface flex items-start gap-2 rounded-md border px-3 py-2 text-xs`}>
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            This will be a <strong>production</strong> connection.
            {type === 'postgres'
              ? ' It will be read-only by default; writes need an explicit, audited write window.'
              : ' Destructive operations against production remain unavailable.'}
          </span>
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="conn-description">Description (optional)</Label>
        <Input
          id="conn-description"
          value={String(values.description ?? '')}
          onChange={(event) => set('description', event.target.value)}
          placeholder="What this connection is for"
        />
      </div>

      <div className="space-y-3 border-t border-border pt-3">
        {FIELDS[type].map((field) => (
          <div key={field.name} className="space-y-1">
            {field.type === 'checkbox' ? (
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(values[field.name])}
                  onChange={(event) => set(field.name, event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5"
                />
                <span>
                  <span className="text-sm">{field.label}</span>
                  {field.help ? (
                    <span className="block text-2xs text-muted-foreground">{field.help}</span>
                  ) : null}
                </span>
              </label>
            ) : (
              <>
                <Label htmlFor={`conn-${field.name}`}>
                  {field.label}
                  {field.required ? <span className="text-destructive"> *</span> : null}
                </Label>
                {field.type === 'select' ? (
                  <Select
                    id={`conn-${field.name}`}
                    value={String(values[field.name] ?? '')}
                    onChange={(event) => set(field.name, event.target.value)}
                    className="w-full"
                  >
                    {field.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id={`conn-${field.name}`}
                    type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                    value={String(values[field.name] ?? '')}
                    onChange={(event) => set(field.name, event.target.value)}
                    placeholder={
                      editing && field.secret ? 'unchanged — type to replace' : field.placeholder
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                {field.help ? (
                  <p className="text-2xs text-muted-foreground">{field.help}</p>
                ) : null}
              </>
            )}
          </div>
        ))}
      </div>

      {testing ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Testing the connection…
        </div>
      ) : null}

      {testResult ? (
        <div
          className={
            testResult.ok
              ? 'rounded-md border border-success/30 bg-success/10 px-3 py-2'
              : 'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2'
          }
          role="status"
        >
          <p
            className={`flex items-center gap-1.5 text-xs font-medium ${
              testResult.ok ? 'text-success' : 'text-destructive'
            }`}
          >
            {testResult.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <XCircle className="h-3.5 w-3.5" aria-hidden />
            )}
            {testResult.ok ? 'Connection successful' : 'Connection failed'}
          </p>
          <p className="mt-0.5 text-xs">{testResult.message}</p>

          {testResult.details.length > 0 ? (
            <dl className="mt-2 space-y-0.5">
              {testResult.details.map((detail) => (
                <div key={detail.label} className="flex justify-between gap-3 text-2xs">
                  <dt className="text-muted-foreground">{detail.label}</dt>
                  <dd className="mono text-right">{detail.value}</dd>
                </div>
              ))}
              {testResult.latencyMs !== null ? (
                <div className="flex justify-between gap-3 text-2xs">
                  <dt className="text-muted-foreground">Latency</dt>
                  <dd className="mono">{testResult.latencyMs} ms</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <p className="text-2xs text-muted-foreground">
        Credentials are encrypted before they are stored and are never returned by the API. The
        browser never receives them again after you save.
      </p>
    </div>
  );
}

/** Type picker for the first step of the Add flow (spec section 6). */
export function ConnectionTypePicker({
  types,
  onSelect,
}: {
  types: Array<{ type: ConnectionType; label: string; description: string; transport: string }>;
  onSelect: (type: ConnectionType) => void;
}) {
  const [hovered, setHovered] = useState<ConnectionType | null>(null);

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Choose what to connect. Only the fields that provider needs are shown next.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {types.map((entry) => (
          <li key={entry.type}>
            <button
              type="button"
              onClick={() => onSelect(entry.type)}
              onMouseEnter={() => setHovered(entry.type)}
              onMouseLeave={() => setHovered(null)}
              className={`w-full rounded-md border p-3 text-left transition-colors ${
                hovered === entry.type
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-accent'
              }`}
            >
              <p className="text-sm font-medium">{entry.label}</p>
              <p className="mt-0.5 text-2xs text-muted-foreground">{entry.description}</p>
              <p className="mt-1 text-2xs text-muted-foreground">{entry.transport}</p>
            </button>
          </li>
        ))}
      </ul>
      <p className="pt-1 text-2xs text-muted-foreground">
        SSH is deliberately not offered: each system is reached over its own native protocol.
      </p>
    </div>
  );
}

export function EnvironmentTag({ environment }: { environment: Environment }) {
  return <EnvironmentBadge environment={environment} size="sm" />;
}

export { FIELDS as CONNECTION_FIELDS };
