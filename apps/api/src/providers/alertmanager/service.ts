import type {
  Alert,
  AlertAcknowledgement,
  AlertSeverity,
  AlertState,
  Environment,
  SubsystemHealth,
} from '@airaos/types';
import { isEnvironment } from '@airaos/types';
import { config } from '../../config.js';
import { and, inArray, isNotNull, eq, sql } from 'drizzle-orm';
import { orm, schema } from '../../db/drizzle.js';
import { errors } from '../../utils/errors.js';
import { providerCache } from '../../utils/cache.js';
import { ProviderHttpClient } from '../../utils/http.js';
import { logger } from '../../utils/logger.js';

/**
 * Alertmanager integration (spec section 15).
 *
 * Alertmanager stays the source of truth for what is firing. The console layers
 * the human workflow on top: who acknowledged an alert, when, and how it was
 * resolved. Acknowledgement is recorded locally rather than as an Alertmanager
 * silence, because silencing hides the alert from everyone — acknowledging should
 * only say "someone owns this".
 */

interface AmAlert {
  fingerprint: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  updatedAt: string;
  generatorURL?: string;
  status: { state: 'active' | 'suppressed' | 'unprocessed'; silencedBy: string[]; inhibitedBy: string[] };
}

let httpClient: ProviderHttpClient | null = null;

export function configured(): boolean {
  return config().providers.alertmanager;
}

function client(): ProviderHttpClient {
  const cfg = config();
  if (!cfg.ALERTMANAGER_URL) throw errors.providerNotConfigured('Alertmanager');
  if (!httpClient) {
    httpClient = new ProviderHttpClient({
      provider: 'Alertmanager',
      baseUrl: `${cfg.ALERTMANAGER_URL.replace(/\/+$/, '')}/api/v2`,
      timeoutMs: 8000,
      retries: 1,
    });
  }
  return httpClient;
}

function normaliseSeverity(value: string | undefined): AlertSeverity {
  switch ((value ?? '').toLowerCase()) {
    case 'critical':
    case 'page':
      return 'critical';
    case 'warning':
    case 'warn':
      return 'warning';
    default:
      return 'info';
  }
}

function normaliseState(alert: AmAlert): AlertState {
  if (alert.status.state === 'suppressed') return 'suppressed';
  if (alert.endsAt && new Date(alert.endsAt).getTime() < Date.now()) return 'resolved';
  return 'firing';
}

/**
 * Resolves the environment from alert labels. An alert that does not say which
 * environment it belongs to stays `null` rather than being guessed — a
 * mislabelled environment on an alert is worse than an absent one.
 */
function environmentFromLabels(labels: Record<string, string>): Environment | null {
  const candidate = labels['environment'] ?? labels['env'] ?? labels['stage'];
  if (!candidate) return null;
  const value = candidate.toLowerCase();
  if (isEnvironment(value)) return value;
  if (value === 'prod') return 'production';
  if (value === 'dev') return 'development';
  if (value === 'stage' || value === 'stg') return 'staging';
  if (value === 'test' || value === 'qa') return 'testing';
  return null;
}

function resourceFromLabels(labels: Record<string, string>): string | null {
  return (
    labels['instance'] ??
    labels['droplet'] ??
    labels['vmid'] ??
    labels['name'] ??
    labels['service'] ??
    labels['job'] ??
    null
  );
}

async function fetchAlerts(): Promise<Alert[]> {
  const wire = await client().json<AmAlert[]>({
    path: '/alerts',
    query: { active: true, silenced: true, inhibited: true, unprocessed: false },
  });

  const alerts: Alert[] = (wire ?? []).map((alert) => ({
    fingerprint: alert.fingerprint,
    name: alert.labels['alertname'] ?? 'unnamed',
    severity: normaliseSeverity(alert.labels['severity']),
    state: normaliseState(alert),
    environment: environmentFromLabels(alert.labels),
    resource: resourceFromLabels(alert.labels),
    summary: alert.annotations['summary'] ?? alert.labels['alertname'] ?? 'Alert firing',
    description: alert.annotations['description'] ?? null,
    startsAt: alert.startsAt,
    endsAt: alert.endsAt && new Date(alert.endsAt).getTime() > 0 ? alert.endsAt : null,
    labels: alert.labels,
    runbookUrl: alert.annotations['runbook_url'] ?? alert.annotations['runbook'] ?? null,
    generatorUrl: alert.generatorURL ?? null,
    acknowledgement: null,
  }));

  return attachAcknowledgements(alerts);
}

async function attachAcknowledgements(alerts: Alert[]): Promise<Alert[]> {
  if (alerts.length === 0) return alerts;

  const acks = schema.alertAcknowledgements;
  const rows = await orm()
    .select({
      fingerprint: acks.fingerprint,
      acknowledgedBy: acks.acknowledgedBy,
      acknowledgedEmail: acks.acknowledgedEmail,
      acknowledgedAt: acks.acknowledgedAt,
      note: acks.note,
      resolvedAt: acks.resolvedAt,
      resolutionDetail: acks.resolutionDetail,
    })
    .from(acks)
    .where(inArray(acks.fingerprint, alerts.map((alert) => alert.fingerprint)));

  const byFingerprint = new Map(rows.map((row) => [row.fingerprint, row]));

  return alerts.map((alert) => {
    const row = byFingerprint.get(alert.fingerprint);
    if (!row?.acknowledgedAt) return alert;
    const acknowledgement: AlertAcknowledgement = {
      acknowledgedByUserId: row.acknowledgedBy ?? '',
      acknowledgedByEmail: row.acknowledgedEmail ?? '',
      acknowledgedAt: row.acknowledgedAt.toISOString(),
      note: row.note,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolutionDetail: row.resolutionDetail,
    };
    return { ...alert, acknowledgement };
  });
}

export async function listAlerts(filters: {
  severity?: AlertSeverity;
  state?: AlertState;
  environment?: Environment;
  acknowledged?: boolean;
  search?: string;
  visibleEnvironments: Environment[];
}): Promise<{ items: Alert[]; cachedAgeMs?: number; stale: boolean }> {
  if (!configured()) {
    return { items: [], stale: false };
  }

  const result = await providerCache.wrap('am:alerts', 15_000, fetchAlerts, {
    fallbackToStale: true,
  });

  const allowed = new Set(filters.visibleEnvironments);
  let items = result.value.filter(
    // Alerts with no environment label are shown to everyone: hiding an
    // unlabelled critical alert would be worse than over-sharing it.
    (alert) => alert.environment === null || allowed.has(alert.environment),
  );

  if (filters.severity) items = items.filter((alert) => alert.severity === filters.severity);
  if (filters.state) items = items.filter((alert) => alert.state === filters.state);
  if (filters.environment) {
    items = items.filter((alert) => alert.environment === filters.environment);
  }
  if (filters.acknowledged !== undefined) {
    items = items.filter((alert) => Boolean(alert.acknowledgement) === filters.acknowledged);
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    items = items.filter(
      (alert) =>
        alert.name.toLowerCase().includes(needle) ||
        alert.summary.toLowerCase().includes(needle) ||
        (alert.resource ?? '').toLowerCase().includes(needle),
    );
  }

  const severityRank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
  items.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] || b.startsAt.localeCompare(a.startsAt),
  );

  return { items, cachedAgeMs: result.cachedAgeMs, stale: result.stale };
}

export async function findAlert(fingerprint: string): Promise<Alert | null> {
  if (!configured()) return null;
  const result = await providerCache.wrap('am:alerts', 15_000, fetchAlerts, {
    fallbackToStale: true,
  });
  return result.value.find((alert) => alert.fingerprint === fingerprint) ?? null;
}

export async function acknowledge(
  alert: Alert,
  user: { id: string; email: string },
  note: string | null,
): Promise<void> {
  const acks = schema.alertAcknowledgements;
  await orm()
    .insert(acks)
    .values({
      fingerprint: alert.fingerprint,
      alertName: alert.name,
      severity: alert.severity,
      environment: alert.environment,
      resource: alert.resource,
      summary: alert.summary,
      acknowledgedBy: user.id,
      acknowledgedEmail: user.email,
      acknowledgedAt: sql`now()`,
      note,
      labels: alert.labels,
    })
    .onConflictDoUpdate({
      target: acks.fingerprint,
      // Re-acknowledging a re-fired alert clears the previous resolution, so a
      // stale "resolved" note cannot sit on a live alert.
      set: {
        acknowledgedBy: sql`excluded.acknowledged_by`,
        acknowledgedEmail: sql`excluded.acknowledged_email`,
        acknowledgedAt: sql`now()`,
        note: sql`excluded.note`,
        resolvedAt: null,
        resolutionDetail: null,
      },
    });
  providerCache.invalidate('am:alerts');
}

export async function resolve(
  fingerprint: string,
  resolutionDetail: string,
): Promise<void> {
  const acks = schema.alertAcknowledgements;
  const result = await orm()
    .update(acks)
    .set({ resolvedAt: sql`now()`, resolutionDetail })
    .where(and(eq(acks.fingerprint, fingerprint), isNotNull(acks.acknowledgedAt)));
  if ((result.rowCount ?? 0) === 0) {
    throw errors.conflict('Acknowledge the alert before recording a resolution.');
  }
  providerCache.invalidate('am:alerts');
}

export interface AlertCounts {
  critical: number;
  warning: number;
  info: number;
  unacknowledged: number;
}

export async function counts(visibleEnvironments: Environment[]): Promise<AlertCounts> {
  if (!configured()) return { critical: 0, warning: 0, info: 0, unacknowledged: 0 };
  try {
    const { items } = await listAlerts({ visibleEnvironments, state: 'firing' });
    return {
      critical: items.filter((alert) => alert.severity === 'critical').length,
      warning: items.filter((alert) => alert.severity === 'warning').length,
      info: items.filter((alert) => alert.severity === 'info').length,
      unacknowledged: items.filter((alert) => !alert.acknowledgement).length,
    };
  } catch (error) {
    logger().debug({ err: error }, 'alert counts unavailable');
    return { critical: 0, warning: 0, info: 0, unacknowledged: 0 };
  }
}

export async function health(): Promise<SubsystemHealth> {
  const base = {
    key: 'alertmanager',
    label: 'Alertmanager',
    configured: configured(),
    lastCheckedAt: new Date().toISOString(),
  };

  if (!configured()) {
    return {
      ...base,
      state: 'unknown',
      detail: 'No Alertmanager URL configured.',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }

  const started = Date.now();
  try {
    await client().json<{ cluster: { status: string } }>({ path: '/status' });
    return {
      ...base,
      state: 'healthy',
      detail: 'Alertmanager reachable.',
      lastSuccessAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      state: 'down',
      detail: error instanceof Error ? error.message : 'Unknown error',
      lastSuccessAt: httpClient?.lastSuccessIso ?? null,
      latencyMs: null,
    };
  }
}

export async function closeClient(): Promise<void> {
  await httpClient?.close();
  httpClient = null;
}
