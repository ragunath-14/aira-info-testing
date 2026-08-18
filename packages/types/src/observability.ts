import type { Environment } from './environment.js';
import type { TimeSeries } from './infrastructure.js';

export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertState = 'firing' | 'pending' | 'resolved' | 'suppressed';

export interface Alert {
  /** Stable fingerprint from Alertmanager, used as the acknowledgement key. */
  fingerprint: string;
  name: string;
  severity: AlertSeverity;
  state: AlertState;
  environment: Environment | null;
  /** Free-form resource identifier from labels (instance, droplet, vmid...). */
  resource: string | null;
  summary: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  labels: Record<string, string>;
  runbookUrl: string | null;
  generatorUrl: string | null;
  acknowledgement: AlertAcknowledgement | null;
}

export interface AlertAcknowledgement {
  acknowledgedByUserId: string;
  acknowledgedByEmail: string;
  acknowledgedAt: string;
  note: string | null;
  resolvedAt: string | null;
  resolutionDetail: string | null;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  environment: Environment;
  /** Application key, container name or infrastructure component. */
  source: string;
  message: string;
  /** Structured fields, already passed through secret redaction. */
  fields: Record<string, unknown>;
  requestId: string | null;
}

export type LogSourceKind = 'application' | 'container' | 'infrastructure' | 'deployment' | 'audit';

export interface LogQuery {
  sources: string[];
  kinds: LogSourceKind[];
  environments: Environment[];
  levels: LogLevel[];
  search: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  cursor: string | null;
  errorsOnly: boolean;
}

export interface MetricSummary {
  key: string;
  label: string;
  unit: 'percent' | 'bytes' | 'count' | 'seconds' | 'ms' | 'rps' | 'ratio';
  value: number | null;
  series: TimeSeries | null;
  /** Warning / critical thresholds used for colouring, when defined. */
  warnAbove: number | null;
  criticalAbove: number | null;
  /** Present when the metric could not be collected. */
  unavailableReason: string | null;
}

export interface GrafanaLink {
  label: string;
  /** Deep link into Grafana. Never contains an API token. */
  url: string;
  dashboardUid: string | null;
}
