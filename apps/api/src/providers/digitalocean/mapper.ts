import {
  ENVIRONMENTS,
  type BackupState,
  type DoFirewall,
  type DoFloatingIp,
  type DoSnapshot,
  type DoVolume,
  type Droplet,
  type DropletMetrics,
  type DropletStatus,
  type Environment,
  type TimeSeries,
} from '@airaos/types';
import type {
  DoDroplet,
  DoFirewallWire,
  DoFloatingIpWire,
  DoMetricsResponse,
  DoSnapshotWire,
  DoVolumeWire,
} from './types.js';

/**
 * Translates DigitalOcean wire shapes into the console's domain types.
 *
 * Keeping this separate from the client means the UI never sees provider naming,
 * and a provider field rename is a one-file change.
 */

/**
 * Environment resolution.
 *
 * Droplets are tagged `env:production` (or plain `production`) in DigitalOcean.
 * An untagged droplet resolves to `production`, not `development`: assuming the
 * safest environment means an unlabelled resource inherits production guardrails
 * rather than being silently exposed to looser rules (rule 12).
 */
export function environmentFromTags(tags: string[]): Environment {
  const normalised = tags.map((tag) => tag.trim().toLowerCase());

  for (const tag of normalised) {
    const value = tag.startsWith('env:') ? tag.slice(4) : tag;
    const match = (ENVIRONMENTS as readonly string[]).find((candidate) => candidate === value);
    if (match) return match as Environment;
    // Common shorthands used in provider tags.
    if (value === 'prod') return 'production';
    if (value === 'dev') return 'development';
    if (value === 'stage' || value === 'stg') return 'staging';
    if (value === 'test' || value === 'qa') return 'testing';
  }

  return 'production';
}

function mapStatus(status: DoDroplet['status']): DropletStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'off':
      return 'off';
    case 'new':
      return 'new';
    case 'archive':
      return 'archive';
    default:
      return 'unknown';
  }
}

export function mapDroplet(wire: DoDroplet): Droplet {
  const publicIpv4 = wire.networks?.v4?.find((net) => net.type === 'public')?.ip_address ?? null;
  const privateIpv4 = wire.networks?.v4?.find((net) => net.type === 'private')?.ip_address ?? null;
  const ipv6 = wire.networks?.v6?.[0]?.ip_address ?? null;
  const createdAt = wire.created_at;

  return {
    id: String(wire.id),
    name: wire.name,
    status: mapStatus(wire.status),
    environment: environmentFromTags(wire.tags ?? []),
    region: { slug: wire.region?.slug ?? 'unknown', name: wire.region?.name ?? 'Unknown' },
    size: {
      slug: wire.size_slug ?? wire.size?.slug ?? 'unknown',
      vcpus: wire.vcpus,
      memoryMb: wire.memory,
      diskGb: wire.disk,
      priceMonthly: wire.size?.price_monthly ?? null,
    },
    networks: { publicIpv4, privateIpv4, ipv6 },
    image: {
      id: wire.image?.id ?? null,
      name: wire.image?.name ?? null,
      distribution: wire.image?.distribution ?? null,
    },
    tags: wire.tags ?? [],
    createdAt,
    ageSeconds: Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)),
    monitoringEnabled: (wire.features ?? []).includes('monitoring'),
    backupsEnabled: (wire.features ?? []).includes('backups'),
    vpcUuid: wire.vpc_uuid ?? null,
    features: wire.features ?? [],
  };
}

/**
 * Droplet backup state. `verified` is only true when DigitalOcean reports an
 * actual backup id, so the UI never claims a backup exists on the strength of
 * the feature flag alone (spec section 47).
 */
export function mapDropletBackupState(wire: DoDroplet): BackupState {
  const enabled = (wire.features ?? []).includes('backups');
  const hasBackups = (wire.backup_ids ?? []).length > 0;
  return {
    enabled,
    // The list endpoint exposes ids but not their timestamps; the detail view
    // fills this in from the snapshots endpoint.
    lastBackupAt: null,
    status: enabled ? (hasBackups ? 'available' : 'scheduled') : 'disabled',
    retentionDays: enabled ? 28 : null,
    target: enabled ? 'DigitalOcean managed backups' : null,
    verified: hasBackups,
  };
}

export function mapVolume(wire: DoVolumeWire): DoVolume {
  return {
    id: wire.id,
    name: wire.name,
    sizeGb: wire.size_gigabytes,
    region: wire.region?.slug ?? 'unknown',
    attachedDropletIds: (wire.droplet_ids ?? []).map(String),
    filesystemType: wire.filesystem_type ?? null,
    createdAt: wire.created_at,
  };
}

export function mapFirewall(wire: DoFirewallWire): DoFirewall {
  return {
    id: wire.id,
    name: wire.name,
    status: wire.status,
    inboundRules: (wire.inbound_rules ?? []).map((rule) => ({
      protocol: rule.protocol,
      ports: rule.ports || 'all',
      sources: [
        ...(rule.sources?.addresses ?? []),
        ...(rule.sources?.tags ?? []).map((tag) => `tag:${tag}`),
        ...(rule.sources?.droplet_ids ?? []).map((id) => `droplet:${id}`),
        ...(rule.sources?.load_balancer_uids ?? []).map((id) => `lb:${id}`),
      ],
    })),
    outboundRules: (wire.outbound_rules ?? []).map((rule) => ({
      protocol: rule.protocol,
      ports: rule.ports || 'all',
      destinations: [
        ...(rule.destinations?.addresses ?? []),
        ...(rule.destinations?.tags ?? []).map((tag) => `tag:${tag}`),
        ...(rule.destinations?.droplet_ids ?? []).map((id) => `droplet:${id}`),
      ],
    })),
    dropletIds: (wire.droplet_ids ?? []).map(String),
    tags: wire.tags ?? [],
  };
}

export function mapSnapshot(wire: DoSnapshotWire): DoSnapshot {
  return {
    id: wire.id,
    name: wire.name,
    resourceId: wire.resource_id,
    resourceType: wire.resource_type,
    sizeGb: wire.size_gigabytes,
    regions: wire.regions ?? [],
    createdAt: wire.created_at,
  };
}

export function mapFloatingIp(wire: DoFloatingIpWire): DoFloatingIp {
  return {
    ip: wire.ip,
    region: wire.region?.slug ?? 'unknown',
    dropletId: wire.droplet ? String(wire.droplet.id) : null,
    locked: wire.locked,
  };
}

/** Converts one DigitalOcean metrics result into a time series. */
export function mapMetricSeries(
  response: DoMetricsResponse | null,
  transform: (value: number) => number = (value) => value,
): TimeSeries {
  const result = response?.data?.result?.[0];
  if (!result) return [];
  return result.values
    .map(([seconds, value]) => {
      const parsed = Number(value);
      return {
        t: new Date(seconds * 1000).toISOString(),
        v: Number.isFinite(parsed) ? transform(parsed) : 0,
      };
    })
    .filter((point) => Number.isFinite(point.v));
}

/**
 * Sums the per-CPU-mode series DigitalOcean returns for CPU load and converts it
 * to a busy percentage. Falls back to an empty series when the shape is
 * unexpected rather than inventing numbers.
 */
export function mapCpuPercent(response: DoMetricsResponse | null): TimeSeries {
  const results = response?.data?.result ?? [];
  if (results.length === 0) return [];

  const byTimestamp = new Map<number, { idle: number; total: number }>();

  for (const series of results) {
    const mode = series.metric['mode'];
    for (const [seconds, raw] of series.values) {
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const bucket = byTimestamp.get(seconds) ?? { idle: 0, total: 0 };
      bucket.total += value;
      if (mode === 'idle') bucket.idle += value;
      byTimestamp.set(seconds, bucket);
    }
  }

  // Values are cumulative counters, so percentage comes from the delta between
  // consecutive samples.
  const ordered = [...byTimestamp.entries()].sort(([a], [b]) => a - b);
  const points: TimeSeries = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!previous || !current) continue;
    const totalDelta = current[1].total - previous[1].total;
    const idleDelta = current[1].idle - previous[1].idle;
    if (totalDelta <= 0) continue;
    const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
    points.push({
      t: new Date(current[0] * 1000).toISOString(),
      v: Math.min(100, Math.max(0, Number(busy.toFixed(2)))),
    });
  }

  return points;
}

export interface RawMetricSet {
  cpu: DoMetricsResponse | null;
  /** DigitalOcean reports free/available memory, not used. */
  memoryAvailable: DoMetricsResponse | null;
  memoryTotal: DoMetricsResponse | null;
  /** Likewise filesystem_free rather than a used figure. */
  diskFree: DoMetricsResponse | null;
  diskSize: DoMetricsResponse | null;
  load1: DoMetricsResponse | null;
  networkIn: DoMetricsResponse | null;
  networkOut: DoMetricsResponse | null;
  /** Metric keys that could not be fetched. */
  unavailable: string[];
}

export function mapDropletMetrics(dropletId: string, raw: RawMetricSet): DropletMetrics {
  return {
    dropletId,
    cpuPercent: mapCpuPercent(raw.cpu),
    memoryPercent: percentFromPair(raw.memoryAvailable, raw.memoryTotal, true),
    diskPercent: percentFromPair(raw.diskFree, raw.diskSize, true),
    loadAverage1m: raw.load1 ? mapMetricSeries(raw.load1) : null,
    networkInBytes: mapMetricSeries(raw.networkIn),
    networkOutBytes: mapMetricSeries(raw.networkOut),
    unavailable: raw.unavailable,
  };
}

/**
 * Builds a percentage series from two absolute series. `invert` handles the
 * "available" form of a metric, where used = total - available.
 */
function percentFromPair(
  numerator: DoMetricsResponse | null,
  denominator: DoMetricsResponse | null,
  invert: boolean,
): TimeSeries | null {
  if (!numerator || !denominator) return null;

  const numeratorPoints = new Map(
    mapMetricSeries(numerator).map((point) => [point.t, point.v] as const),
  );
  const denominatorPoints = mapMetricSeries(denominator);
  if (denominatorPoints.length === 0) return null;

  const series: TimeSeries = [];
  for (const point of denominatorPoints) {
    const other = numeratorPoints.get(point.t);
    if (other === undefined || point.v <= 0) continue;
    const used = invert ? point.v - other : other;
    series.push({
      t: point.t,
      v: Math.min(100, Math.max(0, Number(((used / point.v) * 100).toFixed(2)))),
    });
  }

  return series.length > 0 ? series : null;
}
