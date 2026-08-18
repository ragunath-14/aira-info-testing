'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Environment, LogEntry, LogLevel } from '@airaos/types';
import { Download, Pause, Play, ScrollText, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api-client';
import { PageShell, PermissionGate, QueryError } from '@/components/layout/page-shell';
import { Badge, Button, Card, CardBody, Input, Label, Select } from '@/components/ui/primitives';
import { EnvironmentBadge } from '@/components/shared/environment-badge';
import { useSession } from '@/components/layout/session-provider';
import { cn } from '@/lib/utils';

/**
 * Logs page (spec section 12).
 *
 * Search, filter and live tail over the console's log buffer. Every line has
 * already passed redaction on both ingest and read, so secrets do not reach this
 * view even if a service logged one.
 */

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

const LEVEL_CLASS: Record<LogLevel, string> = {
  trace: 'text-muted-foreground',
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-warning',
  error: 'text-destructive',
  fatal: 'text-destructive font-semibold',
};

interface SourcesResponse {
  items: Array<{ source: string; kind: string; environment: Environment; count: number }>;
}

interface SearchResponse {
  items: LogEntry[];
  nextCursor: string | null;
}

export default function LogsPage() {
  return (
    <PermissionGate permission="logs.view">
      <Logs />
    </PermissionGate>
  );
}

function Logs() {
  const { can, environments } = useSession();
  const [source, setSource] = useState('');
  const [environment, setEnvironment] = useState<Environment | ''>('');
  const [level, setLevel] = useState<LogLevel | ''>('');
  const [search, setSearch] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [tailing, setTailing] = useState(false);
  const [tailLines, setTailLines] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sources = useQuery({
    queryKey: ['logs', 'sources'],
    queryFn: () => api.get<SourcesResponse>('logs/sources'),
    staleTime: 60_000,
  });

  const logs = useQuery({
    queryKey: ['logs', source, environment, level, search, errorsOnly],
    queryFn: () =>
      api.get<SearchResponse>('logs', {
        sources: source || undefined,
        environments: environment || undefined,
        levels: level || undefined,
        search: search || undefined,
        errorsOnly: errorsOnly || undefined,
        limit: 300,
      }),
    // Polling is paused while the live tail is running so the two do not fight.
    refetchInterval: tailing ? false : 15_000,
    enabled: !tailing,
  });

  /**
   * Live tail over Server-Sent Events. Requires a source and an environment
   * because the API streams one source at a time.
   */
  useEffect(() => {
    if (!tailing || !source || !environment) return;

    const params = new URLSearchParams({ source, environment });
    if (level) params.set('levels', level);

    const stream = new EventSource(`/api/proxy/logs/tail?${params.toString()}`);

    stream.addEventListener('lines', (event) => {
      const incoming = JSON.parse((event as MessageEvent<string>).data) as LogEntry[];
      setTailLines((current) => [...current, ...incoming].slice(-1000));
    });
    stream.addEventListener('error', () => {
      // The browser reconnects on its own; surface nothing unless it stays down.
    });

    return () => stream.close();
  }, [tailing, source, environment, level]);

  // Keep the newest line in view while tailing.
  useEffect(() => {
    if (tailing && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [tailLines, tailing]);

  const entries = tailing ? tailLines : (logs.data?.items ?? []);
  const ordered = tailing ? entries : [...entries].reverse();

  return (
    <PageShell
      title="Logs"
      description="Application, container, infrastructure and deployment logs. Secrets are redacted before they reach this page."
      actions={
        <div className="flex items-center gap-2">
          {can('logs.export') ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void api.download(
                  'logs/export',
                  {
                    sources: source || undefined,
                    environments: environment || undefined,
                    levels: level || undefined,
                    search: search || undefined,
                    errorsOnly: errorsOnly || undefined,
                    limit: 1000,
                  },
                  'airaos-console-logs.txt',
                )
              }
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              Export
            </Button>
          ) : null}
          <Button
            variant={tailing ? 'danger' : 'primary'}
            size="sm"
            disabled={!source || !environment}
            title={
              !source || !environment
                ? 'Pick a single source and environment to tail'
                : undefined
            }
            onClick={() => {
              setTailLines([]);
              setTailing((current) => !current);
            }}
          >
            {tailing ? (
              <>
                <Pause className="h-3.5 w-3.5" aria-hidden />
                Stop tail
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" aria-hidden />
                Live tail
              </>
            )}
          </Button>
        </div>
      }
    >
      <Card className="mb-3">
        <CardBody className="flex flex-wrap items-end gap-3 py-3">
          <div>
            <Label htmlFor="log-source">Source</Label>
            <Select
              id="log-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="h-8 w-52 text-xs"
            >
              <option value="">All sources</option>
              {(sources.data?.items ?? []).map((entry) => (
                <option key={`${entry.source}-${entry.environment}`} value={entry.source}>
                  {entry.source} ({entry.kind})
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="log-environment">Environment</Label>
            <Select
              id="log-environment"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value as Environment | '')}
              className="h-8 text-xs"
            >
              <option value="">All environments</option>
              {environments.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="log-level">Minimum level</Label>
            <Select
              id="log-level"
              value={level}
              onChange={(event) => setLevel(event.target.value as LogLevel | '')}
              className="h-8 text-xs"
              disabled={errorsOnly}
            >
              <option value="">Any level</option>
              {LEVELS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>

          <div className="min-w-[14rem] flex-1">
            <Label htmlFor="log-search">Search</Label>
            <Input
              id="log-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Message contains…"
              className="h-8 text-xs"
            />
          </div>

          <label className="flex items-center gap-1.5 pb-1.5 text-xs">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(event) => setErrorsOnly(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            Errors only
          </label>
        </CardBody>
      </Card>

      {logs.error && !tailing ? (
        <QueryError error={logs.error} onRetry={() => void logs.refetch()} context="Logs" />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ScrollText className="h-3.5 w-3.5" aria-hidden />
              {ordered.length} line(s)
              {tailing ? <Badge tone="danger">live</Badge> : null}
              {environment ? <EnvironmentBadge environment={environment} size="sm" /> : null}
            </div>
            {source ? <span className="mono text-2xs text-muted-foreground">{source}</span> : null}
          </div>

          <div ref={scrollRef} className="max-h-[60vh] overflow-y-auto bg-surface-sunken">
            {ordered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                {tailing
                  ? 'Waiting for new lines…'
                  : 'No log lines match these filters in the retention window.'}
              </p>
            ) : (
              <ul className="divide-y divide-border/50">
                {ordered.map((entry) => (
                  <li key={entry.id} className="flex gap-3 px-3 py-1 font-mono text-xs">
                    <span className="shrink-0 text-muted-foreground">
                      {entry.timestamp.slice(11, 23)}
                    </span>
                    <span className={cn('w-12 shrink-0 uppercase', LEVEL_CLASS[entry.level])}>
                      {entry.level}
                    </span>
                    <span className="w-28 shrink-0 truncate text-muted-foreground" title={entry.source}>
                      {entry.source}
                    </span>
                    <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', LEVEL_CLASS[entry.level])}>
                      {entry.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}

      <p className="mt-3 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <ShieldCheck className="h-3 w-3" aria-hidden />
        Passwords, tokens, connection strings and private keys are replaced with [REDACTED] on both
        ingest and read.
      </p>
    </PageShell>
  );
}
