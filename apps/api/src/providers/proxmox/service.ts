import type {
  AuthenticatedUser,
  Environment,
  ProxmoxCluster,
  ProxmoxGuest,
  ProxmoxNode,
  ProxmoxStorage,
  SubsystemHealth,
} from '@airaos/types';
import { errors } from '../../utils/errors.js';
import { providerCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { visibleEnvironments } from '../../rbac/index.js';
import * as client from './client.js';
import {
  backupStateFromTasks,
  enrichNode,
  ipsFromAgent,
  ipsFromLxcConfig,
  mapCluster,
  mapGuest,
  mapNodeSummary,
  mapStorage,
} from './mapper.js';
import type {
  PveAgentInterfaces,
  PveBackupTask,
  PveClusterStatusEntry,
  PveGuestSummary,
  PveNodeStatus,
  PveNodeSummary,
  PveSnapshot,
  PveStorageEntry,
  PveTaskStatus,
} from './types.js';

/**
 * Proxmox read model plus allowlisted guest lifecycle operations.
 *
 * Inventory comes from /cluster/resources, which is one request for the whole
 * cluster; per-guest detail is fetched only when a guest page is opened.
 */

const CACHE = {
  inventory: 30_000,
  nodeStatus: 20_000,
  storage: 120_000,
  tasks: 60_000,
} as const;

/** Async because configuration now comes from the Connection Manager. */
export async function configured(): Promise<boolean> {
  return client.isConfigured();
}

async function assertConfigured(): Promise<void> {
  if (!(await configured())) throw errors.providerNotConfigured('Proxmox');
}

export interface ProxmoxInventory {
  cluster: ProxmoxCluster;
  nodes: ProxmoxNode[];
  guests: ProxmoxGuest[];
}

async function loadInventory(): Promise<ProxmoxInventory> {
  await assertConfigured();

  const [clusterStatus, resources] = await Promise.all([
    client.get<PveClusterStatusEntry[]>('/cluster/status').catch((error) => {
      // A single-node install has no cluster; treat that as a normal shape.
      logger().debug({ err: error }, 'cluster status unavailable, assuming standalone node');
      return [] as PveClusterStatusEntry[];
    }),
    client.get<PveGuestSummary[]>('/cluster/resources', { type: 'vm' }),
  ]);

  const nodeSummaries = await client.get<PveNodeSummary[]>('/nodes');
  const nodes = nodeSummaries.map(mapNodeSummary);

  const guests: ProxmoxGuest[] = resources
    .filter((row) => row.vmid !== undefined)
    .map((row) => {
      const type = row.type === 'lxc' ? 'lxc' : 'qemu';
      return mapGuest(row, row.node ?? 'unknown', type);
    })
    .filter((guest) => !guest.template)
    .sort((a, b) => a.vmid - b.vmid);

  // Fold guest counts into their node so the node cards need no second pass.
  for (const node of nodes) {
    const own = guests.filter((guest) => guest.node === node.node);
    node.guestCounts = {
      qemuTotal: own.filter((guest) => guest.type === 'qemu').length,
      qemuRunning: own.filter((guest) => guest.type === 'qemu' && guest.status === 'running').length,
      lxcTotal: own.filter((guest) => guest.type === 'lxc').length,
      lxcRunning: own.filter((guest) => guest.type === 'lxc' && guest.status === 'running').length,
    };
  }

  const cluster =
    clusterStatus.length > 0
      ? mapCluster(clusterStatus)
      : {
          name: null,
          quorate: null,
          nodeCount: nodes.length,
          onlineNodeCount: nodes.filter((node) => node.status === 'online').length,
          version: null,
        };

  return { cluster, nodes, guests };
}

export async function getInventory(
  user: AuthenticatedUser,
): Promise<{ value: ProxmoxInventory; cachedAgeMs?: number; stale: boolean }> {
  const result = await providerCache.wrap('pve:inventory', CACHE.inventory, loadInventory, {
    fallbackToStale: true,
  });

  const allowed = new Set(visibleEnvironments(user));
  return {
    ...result,
    value: {
      ...result.value,
      guests: result.value.guests.filter((guest) => allowed.has(guest.environment)),
    },
  };
}

export async function listGuests(
  user: AuthenticatedUser,
  filters: { environment?: Environment; node?: string; type?: 'qemu' | 'lxc'; search?: string } = {},
): Promise<{ value: ProxmoxGuest[]; cachedAgeMs?: number; stale: boolean }> {
  const inventory = await getInventory(user);
  let guests = inventory.value.guests;

  if (filters.environment) {
    if (!user.environments.includes(filters.environment)) {
      throw errors.environmentForbidden(filters.environment);
    }
    guests = guests.filter((guest) => guest.environment === filters.environment);
  }
  if (filters.node) guests = guests.filter((guest) => guest.node === filters.node);
  if (filters.type) guests = guests.filter((guest) => guest.type === filters.type);
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    guests = guests.filter(
      (guest) =>
        guest.name.toLowerCase().includes(needle) ||
        String(guest.vmid).includes(needle) ||
        guest.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }

  return { ...inventory, value: guests };
}

/**
 * Resolves a guest by vmid and confirms the caller may see its environment.
 * The `node` is taken from inventory, never from the request, so a client cannot
 * redirect an action at a different node.
 */
export async function getGuest(user: AuthenticatedUser, vmid: number): Promise<ProxmoxGuest> {
  const { value } = await getInventory(user);
  const guest = value.guests.find((candidate) => candidate.vmid === vmid);
  // Not visible and not present deliberately produce the same answer.
  if (!guest) throw errors.notFound('Proxmox guest');
  return guest;
}

export async function getNodes(user: AuthenticatedUser): Promise<ProxmoxNode[]> {
  const { value } = await getInventory(user);

  // Node status is a per-node call; run them in parallel and tolerate failures.
  const enriched = await Promise.all(
    value.nodes.map(async (node) => {
      if (node.status !== 'online') return node;
      const status = await providerCache
        .wrap(
          `pve:node-status:${node.node}`,
          CACHE.nodeStatus,
          () => client.get<PveNodeStatus>(`/nodes/${encodeURIComponent(node.node)}/status`),
          { fallbackToStale: true },
        )
        .then((result) => result.value)
        .catch((error) => {
          logger().debug({ err: error, node: node.node }, 'node status unavailable');
          return null;
        });
      return enrichNode(node, status);
    }),
  );

  return enriched;
}

export async function getGuestDetail(
  user: AuthenticatedUser,
  vmid: number,
): Promise<{ guest: ProxmoxGuest; snapshots: PveSnapshot[] }> {
  const guest = await getGuest(user, vmid);
  const basePath = `/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}`;

  const [snapshots, addresses, backupTasks] = await Promise.all([
    client.getOptional<PveSnapshot[]>(`${basePath}/snapshot`).then((list) => list ?? []),
    resolveAddresses(guest, basePath),
    loadBackupTasks(guest.node),
  ]);

  return {
    guest: {
      ...guest,
      ipAddresses: addresses,
      // Proxmox includes a synthetic "current" entry; exclude it from the count.
      snapshotCount: snapshots.filter((snapshot) => snapshot.name !== 'current').length,
      backup: backupStateFromTasks(guest.vmid, backupTasks, null),
    },
    snapshots: snapshots.filter((snapshot) => snapshot.name !== 'current'),
  };
}

async function resolveAddresses(guest: ProxmoxGuest, basePath: string): Promise<string[]> {
  if (guest.status !== 'running') return [];
  if (guest.type === 'qemu') {
    const agent = await client.getOptional<PveAgentInterfaces>(
      `${basePath}/agent/network-get-interfaces`,
    );
    return ipsFromAgent(agent);
  }
  const config = await client.getOptional<Record<string, unknown>>(`${basePath}/config`);
  return ipsFromLxcConfig(config);
}

async function loadBackupTasks(node: string): Promise<PveBackupTask[]> {
  const result = await providerCache
    .wrap(
      `pve:backup-tasks:${node}`,
      CACHE.tasks,
      async () =>
        (await client.get<PveBackupTask[]>(`/nodes/${encodeURIComponent(node)}/tasks`, {
          typefilter: 'vzdump',
          limit: 200,
        })) ?? [],
      { fallbackToStale: true },
    )
    .catch((error) => {
      logger().debug({ err: error, node }, 'backup task log unavailable');
      return { value: [] as PveBackupTask[], stale: false };
    });
  return result.value;
}

export async function listStorage(): Promise<ProxmoxStorage[]> {
  await assertConfigured();
  const result = await providerCache.wrap(
    'pve:storage',
    CACHE.storage,
    async () => {
      const entries = await client.get<PveStorageEntry[]>('/cluster/resources', {
        type: 'storage',
      });
      return entries.map((entry) => mapStorage(entry, entry.node ?? 'cluster'));
    },
    { fallbackToStale: true },
  );
  return result.value;
}

// ------------------------------------------------------------- operations ----

/**
 * Guest lifecycle commands the console may issue. Mapping an operation key to a
 * Proxmox endpoint here is the only way a command can be sent; the request body
 * never names a path.
 */
const GUEST_COMMANDS = {
  start_vm: { endpoint: 'status/start', label: 'start' },
  shutdown_vm: { endpoint: 'status/shutdown', label: 'shutdown' },
  reboot_vm: { endpoint: 'status/reboot', label: 'reboot' },
  stop_vm: { endpoint: 'status/stop', label: 'stop' },
  snapshot_vm: { endpoint: 'snapshot', label: 'snapshot' },
} as const;

export type GuestCommandKey = keyof typeof GUEST_COMMANDS;

export function isGuestCommand(key: string): key is GuestCommandKey {
  return key in GUEST_COMMANDS;
}

export async function executeGuestCommand(
  user: AuthenticatedUser,
  key: GuestCommandKey,
  vmid: number,
): Promise<{ upid: string; guest: ProxmoxGuest }> {
  const guest = await getGuest(user, vmid);
  const command = GUEST_COMMANDS[key];
  const basePath = `/nodes/${encodeURIComponent(guest.node)}/${guest.type}/${guest.vmid}`;

  const body =
    key === 'snapshot_vm'
      ? {
          snapname: `console-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '')}`,
          description: `Created from AIRAOS Infra Console by ${user.email}`,
        }
      : undefined;

  const upid = await client.postCommand(`${basePath}/${command.endpoint}`, body);

  providerCache.invalidate('pve:inventory');
  providerCache.invalidate(`pve:node-status:${guest.node}`);

  return { upid, guest };
}

export async function getTaskStatus(node: string, upid: string): Promise<PveTaskStatus | null> {
  return client.getOptional<PveTaskStatus>(
    `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
  );
}

// ----------------------------------------------------------------- health ----

export async function health(): Promise<SubsystemHealth> {
  const base = {
    key: 'proxmox',
    label: 'Proxmox',
    configured: await configured(),
    lastCheckedAt: new Date().toISOString(),
  };

  if (!(await configured())) {
    return {
      ...base,
      state: 'unknown',
      detail: 'No API URL or token configured.',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }

  const started = Date.now();
  try {
    const nodes = await client.get<PveNodeSummary[]>('/nodes');
    const online = nodes.filter((node) => node.status === 'online').length;
    const state = online === 0 ? 'down' : online < nodes.length ? 'degraded' : 'healthy';
    return {
      ...base,
      state,
      detail: `${online}/${nodes.length} node(s) online.`,
      lastSuccessAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      state: 'down',
      detail: error instanceof Error ? error.message : 'Unknown error',
      lastSuccessAt: client.lastSuccessAt(),
      latencyMs: null,
    };
  }
}
