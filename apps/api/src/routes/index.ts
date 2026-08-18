import type { FastifyInstance } from 'fastify';
import { operationRequestSchema } from '@airaos/validation';
import { ok, noStore } from '../utils/reply.js';
import { parse } from '../utils/validate.js';
import { requireUser } from '../auth/plugin.js';
import { visibleEnvironments } from '../rbac/index.js';
import * as dashboard from '../services/dashboard.js';
import * as operations from '../services/operations.js';
import { registerHealthRoutes } from './health.js';
import { registerAuthRoutes } from './auth.js';
import {
  registerDigitalOceanRoutes,
  registerNetworkRoutes,
  registerProxmoxRoutes,
} from './infrastructure.js';
import {
  registerApplicationRoutes,
  registerContainerRoutes,
  registerDeploymentRoutes,
} from './applications.js';
import { registerConnectionRoutes } from './connections.js';
import { registerDatabaseRoutes } from './databases.js';
import {
  registerAlertRoutes,
  registerLogRoutes,
  registerMonitoringRoutes,
} from './observability.js';
import { registerAuditRoutes, registerSettingsRoutes, registerUserRoutes } from './admin.js';

/**
 * API surface (spec section 32).
 *
 *   /health*                     unauthenticated liveness / readiness
 *   /api/v1/auth                 sign-in, session, sign-out
 *   /api/v1/dashboard            aggregated overview
 *   /api/v1/digitalocean         droplets, volumes, firewalls, snapshots
 *   /api/v1/proxmox              cluster, nodes, guests, storage
 *   /api/v1/network              addresses, floating IPs, firewall rules
 *   /api/v1/applications         registry + health
 *   /api/v1/containers           allowlisted container status
 *   /api/v1/deployments          deployment records + approval
 *   /api/v1/monitoring           metric presets, Redis overview
 *   /api/v1/alerts               alerts + acknowledgement
 *   /api/v1/logs                 search, export, live tail
 *   /api/v1/databases            connections, explorer, browser, SQL editor
 *   /api/v1/operations           the single allowlisted-operation endpoint
 *   /api/v1/audit                audit trail + chain verification
 *   /api/v1/users                users and roles
 *   /api/v1/settings             console policy + runtime summary
 *   /api/v1/connections          the central Connection Manager
 *
 * There is no /execute, no provider passthrough, and no route that accepts a
 * shell command, container exec, or arbitrary provider path (rules 2, 3).
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerHealthRoutes(app);

  await app.register(
    async (api) => {
      await api.register(registerAuthRoutes, { prefix: '/auth' });

      api.get('/dashboard', { preHandler: api.requirePermission('infra.view') }, async (request, reply) => {
        const user = requireUser(request);
        noStore(reply);
        return ok(request, await dashboard.overview(user));
      });

      await api.register(registerDigitalOceanRoutes, { prefix: '/digitalocean' });
      await api.register(registerProxmoxRoutes, { prefix: '/proxmox' });
      await api.register(registerNetworkRoutes, { prefix: '/network' });
      await api.register(registerApplicationRoutes, { prefix: '/applications' });
      await api.register(registerContainerRoutes, { prefix: '/containers' });
      await api.register(registerDeploymentRoutes, { prefix: '/deployments' });
      await api.register(registerMonitoringRoutes, { prefix: '/monitoring' });
      await api.register(registerAlertRoutes, { prefix: '/alerts' });
      await api.register(registerLogRoutes, { prefix: '/logs' });
      await api.register(registerDatabaseRoutes, { prefix: '/databases' });
      await api.register(registerAuditRoutes, { prefix: '/audit' });
      await api.register(registerUserRoutes, { prefix: '/users' });
      await api.register(registerSettingsRoutes, { prefix: '/settings' });
      await api.register(registerConnectionRoutes, { prefix: '/connections' });

      await api.register(registerOperationRoutes, { prefix: '/operations' });
    },
    { prefix: '/api/v1' },
  );
}

/**
 * The operations endpoint.
 *
 * One route handles every privileged action, because the authorisation,
 * confirmation, environment re-resolution and audit logic must be identical for
 * all of them — and a single chokepoint is auditable in a way that fifteen
 * scattered handlers are not.
 */
async function registerOperationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What the current operator may do in an environment. Advisory: the UI uses it
   * to decide what to render, and the answer is recomputed on execution.
   */
  app.get('/capabilities', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    noStore(reply);
    return ok(request, {
      environments: visibleEnvironments(user).map((environment) => ({
        environment,
        operations: operations.capabilities(user, environment),
      })),
    });
  });

  app.get('/recent', { preHandler: app.requirePermission('infra.view') }, async (request, reply) => {
    const user = requireUser(request);
    noStore(reply);
    return ok(request, { items: await operations.recentOperations(user) });
  });

  app.post(
    '/',
    {
      // Only requires a session here: the operation's own permission is checked
      // inside execute(), which knows the resolved resource's environment.
      preHandler: app.authenticate,
      config: {
        // Privileged actions get a tighter budget than reads.
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = parse(operationRequestSchema, request.body);

      const result = await operations.execute(request, user, {
        key: body.key,
        resourceId: body.resourceId,
        claimedEnvironment: body.environment,
        confirmation: body.confirmation,
        reason: body.reason,
        metadata: body.metadata,
      });

      noStore(reply);
      return ok(request, result);
    },
  );
}
