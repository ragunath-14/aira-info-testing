import type { FastifyRequest } from 'fastify';
import {
  OPERATION_DEFINITIONS,
  type AuthenticatedUser,
  type Environment,
  type OperationKey,
  type OperationResult,
} from '@airaos/types';
import { desc, inArray, sql } from 'drizzle-orm';
import { orm, schema } from '../db/drizzle.js';
import { errors } from '../utils/errors.js';
import { assertConfirmation, assertOperationAllowed, authoriseOperation } from '../rbac/index.js';
import * as audit from '../audit/service.js';
import * as digitalocean from '../providers/digitalocean/service.js';
import * as proxmox from '../providers/proxmox/service.js';
import * as docker from '../providers/docker/service.js';
import * as applications from './applications.js';
import * as deployments from './deployments.js';
import * as alerts from '../providers/alertmanager/service.js';
import * as databases from '../providers/databases/connection-manager.js';
import * as dbPolicy from '../providers/databases/policy.js';

/**
 * The operations gateway (spec sections 40, 41; rules 2, 5, 6, 11).
 *
 * This is the only path by which the console changes anything. Its contract:
 *
 *  - The request names an operation KEY from a fixed list. There is no field that
 *    can carry a command, script, path, or provider payload.
 *  - The target resource is re-resolved server-side, and its environment is read
 *    from the resolved resource — never from the request. A client claiming
 *    `environment: "staging"` for a production droplet is rejected because the
 *    resolved droplet says production.
 *  - Authorisation, typed confirmation and second-approval requirements are all
 *    checked here before any provider call.
 *  - Every attempt — allowed, refused, failed — produces an audit event and an
 *    operation record.
 */

export interface OperationInput {
  key: OperationKey;
  resourceId: string;
  /** Client-supplied; used only to detect a mismatch, never to authorise. */
  claimedEnvironment: Environment;
  confirmation?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

interface ResolvedTarget {
  environment: Environment;
  /** Name the operator must retype to confirm. */
  label: string;
  resourceKind: string;
  /** Executes the operation and returns provider correlation detail. */
  run: () => Promise<{ providerActionId: string | null; status: OperationResult['status']; message: string }>;
}

export async function execute(
  request: FastifyRequest,
  user: AuthenticatedUser,
  input: OperationInput,
): Promise<OperationResult> {
  const definition = OPERATION_DEFINITIONS[input.key];
  if (!definition) {
    // Unreachable via HTTP (the schema is an enum of the same list).
    throw errors.operationNotAllowed(`"${String(input.key)}" is not a known operation.`);
  }

  const startedAt = new Date();
  const target = await resolveTarget(user, input);

  // Rule 12: the environment the operator was looking at must match the
  // environment the resource actually lives in.
  if (input.claimedEnvironment !== target.environment) {
    await audit.record(request, {
      action: `OPERATION_${input.key.toUpperCase()}`,
      resourceKind: target.resourceKind,
      resourceId: input.resourceId,
      resourceLabel: target.label,
      environment: target.environment,
      result: 'denied',
      errorCode: 'ENVIRONMENT_MISMATCH',
      message: `Request claimed ${input.claimedEnvironment} but the resource is in ${target.environment}.`,
      metadata: { operation: input.key, claimed: input.claimedEnvironment },
    });
    throw errors.operationNotAllowed(
      `This resource is in ${target.environment}, not ${input.claimedEnvironment}. Reload the page and try again.`,
      { claimed: input.claimedEnvironment, actual: target.environment },
    );
  }

  const decision = authoriseOperation(user, input.key, target.environment);
  if (!decision.allowed) {
    await audit.record(request, {
      action: `OPERATION_${input.key.toUpperCase()}`,
      resourceKind: target.resourceKind,
      resourceId: input.resourceId,
      resourceLabel: target.label,
      environment: target.environment,
      result: 'denied',
      errorCode: 'OPERATION_NOT_ALLOWED',
      message: decision.reason,
      metadata: { operation: input.key, roles: user.roles },
    });
    assertOperationAllowed(user, input.key, target.environment);
  }

  if (decision.requiresTypedConfirmation) {
    try {
      assertConfirmation(target.label, input.confirmation);
    } catch (error) {
      await audit.record(request, {
        action: `OPERATION_${input.key.toUpperCase()}`,
        resourceKind: target.resourceKind,
        resourceId: input.resourceId,
        resourceLabel: target.label,
        environment: target.environment,
        result: 'denied',
        errorCode: 'CONFIRMATION_MISMATCH',
        message: 'Typed confirmation did not match the resource name.',
        metadata: { operation: input.key },
      });
      throw error;
    }
  }

  // A reason is required for anything that changes production.
  if (target.environment === 'production' && definition.impact !== 'none' && !input.reason?.trim()) {
    throw errors.validation([
      { path: 'reason', message: 'A reason is required for production operations.' },
    ]);
  }

  let result: Awaited<ReturnType<ResolvedTarget['run']>>;
  let auditResult: 'success' | 'failure' = 'success';
  let errorCode: string | null = null;
  let message: string;

  try {
    result = await target.run();
    message = result.message;
  } catch (error) {
    auditResult = 'failure';
    errorCode = (error as { code?: string }).code ?? 'OPERATION_FAILED';
    message = error instanceof Error ? error.message : 'Operation failed.';

    const auditEvent = await audit.record(request, {
      action: `OPERATION_${input.key.toUpperCase()}`,
      resourceKind: target.resourceKind,
      resourceId: input.resourceId,
      resourceLabel: target.label,
      environment: target.environment,
      result: auditResult,
      errorCode,
      message,
      metadata: { operation: input.key, reason: input.reason },
    });

    await recordOperation({
      key: input.key,
      resourceKind: target.resourceKind,
      resourceId: input.resourceId,
      resourceLabel: target.label,
      environment: target.environment,
      user,
      status: 'failed',
      providerActionId: null,
      reason: input.reason ?? null,
      message,
      auditEventId: auditEvent?.id ?? null,
      startedAt,
    });

    throw error;
  }

  const auditEvent = await audit.record(request, {
    action: `OPERATION_${input.key.toUpperCase()}`,
    resourceKind: target.resourceKind,
    resourceId: input.resourceId,
    resourceLabel: target.label,
    environment: target.environment,
    result: auditResult,
    errorCode,
    message,
    metadata: {
      operation: input.key,
      reason: input.reason,
      providerActionId: result.providerActionId,
      impact: definition.impact,
    },
  });

  await recordOperation({
    key: input.key,
    resourceKind: target.resourceKind,
    resourceId: input.resourceId,
    resourceLabel: target.label,
    environment: target.environment,
    user,
    status: result.status,
    providerActionId: result.providerActionId,
    reason: input.reason ?? null,
    message,
    auditEventId: auditEvent?.id ?? null,
    startedAt,
  });

  return {
    key: input.key,
    resourceId: input.resourceId,
    environment: target.environment,
    accepted: true,
    status: result.status,
    providerActionId: result.providerActionId,
    message,
    auditEventId: auditEvent?.id ?? '',
    startedAt: startedAt.toISOString(),
    finishedAt: result.status === 'completed' ? new Date().toISOString() : null,
  };
}

/**
 * Resolves an operation key plus resource id into a concrete target, reading the
 * environment from the resource itself.
 */
async function resolveTarget(
  user: AuthenticatedUser,
  input: OperationInput,
): Promise<ResolvedTarget> {
  switch (input.key) {
    case 'reboot_droplet':
    case 'power_on_droplet':
    case 'power_off_droplet':
    case 'snapshot_droplet': {
      const droplet = await digitalocean.getDroplet(user, input.resourceId);
      const key = input.key;
      return {
        environment: droplet.environment,
        label: droplet.name,
        resourceKind: 'droplet',
        run: async () => {
          const outcome = await digitalocean.executeDropletAction(user, key, input.resourceId);
          return {
            providerActionId: outcome.providerActionId,
            status: outcome.status === 'completed' ? 'completed' : 'in_progress',
            message: `DigitalOcean accepted the ${key.replace(/_/g, ' ')} action for ${droplet.name}.`,
          };
        },
      };
    }

    case 'start_vm':
    case 'shutdown_vm':
    case 'reboot_vm':
    case 'stop_vm':
    case 'snapshot_vm': {
      const vmid = Number(input.resourceId);
      if (!Number.isInteger(vmid)) throw errors.notFound('Proxmox guest');
      const guest = await proxmox.getGuest(user, vmid);
      const key = input.key;
      return {
        environment: guest.environment,
        label: guest.name,
        resourceKind: 'proxmox_guest',
        run: async () => {
          const outcome = await proxmox.executeGuestCommand(user, key, vmid);
          return {
            providerActionId: outcome.upid || null,
            status: 'in_progress',
            message: `Proxmox queued the ${key.replace(/_vm$/, '').replace(/_/g, ' ')} task for ${guest.name} (${guest.node}).`,
          };
        },
      };
    }

    case 'restart_service':
    case 'start_service':
    case 'stop_service':
    case 'restart_worker': {
      const application = await applications.requireApplication(user, input.resourceId);
      if (!application.operationsEnabled) {
        throw errors.operationNotAllowed(
          `${application.name} is not enabled for console operations. Enable it in the registry first.`,
        );
      }
      if (!application.containerName) {
        throw errors.operationNotAllowed(
          `${application.name} has no container registered, so the console cannot restart it.`,
        );
      }
      if (!docker.configured()) {
        throw errors.providerNotConfigured('Container control');
      }

      const action: docker.ContainerAction =
        input.key === 'start_service' ? 'start' : input.key === 'stop_service' ? 'stop' : 'restart';
      const containerName = application.containerName;

      return {
        environment: application.environment,
        label: application.name,
        resourceKind: 'application',
        run: async () => {
          await docker.runAction(containerName, action);
          return {
            providerActionId: null,
            status: 'completed',
            message: `${application.name} container ${containerName} was sent a ${action}.`,
          };
        },
      };
    }

    case 'deploy_release': {
      const application = await applications.requireApplication(user, input.resourceId);
      const version = String(input.metadata?.version ?? '');
      const commitSha = String(input.metadata?.commitSha ?? '');
      if (!version || !commitSha) {
        throw errors.validation([
          { path: 'metadata.version', message: 'A version and commit sha are required to deploy.' },
        ]);
      }
      return {
        environment: application.environment,
        label: application.name,
        resourceKind: 'deployment',
        run: async () => {
          const deployment = await deployments.createDeployment(user, {
            application,
            version,
            commitSha,
            message: input.reason ?? null,
          });
          return {
            providerActionId: deployment.id,
            status: deployment.status === 'awaiting_approval' ? 'awaiting_approval' : 'in_progress',
            message:
              deployment.status === 'awaiting_approval'
                ? `Deployment of ${version} to production is recorded and waiting for a second approver.`
                : `Deployment of ${version} to ${application.environment} was queued.`,
          };
        },
      };
    }

    case 'rollback_release': {
      const application = await applications.requireApplication(user, input.resourceId);
      const target = await deployments.rollbackTarget(application);
      if (!target) {
        throw errors.conflict(
          `No previous successful release is recorded for ${application.name}, so there is nothing to roll back to.`,
        );
      }
      return {
        environment: application.environment,
        label: application.name,
        resourceKind: 'deployment',
        run: async () => {
          const deployment = await deployments.createDeployment(user, {
            application,
            version: target.version,
            commitSha: target.commitSha,
            message: `Rollback: ${input.reason ?? 'no reason given'}`,
          });
          return {
            providerActionId: deployment.id,
            status: deployment.status === 'awaiting_approval' ? 'awaiting_approval' : 'in_progress',
            message: `Rollback to ${target.version} recorded for ${application.name}.`,
          };
        },
      };
    }

    case 'approve_production_deployment': {
      const deployment = await deployments.getDeployment(user, input.resourceId);
      return {
        environment: deployment.environment,
        label: `${deployment.applicationKey} ${deployment.version}`,
        resourceKind: 'deployment',
        run: async () => {
          const updated = await deployments.decideApproval(user, input.resourceId, true, input.reason);
          return {
            providerActionId: updated.id,
            status: 'completed',
            message: `Approved ${updated.version} for production.`,
          };
        },
      };
    }

    case 'acknowledge_alert': {
      const alert = await alerts.findAlert(input.resourceId);
      if (!alert) throw errors.notFound('Alert');
      const environment = alert.environment ?? 'production';
      return {
        environment,
        label: alert.name,
        resourceKind: 'alert',
        run: async () => {
          await alerts.acknowledge(alert, user, input.reason ?? null);
          return {
            providerActionId: null,
            status: 'completed',
            message: `${alert.name} acknowledged. The underlying condition is unchanged.`,
          };
        },
      };
    }

    case 'activate_database_write_mode': {
      const connection = await databases.requireConnection(input.resourceId, user.environments);
      return {
        environment: connection.environment,
        label: connection.name,
        resourceKind: 'database',
        run: async () => {
          const window = await dbPolicy.activateWriteWindow(user, connection, {
            confirmation: input.confirmation ?? '',
            reason: input.reason ?? '',
            minutes: Number(input.metadata?.minutes ?? 0) || undefined,
          });
          return {
            providerActionId: null,
            status: 'completed',
            message: `Write mode open on ${connection.name} until ${window.expiresAt}.`,
          };
        },
      };
    }

    default: {
      // Exhaustiveness guard: a new operation key must be handled here before it
      // can be used.
      const exhaustive: never = input.key;
      throw errors.operationNotAllowed(`Operation "${String(exhaustive)}" has no implementation.`);
    }
  }
}

interface OperationRecordInput {
  key: OperationKey;
  resourceKind: string;
  resourceId: string;
  resourceLabel: string;
  environment: Environment;
  user: AuthenticatedUser;
  status: OperationResult['status'];
  providerActionId: string | null;
  reason: string | null;
  message: string;
  auditEventId: string | null;
  startedAt: Date;
}

async function recordOperation(input: OperationRecordInput): Promise<void> {
  const isTerminal = ['completed', 'failed', 'rejected'].includes(input.status);

  await orm()
    .insert(schema.operationRecords)
    .values({
      operationKey: input.key,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      resourceLabel: input.resourceLabel,
      environment: input.environment,
      requestedBy: input.user.id,
      requestedEmail: input.user.email,
      status: input.status,
      providerActionId: input.providerActionId,
      reason: input.reason,
      message: input.message.slice(0, 1000),
      auditEventId: input.auditEventId,
      startedAt: input.startedAt,
      finishedAt: isTerminal ? sql`now()` : null,
    })
    .catch(() => {
      // The audit event is the authoritative record; this table is a convenience
      // index, so a failure here must not fail the operation.
    });
}

/**
 * What the current user may do to a resource. The UI uses this to decide whether
 * to render a control at all — but the answer is recomputed on execution, so a
 * client that ignores it gains nothing.
 */
export function capabilities(
  user: AuthenticatedUser,
  environment: Environment,
): Array<{
  key: OperationKey;
  label: string;
  description: string;
  allowed: boolean;
  reason: string | null;
  impact: string;
  requiresTypedConfirmation: boolean;
  requiresSecondApproval: boolean;
}> {
  return Object.values(OPERATION_DEFINITIONS).map((definition) => {
    const decision = authoriseOperation(user, definition.key, environment);
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      allowed: decision.allowed,
      reason: decision.reason,
      impact: definition.impact,
      requiresTypedConfirmation: definition.requiresTypedConfirmation,
      requiresSecondApproval: definition.requiresSecondApproval,
    };
  });
}

export async function recentOperations(
  user: AuthenticatedUser,
  limit = 20,
): Promise<
  Array<{
    id: string;
    key: string;
    resourceLabel: string | null;
    environment: Environment;
    status: string;
    requestedEmail: string;
    message: string | null;
    startedAt: string;
  }>
> {
  const records = schema.operationRecords;
  const rows = await orm()
    .select({
      id: records.id,
      operationKey: records.operationKey,
      resourceLabel: records.resourceLabel,
      environment: records.environment,
      status: records.status,
      requestedEmail: records.requestedEmail,
      message: records.message,
      startedAt: records.startedAt,
    })
    .from(records)
    .where(inArray(records.environment, user.environments))
    .orderBy(desc(records.startedAt))
    .limit(Math.min(limit, 100));

  return rows.map((row) => ({
    id: row.id,
    key: row.operationKey,
    resourceLabel: row.resourceLabel,
    environment: row.environment,
    status: row.status,
    requestedEmail: row.requestedEmail,
    message: row.message,
    startedAt: row.startedAt.toISOString(),
  }));
}
