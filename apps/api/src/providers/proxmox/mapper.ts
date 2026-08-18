import {
  ENVIRONMENTS,
  type BackupState,
  type Environment,
  type ProxmoxCluster,
  type ProxmoxGuest,
  type ProxmoxGuestStatus,
  type ProxmoxGuestType,
  type ProxmoxNode,
  type ProxmoxStorage,
} from '@airaos/types';
import type {
  PveAgentInterfaces,
  PveBackupTask,
  PveClusterStatusEntry,
  PveGuestSummary,
  PveNodeStatus,
  PveNodeSummary,
  PveStorageEntry,
} from './types.js';

/**
 * Environment resolution for Proxmox guests.
 *
 * Proxmox tags are semicolon-separated. The guest name is used as a fallback so
 * a conventionally-named `staging-db-01` still lands in the right bucket. As with
 * DigitalOcean, an unresolvable guest is treated as production so it inherits the
 * strictest guardrails.
 */
export function environmentFromGuest(tags: string | undefined, name: string): Environment {
  const candidates = [
    ...(tags ?? '').split(/[;,\s]+/).map((tag) => tag.trim().toLowerCase()),
  ].filter(Boolean);

  for (const raw of candidates) {
    const value = raw.startsWith('env:') ? raw.slice(4) : raw;
    const exact = (ENVIRONMENTS as readonly string[]).find((candidate) => candidate === value);
    if (exact) return exact as Environment;
    if (value === 'prod') return 'production';
    if (value === 'dev') return 'development';
    if (value === 'stage' || value === 'stg') return 'staging';
    if (value === 'test' || value === 'qa') return 'testing';
  }

  const lowerName = name.toLowerCase();
  if (/(^|[-_.])prod/.test(lowerName)) return 'production';
  if (/(^|[-_.])(stag|stg)/.test(lowerName)) return 'staging';
  if (/(^|[-_.])(test|qa)/.test(lowerName)) return 'testing';
  if (/(^|[-_.])dev/.test(lowerName)) return 'development';

  return 'production';
}

function mapGuestStatus(status: string | undefined): ProxmoxGuestStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'paused':
      return 'paused';
    case 'suspended':
      return 'suspended';
    default:
      return 'unknown';
  }
}

export function mapNodeSummary(summary: PveNodeSummary): ProxmoxNode {
  return {
    node: summary.node,
    status: summary.status ?? 'unknown',
    // Proxmox reports CPU as a 0-1 fraction.
    cpuPercent: summary.cpu !== undefined ? round2(summary.cpu * 100) : null,
    cpuCount: summary.maxcpu ?? null,
    memoryUsedBytes: summary.mem ?? null,
    memoryTotalBytes: summary.maxmem ?? null,
    rootfsUsedBytes: summary.disk ?? null,
    rootfsTotalBytes: summary.maxdisk ?? null,
    uptimeSeconds: summary.uptime ?? null,
    loadAverage: null,
    pveVersion: null,
    guestCounts: { qemuRunning: 0, qemuTotal: 0, lxcRunning: 0, lxcTotal: 0 },
  };
}

/** Enriches a node summary with the detail from /nodes/{node}/status. */
export function enrichNode(node: ProxmoxNode, status: PveNodeStatus | null): ProxmoxNode {
  if (!status) return node;
  return {
    ...node,
    cpuCount: status.cpuinfo?.cpus ?? node.cpuCount,
    memoryUsedBytes: status.memory?.used ?? node.memoryUsedBytes,
    memoryTotalBytes: status.memory?.total ?? node.memoryTotalBytes,
    rootfsUsedBytes: status.rootfs?.used ?? node.rootfsUsedBytes,
    rootfsTotalBytes: status.rootfs?.total ?? node.rootfsTotalBytes,
    uptimeSeconds: status.uptime ?? node.uptimeSeconds,
    loadAverage: (status.loadavg ?? []).map(Number).filter(Number.isFinite),
    pveVersion: status.pveversion ?? node.pveVersion,
  };
}

export function mapGuest(
  summary: PveGuestSummary,
  fallbackNode: string,
  type: ProxmoxGuestType,
): ProxmoxGuest {
  const name = summary.name ?? `${type}-${summary.vmid}`;
  return {
    vmid: summary.vmid,
    name,
    type,
    node: summary.node ?? fallbackNode,
    status: mapGuestStatus(summary.status),
    environment: environmentFromGuest(summary.tags, name),
    cpuPercent: summary.cpu !== undefined ? round2(summary.cpu * 100) : null,
    cpuCount: summary.cpus ?? summary.maxcpu ?? null,
    memoryUsedBytes: summary.mem ?? null,
    memoryTotalBytes: summary.maxmem ?? null,
    diskUsedBytes: summary.disk ?? null,
    diskTotalBytes: summary.maxdisk ?? null,
    networkInBytes: summary.netin ?? null,
    networkOutBytes: summary.netout ?? null,
    uptimeSeconds: summary.uptime ?? null,
    ipAddresses: [],
    tags: (summary.tags ?? '').split(/[;,]/).map((tag) => tag.trim()).filter(Boolean),
    template: summary.template === 1 || summary.template === true,
    haManaged: Boolean(summary.hastate && summary.hastate !== 'unmanaged'),
    snapshotCount: null,
    backup: unverifiedBackupState(),
  };
}

/**
 * Default backup state: nothing is claimed until a real backup task or storage
 * entry has been read (spec section 47).
 */
export function unverifiedBackupState(): BackupState {
  return {
    enabled: false,
    lastBackupAt: null,
    status: null,
    retentionDays: null,
    target: null,
    verified: false,
  };
}

/**
 * Derives backup state for one guest from the node's recent vzdump task log.
 * Only a task that actually completed marks the state verified.
 */
export function backupStateFromTasks(
  vmid: number,
  tasks: PveBackupTask[],
  target: string | null,
): BackupState {
  const relevant = tasks
    .filter((task) => task.id === String(vmid) || task.upid.includes(`:${vmid}:`))
    .sort((a, b) => (b.starttime ?? 0) - (a.starttime ?? 0));

  const latest = relevant[0];
  if (!latest) return unverifiedBackupState();

  const succeeded = latest.exitstatus === 'OK';
  return {
    enabled: true,
    lastBackupAt: latest.endtime
      ? new Date(latest.endtime * 1000).toISOString()
      : new Date(latest.starttime * 1000).toISOString(),
    status: latest.exitstatus ?? (latest.endtime ? 'unknown' : 'running'),
    retentionDays: null,
    target,
    verified: succeeded,
  };
}

export function mapCluster(entries: PveClusterStatusEntry[]): ProxmoxCluster {
  const clusterEntry = entries.find((entry) => entry.type === 'cluster');
  const nodes = entries.filter((entry) => entry.type === 'node');

  return {
    name: clusterEntry?.name ?? null,
    quorate: clusterEntry?.quorate === undefined ? null : clusterEntry.quorate === 1,
    nodeCount: clusterEntry?.nodes ?? nodes.length,
    onlineNodeCount: nodes.filter((node) => node.online === 1).length,
    version: clusterEntry?.version !== undefined ? String(clusterEntry.version) : null,
  };
}

export function mapStorage(entry: PveStorageEntry, fallbackNode: string): ProxmoxStorage {
  return {
    storage: entry.storage,
    node: entry.node ?? fallbackNode,
    type: entry.type,
    enabled: entry.enabled !== 0,
    active: entry.active === 1,
    usedBytes: entry.used ?? null,
    totalBytes: entry.total ?? null,
    content: (entry.content ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  };
}

/** Pulls IPv4/IPv6 addresses out of a QEMU guest agent response. */
export function ipsFromAgent(agent: PveAgentInterfaces | null): string[] {
  if (!agent?.result) return [];
  const addresses: string[] = [];
  for (const iface of agent.result) {
    if (iface.name === 'lo') continue;
    for (const address of iface['ip-addresses'] ?? []) {
      const ip = address['ip-address'];
      if (!ip || ip.startsWith('127.') || ip.startsWith('::1') || ip.startsWith('fe80')) continue;
      addresses.push(ip);
    }
  }
  return [...new Set(addresses)];
}

/**
 * Extracts a static IP from an LXC config's netN entries. Containers using DHCP
 * report `ip=dhcp`, which is skipped rather than shown as an address.
 */
export function ipsFromLxcConfig(config: Record<string, unknown> | null): string[] {
  if (!config) return [];
  const addresses: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!/^net\d+$/.test(key) || typeof value !== 'string') continue;
    const match = /(?:^|,)ip6?=([^,]+)/.exec(value);
    const ip = match?.[1];
    if (!ip || ip === 'dhcp' || ip === 'auto' || ip === 'manual') continue;
    addresses.push(ip.split('/')[0] ?? ip);
  }
  return addresses;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}
