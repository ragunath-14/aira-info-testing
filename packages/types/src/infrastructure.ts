import type { Environment } from './environment.js';

export type HealthState = 'healthy' | 'degraded' | 'down' | 'unknown';

/**
 * Every provider-backed subsystem reports through this shape so the dashboard
 * can render an honest status even when a provider is unreachable or has not
 * been configured yet. `unknown` is never rendered as "healthy".
 */
export interface SubsystemHealth {
  key: string;
  label: string;
  state: HealthState;
  /** Human-readable one-line summary. Never contains credentials. */
  detail: string;
  configured: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  /** Round-trip time of the last successful probe, milliseconds. */
  latencyMs: number | null;
}

export type DropletStatus = 'new' | 'active' | 'off' | 'archive' | 'unknown';

export interface Droplet {
  id: string;
  name: string;
  status: DropletStatus;
  environment: Environment;
  region: { slug: string; name: string };
  size: { slug: string; vcpus: number; memoryMb: number; diskGb: number; priceMonthly: number | null };
  networks: {
    publicIpv4: string | null;
    privateIpv4: string | null;
    ipv6: string | null;
  };
  image: { id: number | null; name: string | null; distribution: string | null };
  tags: string[];
  createdAt: string;
  /** Seconds since creation; the DO API exposes no true uptime counter. */
  ageSeconds: number;
  monitoringEnabled: boolean;
  backupsEnabled: boolean;
  vpcUuid: string | null;
  features: string[];
}

export interface DropletMetrics {
  dropletId: string;
  /** ISO timestamps paired with values, oldest first. */
  cpuPercent: TimeSeries;
  memoryPercent: TimeSeries | null;
  diskPercent: TimeSeries | null;
  loadAverage1m: TimeSeries | null;
  networkInBytes: TimeSeries;
  networkOutBytes: TimeSeries;
  /** Set when a metric could not be retrieved rather than silently zeroed. */
  unavailable: string[];
}

export interface TimeSeriesPoint {
  t: string;
  v: number;
}

export type TimeSeries = TimeSeriesPoint[];

export interface DoVolume {
  id: string;
  name: string;
  sizeGb: number;
  region: string;
  attachedDropletIds: string[];
  filesystemType: string | null;
  createdAt: string;
}

export interface DoFirewall {
  id: string;
  name: string;
  status: string;
  inboundRules: Array<{ protocol: string; ports: string; sources: string[] }>;
  outboundRules: Array<{ protocol: string; ports: string; destinations: string[] }>;
  dropletIds: string[];
  tags: string[];
}

export interface DoSnapshot {
  id: string;
  name: string;
  resourceId: string;
  resourceType: 'droplet' | 'volume';
  sizeGb: number;
  regions: string[];
  createdAt: string;
}

export interface DoFloatingIp {
  ip: string;
  region: string;
  dropletId: string | null;
  locked: boolean;
}

export interface BackupState {
  /** Whether the provider reports backups as enabled. */
  enabled: boolean;
  lastBackupAt: string | null;
  /** Provider-reported status; null when the API exposes nothing. */
  status: string | null;
  retentionDays: number | null;
  target: string | null;
  /**
   * True only when the console has read a concrete successful backup record.
   * The dashboard must not claim a backup exists otherwise (spec section 47).
   */
  verified: boolean;
}

export type ProxmoxGuestType = 'qemu' | 'lxc';
export type ProxmoxGuestStatus = 'running' | 'stopped' | 'paused' | 'suspended' | 'unknown';

export interface ProxmoxNode {
  node: string;
  status: 'online' | 'offline' | 'unknown';
  cpuPercent: number | null;
  cpuCount: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  rootfsUsedBytes: number | null;
  rootfsTotalBytes: number | null;
  uptimeSeconds: number | null;
  loadAverage: number[] | null;
  pveVersion: string | null;
  guestCounts: { qemuRunning: number; qemuTotal: number; lxcRunning: number; lxcTotal: number };
}

export interface ProxmoxGuest {
  vmid: number;
  name: string;
  type: ProxmoxGuestType;
  node: string;
  status: ProxmoxGuestStatus;
  environment: Environment;
  cpuPercent: number | null;
  cpuCount: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  networkInBytes: number | null;
  networkOutBytes: number | null;
  uptimeSeconds: number | null;
  ipAddresses: string[];
  tags: string[];
  template: boolean;
  haManaged: boolean;
  snapshotCount: number | null;
  backup: BackupState;
}

export interface ProxmoxCluster {
  name: string | null;
  quorate: boolean | null;
  nodeCount: number;
  onlineNodeCount: number;
  version: string | null;
}

export interface ProxmoxStorage {
  storage: string;
  node: string;
  type: string;
  enabled: boolean;
  active: boolean;
  usedBytes: number | null;
  totalBytes: number | null;
  content: string[];
}
