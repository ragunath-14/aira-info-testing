import type {
  AuthenticatedUser,
  BackupState,
  DoFirewall,
  DoFloatingIp,
  DoSnapshot,
  DoVolume,
  Droplet,
  DropletMetrics,
  Environment,
  SubsystemHealth,
} from '@airaos/types';
import { errors } from '../../utils/errors.js';
import { providerCache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { visibleEnvironments } from '../../rbac/index.js';
import * as client from './client.js';
import {
  mapDroplet,
  mapDropletBackupState,
  mapDropletMetrics,
  mapFirewall,
  mapFloatingIp,
  mapSnapshot,
  mapVolume,
  type RawMetricSet,
} from './mapper.js';
import type {
  DoDroplet,
  DoFirewallWire,
  DoFloatingIpWire,
  DoMetricsResponse,
  DoSnapshotWire,
  DoVolumeWire,
} from './types.js';

/**
 * DigitalOcean read model plus the allowlisted power actions.
 *
 * All list results are cached briefly and filtered by the caller's visible
 * environments, so an intern listing droplets simply does not receive production
 * rows (rule 11: the server decides what a request may see).
 */

const CACHE = {
  droplets: 45_000,
  volumes: 120_000,
  firewalls: 120_000,
  snapshots: 120_000,
  floatingIps: 120_000,
  metrics: 20_000,
} as const;

/** Async because configuration now comes from the Connection Manager. */
export async function configured(): Promise<boolean> {
  return client.isConfigured();
}

async function assertConfigured(): Promise<void> {
  if (!(await configured())) throw errors.providerNotConfigured('DigitalOcean');
}

async function loadDroplets(): Promise<Droplet[]> {
  await assertConfigured();
  const wire = await client.listAll<DoDroplet>('/droplets', 'droplets');
  return wire.map(mapDroplet).sort((a, b) => a.name.localeCompare(b.name));
}

export interface CachedResult<T> {
  value: T;
  cachedAgeMs?: number;
  stale: boolean;
}

export async function listDroplets(
  user: AuthenticatedUser,
  filters: { environment?: Environment; search?: string } = {},
): Promise<CachedResult<Droplet[]>> {
  const result = await providerCache.wrap('do:droplets', CACHE.droplets, loadDroplets, {
    fallbackToStale: true,
  });

  const allowed = new Set(visibleEnvironments(user));
  let items = result.value.filter((droplet) => allowed.has(droplet.environment));

  if (filters.environment) {
    if (!allowed.has(filters.environment)) throw errors.environmentForbidden(filters.environment);
    items = items.filter((droplet) => droplet.environment === filters.environment);
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    items = items.filter(
      (droplet) =>
        droplet.name.toLowerCase().includes(needle) ||
        droplet.id.includes(needle) ||
        droplet.networks.publicIpv4?.includes(needle) ||
        droplet.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }

  return { ...result, value: items };
}

/**
 * Resolves one droplet and re-checks that the caller may see its environment.
 * Every action path goes through this, so a guessed droplet id in another
 * environment is rejected before any provider call is made.
 */
export async function getDroplet(user: AuthenticatedUser, dropletId: string): Promise<Droplet> {
  const { value } = await listDroplets(user);
  const droplet = value.find((candidate) => candidate.id === dropletId);
  if (!droplet) {
    // Not found and not visible are intentionally the same response.
    throw errors.notFound('Droplet');
  }
  return droplet;
}

export async function getDropletDetail(
  user: AuthenticatedUser,
  dropletId: string,
): Promise<{
  droplet: Droplet;
  backup: BackupState;
  snapshots: DoSnapshot[];
  volumes: DoVolume[];
  firewalls: DoFirewall[];
}> {
  // Authorisation gate: resolves the droplet from inventory and throws if the
  // caller may not see its environment. The mapped result below comes from a
  // fresh fetch, so the return value here is not needed.
  await getDroplet(user, dropletId);

  // The list endpoint's cached copy lacks backup ids on some plans, so the
  // detail view refetches the single droplet.
  const wire = await client.getOne<DoDroplet>(`/droplets/${encodeURIComponent(dropletId)}`, 'droplet');

  const [snapshots, volumes, firewalls] = await Promise.all([
    listDropletSnapshots(dropletId).catch((error) => {
      logger().warn({ err: error, dropletId }, 'droplet snapshots unavailable');
      return [] as DoSnapshot[];
    }),
    listVolumes().then((all) => all.filter((volume) => volume.attachedDropletIds.includes(dropletId))),
    listFirewalls().then((all) => all.filter((firewall) => firewall.dropletIds.includes(dropletId))),
  ]);

  const backup = mapDropletBackupState(wire);
  // Fill in a real timestamp when we can see one; otherwise leave it null rather
  // than implying a backup we have not verified.
  const latestBackup = snapshots
    .filter((snapshot) => snapshot.resourceType === 'droplet')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latestBackup) {
    backup.lastBackupAt = latestBackup.createdAt;
  }

  return { droplet: mapDroplet(wire), backup, snapshots, volumes, firewalls };
}

async function listDropletSnapshots(dropletId: string): Promise<DoSnapshot[]> {
  const wire = await client.listAll<DoSnapshotWire>(
    `/droplets/${encodeURIComponent(dropletId)}/snapshots`,
    'snapshots',
  );
  return wire.map(mapSnapshot);
}

export async function listVolumes(): Promise<DoVolume[]> {
  await assertConfigured();
  const result = await providerCache.wrap(
    'do:volumes',
    CACHE.volumes,
    async () => (await client.listAll<DoVolumeWire>('/volumes', 'volumes')).map(mapVolume),
    { fallbackToStale: true },
  );
  return result.value;
}

export async function listFirewalls(): Promise<DoFirewall[]> {
  await assertConfigured();
  const result = await providerCache.wrap(
    'do:firewalls',
    CACHE.firewalls,
    async () => (await client.listAll<DoFirewallWire>('/firewalls', 'firewalls')).map(mapFirewall),
    { fallbackToStale: true },
  );
  return result.value;
}

export async function listSnapshots(): Promise<DoSnapshot[]> {
  await assertConfigured();
  const result = await providerCache.wrap(
    'do:snapshots',
    CACHE.snapshots,
    async () => (await client.listAll<DoSnapshotWire>('/snapshots', 'snapshots')).map(mapSnapshot),
    { fallbackToStale: true },
  );
  return result.value;
}

export async function listFloatingIps(): Promise<DoFloatingIp[]> {
  await assertConfigured();
  const result = await providerCache.wrap(
    'do:floating-ips',
    CACHE.floatingIps,
    async () =>
      (await client.listAll<DoFloatingIpWire>('/floating_ips', 'floating_ips')).map(mapFloatingIp),
    { fallbackToStale: true },
  );
  return result.value;
}

/**
 * Droplet metrics from DigitalOcean's monitoring API.
 *
 * Memory, disk and load require the monitoring agent on the droplet. When it is
 * absent those metric keys land in `unavailable` instead of being reported as
 * zero, so the UI can say "not collected" rather than "0%".
 */
export async function getDropletMetrics(
  user: AuthenticatedUser,
  dropletId: string,
  rangeMinutes = 60,
): Promise<CachedResult<DropletMetrics>> {
  const droplet = await getDroplet(user, dropletId);
  const cacheKey = `do:metrics:${dropletId}:${rangeMinutes}`;

  return providerCache.wrap(
    cacheKey,
    CACHE.metrics,
    async () => {
      const end = Math.floor(Date.now() / 1000);
      const start = end - rangeMinutes * 60;
      const query = { host_id: dropletId, start: String(start), end: String(end) };
      const unavailable: string[] = [];

      const fetchMetricWithQuery = async (
        key: string,
        path: string,
        extra: Record<string, string> = {},
      ): Promise<DoMetricsResponse | null> => {
        try {
          return await client.getRaw<DoMetricsResponse>(path, { ...query, ...extra });
        } catch (error) {
          unavailable.push(key);
          logger().debug({ err: error, dropletId, metric: key }, 'droplet metric unavailable');
          return null;
        }
      };

      const fetchMetric = (key: string, path: string) => fetchMetricWithQuery(key, path);

      const [cpu, memoryAvailable, memoryTotal, diskFree, diskSize, load1, networkIn, networkOut] =
        await Promise.all([
          fetchMetric('cpu', '/monitoring/metrics/droplet/cpu'),
          fetchMetric('memory', '/monitoring/metrics/droplet/memory_available'),
          fetchMetric('memory', '/monitoring/metrics/droplet/memory_total'),
          fetchMetric('disk', '/monitoring/metrics/droplet/filesystem_free'),
          fetchMetric('disk', '/monitoring/metrics/droplet/filesystem_size'),
          fetchMetric('load', '/monitoring/metrics/droplet/load_1'),
          // Inbound and outbound come from the same endpoint with a direction
          // parameter; both are requested so a partial failure is visible.
          fetchMetricWithQuery('network_in', '/monitoring/metrics/droplet/bandwidth', {
            interface: 'public',
            direction: 'inbound',
          }),
          fetchMetricWithQuery('network_out', '/monitoring/metrics/droplet/bandwidth', {
            interface: 'public',
            direction: 'outbound',
          }),
        ]);

      const raw: RawMetricSet = {
        cpu,
        memoryAvailable,
        memoryTotal,
        diskFree,
        diskSize,
        load1,
        networkIn,
        networkOut,
        unavailable: [...new Set(unavailable)],
      };

      if (!droplet.monitoringEnabled && raw.unavailable.length === 0) {
        raw.unavailable.push('agent_not_installed');
      }

      return mapDropletMetrics(dropletId, raw);
    },
    { fallbackToStale: true },
  );
}

// ------------------------------------------------------------- operations ----

/**
 * The complete set of droplet actions the console can issue. The caller passes
 * an operation key that has already been authorised; this map is what turns it
 * into a provider call. Anything not listed here cannot be sent to DigitalOcean.
 */
const DROPLET_ACTIONS = {
  reboot_droplet: { type: 'reboot' },
  power_on_droplet: { type: 'power_on' },
  power_off_droplet: { type: 'power_off' },
  snapshot_droplet: { type: 'snapshot' },
} as const;

export type DropletActionKey = keyof typeof DROPLET_ACTIONS;

export function isDropletAction(key: string): key is DropletActionKey {
  return key in DROPLET_ACTIONS;
}

export async function executeDropletAction(
  user: AuthenticatedUser,
  key: DropletActionKey,
  dropletId: string,
): Promise<{ providerActionId: string; status: string; droplet: Droplet }> {
  // Re-resolve the droplet: this is the check that the id belongs to an
  // environment the operator may act in, regardless of what the client claimed.
  const droplet = await getDroplet(user, dropletId);
  const action = DROPLET_ACTIONS[key];

  const body =
    action.type === 'snapshot'
      ? { type: 'snapshot', name: `${droplet.name}-console-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}` }
      : { type: action.type };

  const result = await client.postDropletAction(dropletId, body);

  // Inventory is now stale.
  providerCache.invalidate('do:droplets');
  providerCache.invalidate(`do:metrics:${dropletId}`, true);

  return { providerActionId: String(result.id), status: result.status, droplet };
}

export async function pollAction(actionId: string): Promise<{ status: string }> {
  const action = await client.getAction(actionId);
  return { status: action.status };
}

// ----------------------------------------------------------------- health ----

export async function health(): Promise<SubsystemHealth> {
  const base = {
    key: 'digitalocean',
    label: 'DigitalOcean',
    configured: await configured(),
    lastCheckedAt: new Date().toISOString(),
  };

  if (!(await configured())) {
    return {
      ...base,
      state: 'unknown',
      detail: 'No API token configured.',
      lastSuccessAt: null,
      latencyMs: null,
    };
  }

  const started = Date.now();
  try {
    // /account is the cheapest authenticated call and confirms token validity.
    await client.getRaw('/account');
    return {
      ...base,
      state: 'healthy',
      detail: 'API reachable.',
      lastSuccessAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      ...base,
      state: 'down',
      detail: message,
      lastSuccessAt: client.lastSuccessAt(),
      latencyMs: null,
    };
  }
}
