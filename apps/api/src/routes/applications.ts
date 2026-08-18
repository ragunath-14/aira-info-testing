import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  applicationUpsertSchema,
  deploymentApprovalSchema,
  environmentSchema,
  uuidSchema,
} from '@airaos/validation';
import { errors } from '../utils/errors.js';
import { ok, noStore } from '../utils/reply.js';
import { parse } from '../utils/validate.js';
import { requireUser } from '../auth/plugin.js';
import * as audit from '../audit/service.js';
import * as applications from '../services/applications.js';
import * as deployments from '../services/deployments.js';
import * as operations from '../services/operations.js';
import * as logs from '../services/logs.js';
import * as docker from '../providers/docker/service.js';

/**
 * Applications, containers and deployments.
 *
 * Container routes deliberately expose status and restart only. There is no exec,
 * no image control, and no route that accepts a container name outside the
 * allowlist (rule 3).
 */
export async function registerApplicationRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('application.view') };

  app.get('/', view, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(
      z.object({
        environment: environmentSchema.optional(),
        search: z.string().max(200).optional(),
      }),
      request.query,
    );

    const result = await applications.statuses(user, query);
    noStore(reply);
    return ok(request, { items: result.items }, { cachedAgeMs: result.cachedAgeMs });
  });

  app.get('/:applicationId', view, async (request, reply) => {
    const user = requireUser(request);
    const { applicationId } = parse(z.object({ applicationId: uuidSchema }), request.params);
    const application = await applications.requireApplication(user, applicationId);

    const [health, container, releases, rollback, recentLogs, deploymentHistory] = await Promise.all([
      applications.probe(application),
      application.containerName
        ? docker.getContainer(application.containerName).catch(() => null)
        : Promise.resolve(null),
      deployments.releaseCandidates(application),
      deployments.rollbackTarget(application),
      logs
        .search(user, {
          sources: [application.key, ...(application.containerName ? [application.containerName] : [])],
          kinds: [],
          environments: [application.environment],
          levels: [],
          search: null,
          from: null,
          to: null,
          limit: 50,
          cursor: null,
          errorsOnly: false,
        })
        .then((result) => result.items)
        .catch(() => []),
      deployments.listDeployments(user, { applicationId, page: 1, pageSize: 10 }),
    ]);

    noStore(reply);
    return ok(request, {
      application,
      health,
      container,
      releases,
      rollbackTarget: rollback,
      recentLogs,
      deployments: deploymentHistory.items,
      capabilities: operations
        .capabilities(user, application.environment)
        .filter((entry) =>
          ['restart_service', 'start_service', 'stop_service', 'restart_worker', 'deploy_release', 'rollback_release'].includes(
            entry.key,
          ),
        ),
    });
  });

  /** Registry editing sits behind settings.manage, not application.view. */
  app.put('/', { preHandler: app.requirePermission('settings.manage') }, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(applicationUpsertSchema, request.body);

    if (!user.environments.includes(body.environment)) {
      throw errors.environmentForbidden(body.environment);
    }

    const application = await applications.upsertApplication(body);

    await audit.record(request, {
      action: 'UPSERT_APPLICATION',
      resourceKind: 'application',
      resourceId: application.id,
      resourceLabel: application.name,
      environment: application.environment,
      result: 'success',
      message: `Registry entry for ${application.key} saved.`,
      metadata: { operationsEnabled: application.operationsEnabled },
    });

    noStore(reply);
    return ok(request, application);
  });
}

export async function registerContainerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: app.requirePermission('application.view') }, async (request, reply) => {
    noStore(reply);

    if (!docker.configured()) {
      return ok(request, {
        items: [],
        configured: false,
        // Explains an empty list instead of implying nothing is running.
        note: 'Container control is not configured on this console instance (DOCKER_SOCKET_PATH is unset).',
        allowlist: [],
      });
    }

    const result = await docker.listContainers();
    return ok(
      request,
      {
        items: result.value,
        configured: true,
        note: null,
        // Shown in the UI so it is obvious which containers the console can see.
        allowlist: docker.allowedContainers(),
      },
      { cachedAgeMs: result.cachedAgeMs },
    );
  });

  app.get('/:name/logs', { preHandler: app.requirePermission('logs.view') }, async (request, reply) => {
    const { name } = parse(
      z.object({ name: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/) }),
      request.params,
    );
    const { environment, lines } = parse(
      z.object({
        environment: environmentSchema.default('development'),
        lines: z.coerce.number().int().min(10).max(2000).default(200),
      }),
      request.query,
    );

    // docker.tailContainer applies the allowlist; an unlisted name 404s.
    noStore(reply);
    return ok(request, { items: await logs.tailContainer(name, environment, lines) });
  });
}

export async function registerDeploymentRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('application.view') };

  app.get('/', view, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(
      z.object({
        applicationId: uuidSchema.optional(),
        environment: environmentSchema.optional(),
        status: z
          .enum(['pending', 'awaiting_approval', 'running', 'succeeded', 'failed', 'rolled_back', 'cancelled'])
          .optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      request.query,
    );

    noStore(reply);
    return ok(request, await deployments.listDeployments(user, query));
  });

  app.get('/:deploymentId', view, async (request, reply) => {
    const user = requireUser(request);
    const { deploymentId } = parse(z.object({ deploymentId: uuidSchema }), request.params);
    const deployment = await deployments.getDeployment(user, deploymentId);

    noStore(reply);
    return ok(request, {
      deployment,
      logs: await logs.deploymentLogs(deploymentId),
    });
  });

  /**
   * Production approval. Requires `application.deploy.production` and a different
   * operator from the one who requested the deployment.
   */
  app.post(
    '/:deploymentId/approval',
    { preHandler: app.requirePermission('application.deploy.production') },
    async (request, reply) => {
      const user = requireUser(request);
      const { deploymentId } = parse(z.object({ deploymentId: uuidSchema }), request.params);
      const body = parse(deploymentApprovalSchema.omit({ deploymentId: true }), request.body);

      const before = await deployments.getDeployment(user, deploymentId);
      const updated = await deployments.decideApproval(user, deploymentId, body.approve, body.note);

      await audit.record(request, {
        action: body.approve ? 'APPROVE_PRODUCTION_DEPLOYMENT' : 'REJECT_PRODUCTION_DEPLOYMENT',
        resourceKind: 'deployment',
        resourceId: deploymentId,
        resourceLabel: `${before.applicationKey} ${before.version}`,
        environment: before.environment,
        result: 'success',
        message: body.approve
          ? `Approved ${before.version} for production.`
          : `Rejected ${before.version}.`,
        metadata: { requestedBy: before.triggeredByEmail, note: body.note },
      });

      noStore(reply);
      return ok(request, updated);
    },
  );

  /**
   * CI callback that moves a deployment through its lifecycle.
   *
   * Guarded by `application.deploy` rather than being a public webhook: the CI
   * runner authenticates as a console service identity, which keeps this off the
   * list of unauthenticated state-changing endpoints.
   */
  app.post(
    '/:deploymentId/status',
    { preHandler: app.requirePermission('application.deploy') },
    async (request, reply) => {
      const user = requireUser(request);
      const { deploymentId } = parse(z.object({ deploymentId: uuidSchema }), request.params);
      const body = parse(
        z.object({
          status: z.enum(['running', 'succeeded', 'failed', 'rolled_back', 'cancelled']),
          message: z.string().max(2000).optional(),
          ciRunUrl: z.string().url().max(500).optional(),
          logs: z.string().max(500_000).optional(),
        }),
        request.body,
      );

      const deployment = await deployments.getDeployment(user, deploymentId);
      if (deployment.environment === 'production' && !deployment.approvedByUserId) {
        throw errors.approvalRequired(
          'This production deployment has not been approved, so its status cannot be advanced.',
        );
      }

      await deployments.updateStatus(deploymentId, body.status, {
        message: body.message ?? null,
        ciRunUrl: body.ciRunUrl ?? null,
        logs: body.logs ?? null,
      });

      if (body.logs) {
        await logs.ingest({
          level: body.status === 'failed' ? 'error' : 'info',
          kind: 'deployment',
          environment: deployment.environment,
          source: deployment.applicationKey,
          message: body.logs.slice(0, 10_000),
          requestId: request.id,
          deploymentId,
        });
      }

      await audit.record(request, {
        action: 'UPDATE_DEPLOYMENT_STATUS',
        resourceKind: 'deployment',
        resourceId: deploymentId,
        resourceLabel: `${deployment.applicationKey} ${deployment.version}`,
        environment: deployment.environment,
        result: body.status === 'failed' ? 'failure' : 'success',
        message: `Deployment status set to ${body.status}.`,
      });

      noStore(reply);
      return ok(request, await deployments.getDeployment(user, deploymentId));
    },
  );
}
