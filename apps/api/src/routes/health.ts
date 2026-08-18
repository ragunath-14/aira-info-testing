import type { FastifyInstance } from 'fastify';
import type { SelfHealthReport } from '@airaos/types';
import { config } from '../config.js';
import { pingDatabase } from '../db/pool.js';
import { reapIdlePools } from '../providers/databases/connection-manager.js';
import * as digitalocean from '../providers/digitalocean/service.js';
import * as proxmox from '../providers/proxmox/service.js';
import * as prometheus from '../providers/prometheus/service.js';
import * as redisProvider from '../providers/redis/service.js';

/**
 * The console's own health endpoints (spec section 50).
 *
 * Unauthenticated by design so a load balancer can reach them, and therefore
 * deliberately sparse: `/health/live` says only whether the process is up, and
 * neither endpoint reveals hostnames, versions of dependencies, or error detail
 * that would help someone map the estate.
 *
 *   /health       — summary, suitable for a status page
 *   /health/live  — process liveness; never touches a dependency
 *   /health/ready — readiness: refuses traffic if the console database is down
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const startedAt = Date.now();

  app.get('/health/live', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) };
  });

  app.get('/health/ready', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const database = await pingDatabase();
    if (!database.ok) {
      // Not ready: the console cannot authenticate or audit without its database,
      // so serving traffic would mean serving unaudited requests.
      return reply.status(503).send({ status: 'error', checks: { database: 'error' } });
    }
    return { status: 'ok', checks: { database: 'ok' } };
  });

  app.get('/health', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const cfg = config();

    // Piggyback pool housekeeping on the health poll rather than running a timer.
    void reapIdlePools();

    const database = await pingDatabase();

    const checks: SelfHealthReport['checks'] = [
      {
        name: 'console_database',
        status: database.ok ? 'ok' : 'error',
        latencyMs: database.latencyMs,
        detail: database.ok ? null : 'unreachable',
      },
    ];

    // Provider probes are summarised without their messages: this endpoint is
    // reachable without authentication.
    const providerProbes: Array<[string, boolean, () => Promise<{ state: string; latencyMs: number | null }>]> = [
      ['digitalocean', cfg.providers.digitalocean, () => digitalocean.health()],
      ['proxmox', cfg.providers.proxmox, () => proxmox.health()],
      ['prometheus', cfg.providers.prometheus, () => prometheus.health()],
      ['redis', cfg.providers.redis, () => redisProvider.health()],
    ];

    await Promise.all(
      providerProbes.map(async ([name, isConfigured, probe]) => {
        if (!isConfigured) {
          checks.push({ name, status: 'skipped', latencyMs: null, detail: 'not configured' });
          return;
        }
        try {
          const result = await probe();
          checks.push({
            name,
            status: result.state === 'healthy' ? 'ok' : result.state === 'degraded' ? 'degraded' : 'error',
            latencyMs: result.latencyMs,
            detail: null,
          });
        } catch {
          checks.push({ name, status: 'error', latencyMs: null, detail: null });
        }
      }),
    );

    const hasError = checks.some((check) => check.status === 'error');
    const hasDegraded = checks.some((check) => check.status === 'degraded');

    const report: SelfHealthReport = {
      // A provider outage is degraded, not error: the console itself still works
      // and should keep serving the pages that do not depend on that provider.
      status: !database.ok ? 'error' : hasError || hasDegraded ? 'degraded' : 'ok',
      version: process.env.APP_VERSION ?? '1.0.0',
      environment: cfg.APP_ENV,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
      checkedAt: new Date().toISOString(),
    };

    return reply.status(report.status === 'error' ? 503 : 200).send(report);
  });
}
