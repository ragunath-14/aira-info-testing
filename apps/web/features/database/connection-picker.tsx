'use client';

import { useQuery } from '@tanstack/react-query';
import type { DatabaseConnection, WriteModeWindow } from '@airaos/types';
import { Lock, Unlock } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Label, Select } from '@/components/ui/primitives';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { formatRelative } from '@/lib/utils';

/**
 * Shared connection selector for the Explorer, Data Browser and SQL Editor.
 *
 * Always shows the selected connection's environment and read-only state next to
 * the picker. The database pages are the one place where operating on the wrong
 * target is most costly, so the environment is never more than a glance away.
 */

export interface ConnectionRow extends DatabaseConnection {
  readOnly: boolean;
  writeWindow: WriteModeWindow | null;
}

export function useConnections() {
  return useQuery({
    queryKey: ['db', 'connections'],
    queryFn: () => api.get<{ items: ConnectionRow[] }>('databases/connections'),
    refetchInterval: 60_000,
  });
}

export function ConnectionPicker({
  connections,
  value,
  onChange,
  label = 'Connection',
}: {
  connections: ConnectionRow[];
  value: string;
  onChange: (connectionId: string) => void;
  label?: string;
}) {
  const selected = connections.find((connection) => connection.id === value);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <Label htmlFor="connection-picker">{label}</Label>
        <Select
          id="connection-picker"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-64 text-xs"
        >
          <option value="">Select a connection…</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name} — {connection.environment}
            </option>
          ))}
        </Select>
      </div>

      {selected ? (
        <div className="flex items-center gap-2 pb-1">
          <EnvironmentBadge environment={selected.environment} showFullLabel size="sm" />
          {selected.writeWindow ? (
            <span className="flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-2xs font-medium text-destructive">
              <Unlock className="h-3 w-3" aria-hidden />
              Write mode until {formatRelative(selected.writeWindow.expiresAt)}
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-2xs text-muted-foreground">
              <Lock className="h-3 w-3" aria-hidden />
              {selected.readOnly ? 'Read-only' : 'Write window required'}
            </span>
          )}
          <span className="mono text-2xs text-muted-foreground">
            {selected.host}:{selected.port}/{selected.database}
          </span>
        </div>
      ) : null}
    </div>
  );
}
