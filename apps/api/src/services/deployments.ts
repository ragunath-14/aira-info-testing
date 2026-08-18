import type {
  ApplicationRegistryEntry,
  AuthenticatedUser,
  DeploymentStatus,
  DeploymentSummary,
  Environment,
  Paginated,
  ReleaseCandidate,
} from '@airaos/types';
import { and, count, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { orm, schema, type DbOrTx } from '../db/drizzle.js';
import { errors } from '../utils/errors.js';
import { hasPermission, visibleEnvironments } from '../rbac/index.js';

/**
 * Deployment records and the production approval gate (spec sections 10, 49).
 *
 * The console does not build or ship code: CI does. What lives here is the record
 * of what was deployed, by whom, and — for production — who approved it. The
 * actual rollout is triggered by handing the release to the CI/CD system, which
 * is the only component with deploy credentials.
 *
 * The approval rule is enforced in three places, deliberately: the RBAC check
 * below, the `deployments_approver_distinct` constraint, and the
 * `deployments_production_gate` trigger. Any one of them failing still stops an
 * unapproved production deployment.
 */

const deployments = schema.deployments;

/**
 * Two aliases of `users`: a deployment names both the operator who requested it
 * and, for production, the different operator who approved it.
 */
const triggeredByUser = alias(schema.users, 'triggered_by_user');
const approvedByUser = alias(schema.users, 'approved_by_user');

const DEPLOYMENT_COLUMNS = {
  id: deployments.id,
  applicationId: deployments.applicationId,
  applicationKey: schema.applications.key,
  environment: deployments.environment,
  version: deployments.version,
  commitSha: deployments.commitSha,
  branch: deployments.branch,
  status: deployments.status,
  triggeredBy: deployments.triggeredBy,
  triggeredEmail: triggeredByUser.email,
  approvedBy: deployments.approvedBy,
  approvedEmail: approvedByUser.email,
  startedAt: deployments.startedAt,
  finishedAt: deployments.finishedAt,
  ciRunUrl: deployments.ciRunUrl,
  rollbackOf: deployments.rollbackOf,
  message: deployments.message,
} as const;

/** The joined base query every deployment read shares. */
function deploymentQuery(db: DbOrTx = orm()) {
  return db
    .select(DEPLOYMENT_COLUMNS)
    .from(deployments)
    .innerJoin(schema.applications, eq(schema.applications.id, deployments.applicationId))
    .innerJoin(triggeredByUser, eq(triggeredByUser.id, deployments.triggeredBy))
    .leftJoin(approvedByUser, eq(approvedByUser.id, deployments.approvedBy));
}

type DeploymentRow = {
  [K in keyof typeof DEPLOYMENT_COLUMNS]: Awaited<
    ReturnType<typeof deploymentQuery>
  >[number][K];
};

function toSummary(row: DeploymentRow): DeploymentSummary {
  return {
    id: row.id,
    applicationId: row.applicationId,
    applicationKey: row.applicationKey,
    environment: row.environment,
    version: row.version,
    commitSha: row.commitSha,
    branch: row.branch,
    status: row.status,
    triggeredByUserId: row.triggeredBy,
    triggeredByEmail: row.triggeredEmail,
    approvedByUserId: row.approvedBy,
    approvedByEmail: row.approvedEmail,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs:
      row.startedAt && row.finishedAt
        ? row.finishedAt.getTime() - row.startedAt.getTime()
        : null,
    ciRunUrl: row.ciRunUrl,
    rollbackOfDeploymentId: row.rollbackOf,
    message: row.message,
  };
}

export async function listDeployments(
  user: AuthenticatedUser,
  filters: {
    applicationId?: string;
    environment?: Environment;
    status?: DeploymentStatus;
    page: number;
    pageSize: number;
  },
): Promise<Paginated<DeploymentSummary>> {
  const conditions: SQL[] = [inArray(deployments.environment, visibleEnvironments(user))];

  if (filters.applicationId) {
    conditions.push(eq(deployments.applicationId, filters.applicationId));
  }
  if (filters.environment) conditions.push(eq(deployments.environment, filters.environment));
  if (filters.status) conditions.push(eq(deployments.status, filters.status));

  const where = and(...conditions);
  const offset = (filters.page - 1) * filters.pageSize;

  const [items, totals] = await Promise.all([
    deploymentQuery()
      .where(where)
      .orderBy(desc(deployments.createdAt))
      .limit(filters.pageSize)
      .offset(offset),
    // Counted against the base table: the joins are all inner or left on
    // single-row keys, so they cannot change the count.
    orm().select({ count: count() }).from(deployments).where(where),
  ]);

  const totalCount = Number(totals[0]?.count ?? 0);
  return {
    items: items.map(toSummary),
    page: filters.page,
    pageSize: filters.pageSize,
    total: totalCount,
    hasMore: filters.page * filters.pageSize < totalCount,
  };
}

export async function getDeployment(
  user: AuthenticatedUser,
  deploymentId: string,
): Promise<DeploymentSummary> {
  const [row] = await deploymentQuery().where(eq(deployments.id, deploymentId)).limit(1);
  if (!row) throw errors.notFound('Deployment');
  if (!user.environments.includes(row.environment)) throw errors.notFound('Deployment');
  return toSummary(row);
}

export interface CreateDeploymentInput {
  application: ApplicationRegistryEntry;
  version: string;
  commitSha: string;
  branch?: string | null;
  message?: string | null;
  rollbackOf?: string | null;
}

/**
 * Records a deployment request.
 *
 * A production deployment is created in `awaiting_approval` and does not
 * progress until a different authorised operator approves it. Non-production
 * deployments start `pending` and are handed straight to CI.
 */
export async function createDeployment(
  user: AuthenticatedUser,
  input: CreateDeploymentInput,
): Promise<DeploymentSummary> {
  const { application } = input;
  const isProduction = application.environment === 'production';

  if (!application.operationsEnabled) {
    throw errors.operationNotAllowed(
      `${application.name} is not enabled for console-driven deployments. Enable it in the registry first.`,
    );
  }

  const requiredPermission = isProduction ? 'application.deploy.production' : 'application.deploy';
  if (!hasPermission(user, requiredPermission)) {
    throw errors.forbidden(`Deploying to ${application.environment} requires ${requiredPermission}.`);
  }
  if (!user.environments.includes(application.environment)) {
    throw errors.environmentForbidden(application.environment);
  }

  // Refuse to queue a second deployment for the same target while one is live:
  // two concurrent rollouts to one environment is how a half-deployed service
  // happens.
  const [inFlight] = await orm()
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.applicationId, application.id),
        inArray(deployments.status, ['pending', 'awaiting_approval', 'running']),
      ),
    )
    .limit(1);

  if (inFlight) {
    throw errors.conflict(
      `A deployment for ${application.name} in ${application.environment} is already in progress.`,
    );
  }

  const status: DeploymentStatus = isProduction ? 'awaiting_approval' : 'pending';

  const [created] = await orm()
    .insert(deployments)
    .values({
      applicationId: application.id,
      environment: application.environment,
      version: input.version,
      commitSha: input.commitSha,
      branch: input.branch ?? application.branch,
      status,
      triggeredBy: user.id,
      message: input.message ?? null,
      rollbackOf: input.rollbackOf ?? null,
    })
    .returning({ id: deployments.id });

  if (!created) throw errors.internal({ reason: 'deployment insert returned no id' });
  return getDeployment(user, created.id);
}

/**
 * Approves or rejects a pending production deployment.
 *
 * The approver must be a different person from the requester. This is checked
 * here for a clear error message and again by a database constraint.
 */
export async function decideApproval(
  user: AuthenticatedUser,
  deploymentId: string,
  approve: boolean,
  note?: string,
): Promise<DeploymentSummary> {
  if (!hasPermission(user, 'application.deploy.production')) {
    throw errors.forbidden('Approving a production deployment requires application.deploy.production.');
  }

  return orm().transaction(async (tx) => {
    // Row lock: two approvers pressing the button together must not both win.
    const [row] = await tx
      .select({
        id: deployments.id,
        status: deployments.status,
        environment: deployments.environment,
        triggeredBy: deployments.triggeredBy,
      })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .for('update');

    if (!row) throw errors.notFound('Deployment');
    if (row.status !== 'awaiting_approval') {
      throw errors.conflict(`This deployment is ${row.status} and cannot be approved.`);
    }
    if (row.triggeredBy === user.id) {
      throw errors.approvalRequired(
        'A production deployment must be approved by someone other than the operator who requested it.',
      );
    }

    if (!approve) {
      await tx
        .update(deployments)
        .set({
          status: 'cancelled',
          finishedAt: sql`now()`,
          message: note ?? 'Rejected during approval.',
        })
        .where(eq(deployments.id, deploymentId));
    } else {
      await tx
        .update(deployments)
        .set({
          approvedBy: user.id,
          approvedAt: sql`now()`,
          status: 'pending',
          // An absent note leaves the requester's message intact.
          message: note ?? sql`${deployments.message}`,
        })
        .where(eq(deployments.id, deploymentId));
    }

    const [result] = await deploymentQuery(tx).where(eq(deployments.id, deploymentId)).limit(1);
    if (!result) throw errors.internal({ reason: 'deployment vanished during approval' });
    return toSummary(result);
  });
}

/** Transitions a deployment as CI reports progress. */
export async function updateStatus(
  deploymentId: string,
  status: DeploymentStatus,
  options: { message?: string | null; ciRunUrl?: string | null; logs?: string | null } = {},
): Promise<void> {
  const isTerminal = ['succeeded', 'failed', 'rolled_back', 'cancelled'].includes(status);

  await orm()
    .update(deployments)
    .set({
      status,
      // First transition into `running` stamps the start; later ones leave it.
      startedAt:
        status === 'running' ? sql`coalesce(${deployments.startedAt}, now())` : undefined,
      finishedAt: isTerminal ? sql`now()` : undefined,
      message: options.message ?? undefined,
      ciRunUrl: options.ciRunUrl ?? undefined,
      logs: options.logs ?? undefined,
    })
    .where(eq(deployments.id, deploymentId));
}

/**
 * Release candidates available to deploy.
 *
 * The console does not invent releases: candidates come from deployments already
 * recorded in lower environments. That enforces the promotion path in spec §10 —
 * you can only ship to production something that has run somewhere else first.
 */
export async function releaseCandidates(
  application: ApplicationRegistryEntry,
): Promise<ReleaseCandidate[]> {
  const promotionSource: Record<Environment, Environment | null> = {
    development: null,
    testing: 'development',
    staging: 'testing',
    production: 'staging',
  };

  const source = promotionSource[application.environment];
  if (!source) {
    return [];
  }

  const rows = await orm()
    .selectDistinctOn([deployments.version], {
      version: deployments.version,
      commitSha: deployments.commitSha,
      branch: deployments.branch,
      finishedAt: deployments.finishedAt,
      ciRunUrl: deployments.ciRunUrl,
    })
    .from(deployments)
    .innerJoin(schema.applications, eq(schema.applications.id, deployments.applicationId))
    .where(
      and(
        eq(schema.applications.key, application.key),
        eq(deployments.environment, source),
        eq(deployments.status, 'succeeded'),
      ),
    )
    .orderBy(deployments.version, desc(deployments.finishedAt))
    .limit(20);

  const currentVersion = application.version;

  return rows
    .filter((row) => row.version !== currentVersion)
    .map((row) => ({
      version: row.version,
      commitSha: row.commitSha,
      branch: row.branch ?? 'unknown',
      createdAt: row.finishedAt?.toISOString() ?? new Date(0).toISOString(),
      // A successful deployment in the source environment is the validation
      // signal; CI status itself lives in the CI system.
      ciStatus: 'passed' as const,
      ciRunUrl: row.ciRunUrl,
      promotedFrom: source,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The release to roll back to: the last success before the current version. */
export async function rollbackTarget(
  application: ApplicationRegistryEntry,
): Promise<ReleaseCandidate | null> {
  const [row] = await orm()
    .select({
      version: deployments.version,
      commitSha: deployments.commitSha,
      branch: deployments.branch,
      finishedAt: deployments.finishedAt,
      ciRunUrl: deployments.ciRunUrl,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.applicationId, application.id),
        eq(deployments.status, 'succeeded'),
        ne(deployments.version, application.version ?? ''),
      ),
    )
    .orderBy(desc(deployments.finishedAt))
    .limit(1);

  if (!row) return null;
  return {
    version: row.version,
    commitSha: row.commitSha,
    branch: row.branch ?? 'unknown',
    createdAt: row.finishedAt?.toISOString() ?? new Date(0).toISOString(),
    ciStatus: 'passed',
    ciRunUrl: row.ciRunUrl,
    promotedFrom: null,
  };
}

export async function countDeploying(user: AuthenticatedUser): Promise<number> {
  const [row] = await orm()
    .select({ count: count() })
    .from(deployments)
    .where(
      and(
        inArray(deployments.environment, visibleEnvironments(user)),
        inArray(deployments.status, ['pending', 'awaiting_approval', 'running']),
      ),
    );
  return Number(row?.count ?? 0);
}
