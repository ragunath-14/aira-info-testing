import type {
  AuthenticatedUser,
  DashboardOverview,
  Environment,
  SubsystemHealth,
} from '@airaos/types';
import { ENVIRONMENTS } from '@airaos/types';
import { logger } from '../utils/logger.js';
import { visibleEnvironments } from '../rbac/index.js';
import { pingDatabase } from '../db/pool.js';
import * as digitalocean from '../providers/digitalocean/service.js';
import * as proxmox from '../providers/proxmox/service.js';
import * as prometheus from '../providers/prometheus/service.js';
import * as alertmanager from '../providers/alertmanager/service.js';
import * as redisProvider from '../providers/redis/service.js';
import * as docker from '../providers/docker/service.js';
import * as connections from '../providers/databases/connection-manager.js';
import * as introspection from '../providers/databases/introspection.js';
import * as applications from './applications.js';
import * as deployments from './deployments.js';

/**
 * The unified overview (spec section 5).
 *
 * Two rules shape this:
 *
 *  1. Everything runs concurrently and no single provider outage can fail the
 *     page. A subsystem that cannot be reached reports `down`; one that is not
 *     configured reports `unknown`.
 *  2. The health score is computed only over subsystems that actually reported.
 *     Unconfigured or unreachable subsystems are listed in
 *     `unreportedSubsystems` rather than being counted as healthy, so the number
 *     never flatters a half-monitored estate.
 */

export async function overview(user: AuthenticatedUser): Promise<DashboardOverview> {
  const allowed = visibleEnvironments(user);

  const [
    consoleDb,
    doHealth,
    pveHealth,
    promHealth,
    amHealth,
    redisHealth,
    dockerHealth,
    appHealth,
    droplets,
    proxmoxInventory,
    appStatuses,
    dbSummary,
    alertCounts,
    recentAlerts,
    deployingCount,
  ] = await Promise.all([
    pingDatabase(),
    safe(() => digitalocean.health(), 'digitalocean', 'DigitalOcean'),
    safe(() => proxmox.health(), 'proxmox', 'Proxmox'),
    safe(() => prometheus.health(), 'prometheus', 'Prometheus'),
    safe(() => alertmanager.health(), 'alertmanager', 'Alertmanager'),
    safe(() => redisProvider.health(), 'redis', 'Redis'),
    safe(() => docker.health(), 'docker', 'Containers'),
    safe(() => applications.health(user), 'applications', 'Applications'),
    // `configured()` resolves from the Connection Manager now, so the guard is
    // folded into the promise rather than evaluated synchronously.
    digitalocean
      .configured()
      .then((yes) =>
        yes ? digitalocean.listDroplets(user).then((result) => result.value) : null,
      )
      .catch(() => null),
    proxmox
      .configured()
      .then((yes) => (yes ? proxmox.getInventory(user).then((result) => result.value) : null))
      .catch(() => null),
    applications.statuses(user).then((result) => result.items).catch(() => []),
    databaseSummary(allowed),
    alertmanager.counts(allowed),
    alertmanager
      .listAlerts({ visibleEnvironments: allowed, state: 'firing' })
      .then((result) => result.items.slice(0, 8))
      .catch(() => []),
    deployments.countDeploying(user).catch(() => 0),
  ]);

  const subsystems: SubsystemHealth[] = [
    {
      key: 'console_database',
      label: 'Console database',
      state: consoleDb.ok ? 'healthy' : 'down',
      detail: consoleDb.ok ? 'Reachable.' : (consoleDb.detail ?? 'Unreachable.'),
      configured: true,
      lastCheckedAt: new Date().toISOString(),
      lastSuccessAt: consoleDb.ok ? new Date().toISOString() : null,
      latencyMs: consoleDb.latencyMs,
    },
    doHealth,
    pveHealth,
    appHealth,
    dockerHealth,
    dbSummary.health,
    redisHealth,
    promHealth,
    amHealth,
  ];

  const reported = subsystems.filter(
    (subsystem) => subsystem.configured && subsystem.state !== 'unknown',
  );
  const unreported = subsystems.filter(
    (subsystem) => !subsystem.configured || subsystem.state === 'unknown',
  );

  const healthScore =
    reported.length === 0
      ? 0
      : Math.round(
          (reported.reduce(
            (total, subsystem) =>
              total + (subsystem.state === 'healthy' ? 1 : subsystem.state === 'degraded' ? 0.5 : 0),
            0,
          ) /
            reported.length) *
            100,
        );

  const dropletsByEnvironment = Object.fromEntries(
    ENVIRONMENTS.map((environment) => [
      environment,
      (droplets ?? []).filter((droplet) => droplet.environment === environment).length,
    ]),
  ) as Record<Environment, number>;

  return {
    generatedAt: new Date().toISOString(),
    healthScore,
    unreportedSubsystems: unreported.map((subsystem) => subsystem.label),
    subsystems,
    digitalocean: {
      configured: await digitalocean.configured(),
      dropletTotal: droplets?.length ?? 0,
      dropletActive: (droplets ?? []).filter((droplet) => droplet.status === 'active').length,
      dropletOff: (droplets ?? []).filter((droplet) => droplet.status === 'off').length,
      byEnvironment: dropletsByEnvironment,
      regions: [...new Set((droplets ?? []).map((droplet) => droplet.region.slug))].sort(),
    },
    proxmox: {
      configured: await proxmox.configured(),
      clusterName: proxmoxInventory?.cluster.name ?? null,
      nodeTotal: proxmoxInventory?.nodes.length ?? 0,
      nodeOnline: (proxmoxInventory?.nodes ?? []).filter((node) => node.status === 'online').length,
      qemuRunning: (proxmoxInventory?.guests ?? []).filter(
        (guest) => guest.type === 'qemu' && guest.status === 'running',
      ).length,
      qemuTotal: (proxmoxInventory?.guests ?? []).filter((guest) => guest.type === 'qemu').length,
      lxcRunning: (proxmoxInventory?.guests ?? []).filter(
        (guest) => guest.type === 'lxc' && guest.status === 'running',
      ).length,
      lxcTotal: (proxmoxInventory?.guests ?? []).filter((guest) => guest.type === 'lxc').length,
    },
    applications: {
      total: appStatuses.length,
      healthy: appStatuses.filter((status) => status.health.state === 'healthy').length,
      degraded: appStatuses.filter((status) => status.health.state === 'degraded').length,
      down: appStatuses.filter((status) => status.health.state === 'down').length,
      unknown: appStatuses.filter((status) => status.health.state === 'unknown').length,
      deploying: deployingCount,
    },
    databases: dbSummary.summary,
    redis: {
      configured: redisHealth.configured,
      reachable: redisHealth.state === 'healthy',
    },
    alerts: alertCounts,
    recentAlerts,
  };
}

/**
 * Wraps a health probe so a thrown error becomes a `down` report rather than
 * failing the whole dashboard.
 */
async function safe(
  probe: () => Promise<SubsystemHealth>,
  key: string,
  label: string,
): Promise<SubsystemHealth> {
  try {
    return await probe();
  } catch (error) {
    logger().debug({ err: error, subsystem: key }, 'subsystem health probe threw');
    return {
      key,
      label,
      state: 'down',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Health check failed.',
      configured: true,
      lastCheckedAt: new Date().toISOString(),
      lastSuccessAt: null,
      latencyMs: null,
    };
  }
}

/**
 * Database roll-up. Reachability is probed per connection; sizes are summed only
 * across connections that answered, and the total is null if none did — rather
 * than reporting 0 bytes for an unreachable estate.
 */
async function databaseSummary(allowed: Environment[]): Promise<{
  summary: DashboardOverview['databases'];
  health: SubsystemHealth;
}> {
  const checkedAt = new Date().toISOString();

  try {
    const registered = await connections.listConnections(allowed);

    if (registered.length === 0) {
      return {
        summary: {
          total: 0,
          reachable: 0,
          unreachable: 0,
          productionReadOnly: true,
          totalSizeBytes: null,
        },
        health: {
          key: 'databases',
          label: 'Databases',
          state: 'unknown',
          detail: 'No database connections registered.',
          configured: false,
          lastCheckedAt: checkedAt,
          lastSuccessAt: null,
          latencyMs: null,
        },
      };
    }

    const statuses = await Promise.all(
      registered.map((connection) =>
        introspection.connectionStatus(connection).catch(() => null),
      ),
    );

    const reachable = statuses.filter((status) => status?.state === 'healthy');
    const sizes = reachable
      .map((status) => status?.databaseSizeBytes)
      .filter((size): size is number => typeof size === 'number');

    const productionConnections = registered.filter(
      (connection) => connection.environment === 'production',
    );
    // True when every production connection is read-only, which is the state the
    // console guarantees by default.
    const productionReadOnly = productionConnections.every(
      (connection) => connection.readOnlyOverride !== false,
    );

    return {
      summary: {
        total: registered.length,
        reachable: reachable.length,
        unreachable: registered.length - reachable.length,
        productionReadOnly,
        totalSizeBytes: sizes.length > 0 ? sizes.reduce((total, size) => total + size, 0) : null,
      },
      health: {
        key: 'databases',
        label: 'Databases',
        state:
          reachable.length === registered.length
            ? 'healthy'
            : reachable.length === 0
              ? 'down'
              : 'degraded',
        detail: `${reachable.length}/${registered.length} connection(s) reachable.`,
        configured: true,
        lastCheckedAt: checkedAt,
        lastSuccessAt: reachable.length > 0 ? checkedAt : null,
        latencyMs: null,
      },
    };
  } catch (error) {
    logger().warn({ err: error }, 'database summary failed');
    return {
      summary: {
        total: 0,
        reachable: 0,
        unreachable: 0,
        productionReadOnly: true,
        totalSizeBytes: null,
      },
      health: {
        key: 'databases',
        label: 'Databases',
        state: 'unknown',
        detail: 'Database status could not be determined.',
        configured: true,
        lastCheckedAt: checkedAt,
        lastSuccessAt: null,
        latencyMs: null,
      },
    };
  }
}
