import type {
  ApplicationKind,
  ApplicationRegistryEntry,
  ApplicationStatus,
  AuthenticatedUser,
  DeploymentSummary,
  Environment,
  HealthProbeResult,
  HealthState,
  SubsystemHealth,
} from '@airaos/types';
import { request } from 'undici';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { orm, schema } from '../db/drizzle.js';
import { environmentRank } from '../db/order.js';
import { errors } from '../utils/errors.js';
import { providerCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { redactString } from '../utils/redaction.js';
import { visibleEnvironments } from '../rbac/index.js';
import * as docker from '../providers/docker/service.js';

/**
 * Application registry and health checks (spec section 9).
 *
 * Health probes are made by the API against internal URLs. The URL comes from
 * the registry, which only an operator with `settings.manage` can edit — a probe
 * target is never taken from a request, so this is not an SSRF surface reachable
 * by an ordinary user.
 */

type ApplicationRow = typeof schema.applications.$inferSelect;

function toEntry(row: ApplicationRow): ApplicationRegistryEntry {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    environment: row.environment,
    host: row.host,
    containerName: row.containerName,
    repository: row.repository,
    branch: row.branch,
    version: row.version,
    commitSha: row.commitSha,
    healthUrl: row.healthUrl,
    port: row.port,
    dependsOn: row.dependsOn ?? [],
    ownerTeam: row.ownerTeam,
    operationsEnabled: row.operationsEnabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listApplications(
  user: AuthenticatedUser,
  filters: { environment?: Environment; kind?: ApplicationKind; search?: string } = {},
): Promise<ApplicationRegistryEntry[]> {
  const allowed = visibleEnvironments(user);
  const apps = schema.applications;
  const conditions: SQL[] = [inArray(apps.environment, allowed)];

  if (filters.environment) {
    if (!allowed.includes(filters.environment)) throw errors.environmentForbidden(filters.environment);
    conditions.push(eq(apps.environment, filters.environment));
  }
  if (filters.kind) {
    conditions.push(eq(apps.kind, filters.kind));
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(or(ilike(apps.name, term), ilike(apps.key, term)) as SQL);
  }

  const rows = await orm()
    .select()
    .from(apps)
    .where(and(...conditions))
    .orderBy(environmentRank(apps.environment), apps.name);

  return rows.map(toEntry);
}

/**
 * Loads one application and confirms the caller may act in its environment.
 * Called by every operation path; the environment is taken from the row.
 */
export async function requireApplication(
  user: AuthenticatedUser,
  applicationId: string,
): Promise<ApplicationRegistryEntry> {
  const [row] = await orm()
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.id, applicationId))
    .limit(1);

  if (!row) throw errors.notFound('Application');
  if (!user.environments.includes(row.environment)) throw errors.notFound('Application');
  return toEntry(row);
}

// ------------------------------------------------------------ health checks ---

const PROBE_TIMEOUT_MS = 4000;

/**
 * Probes one application's health endpoint.
 *
 * The registry URL is used exactly as configured — point it at `/health/ready`
 * for services that distinguish readiness from liveness. Each result is
 * persisted so the UI can show "last successful check" even while a service is
 * failing.
 */
export async function probe(application: ApplicationRegistryEntry): Promise<HealthProbeResult> {
  const checkedAt = new Date().toISOString();
  const previous = await lastCheck(application.id);

  if (!application.healthUrl) {
    return {
      state: 'unknown',
      httpStatus: null,
      responseTimeMs: null,
      checkedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastFailureAt: previous?.lastFailureAt ?? null,
      message: 'No health endpoint is registered for this service.',
      dependencies: [],
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await request(application.healthUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'airaos-infra-console/1.0' },
      // Redirects are not followed: undici does not follow them unless a
      // redirect interceptor is installed, and a health endpoint that redirects
      // is treated as a non-2xx result rather than chased (which would also make
      // this an SSRF amplifier).
    });

    const responseTimeMs = Date.now() - started;
    const body = await response.body.text();
    const parsed = parseHealthBody(body);

    const state: HealthState =
      response.statusCode >= 200 && response.statusCode < 300
        ? (parsed.state ?? 'healthy')
        : response.statusCode >= 500
          ? 'down'
          : 'degraded';

    const result: HealthProbeResult = {
      state,
      httpStatus: response.statusCode,
      responseTimeMs,
      checkedAt,
      lastSuccessAt: state === 'healthy' ? checkedAt : (previous?.lastSuccessAt ?? null),
      lastFailureAt: state === 'healthy' ? (previous?.lastFailureAt ?? null) : checkedAt,
      message: parsed.message,
      dependencies: parsed.dependencies,
    };

    await persistCheck(application.id, result);
    return result;
  } catch (error) {
    const isTimeout =
      (error as { name?: string }).name === 'AbortError' ||
      String((error as Error)?.message ?? '').includes('aborted');

    const result: HealthProbeResult = {
      state: 'down',
      httpStatus: null,
      responseTimeMs: Date.now() - started,
      checkedAt,
      lastSuccessAt: previous?.lastSuccessAt ?? null,
      lastFailureAt: checkedAt,
      message: isTimeout
        ? `No response within ${PROBE_TIMEOUT_MS}ms.`
        : redactString(String((error as Error)?.message ?? 'Unreachable')).slice(0, 200),
      dependencies: [],
    };

    await persistCheck(application.id, result);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a health response body. Supports the common shapes — `{status}`,
 * `{state}`, `{checks:[...]}` — and treats an unparseable body as no extra
 * information rather than as a failure.
 */
function parseHealthBody(body: string): {
  state: HealthState | null;
  message: string | null;
  dependencies: HealthProbeResult['dependencies'];
} {
  if (!body.trim().startsWith('{')) {
    return { state: null, message: null, dependencies: [] };
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const rawStatus = String(parsed.status ?? parsed.state ?? '').toLowerCase();
    const state: HealthState | null =
      rawStatus === 'ok' || rawStatus === 'up' || rawStatus === 'healthy' || rawStatus === 'pass'
        ? 'healthy'
        : rawStatus === 'degraded' || rawStatus === 'warn'
          ? 'degraded'
          : rawStatus === 'down' || rawStatus === 'fail' || rawStatus === 'error'
            ? 'down'
            : null;

    const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
    const dependencies = checks
      .filter((check): check is Record<string, unknown> => Boolean(check) && typeof check === 'object')
      .slice(0, 20)
      .map((check) => {
        const status = String(check.status ?? check.state ?? '').toLowerCase();
        return {
          name: String(check.name ?? 'dependency'),
          state: (status === 'ok' || status === 'up' || status === 'healthy'
            ? 'healthy'
            : status === 'degraded'
              ? 'degraded'
              : status === ''
                ? 'unknown'
                : 'down') as HealthState,
          detail: check.detail ? redactString(String(check.detail)).slice(0, 200) : null,
        };
      });

    return {
      state,
      message: parsed.message ? redactString(String(parsed.message)).slice(0, 200) : null,
      dependencies,
    };
  } catch {
    return { state: null, message: null, dependencies: [] };
  }
}

async function persistCheck(applicationId: string, result: HealthProbeResult): Promise<void> {
  try {
    await orm().insert(schema.applicationHealthChecks).values({
      applicationId,
      state: result.state,
      httpStatus: result.httpStatus,
      responseTimeMs: result.responseTimeMs,
      message: result.message,
      dependencies: result.dependencies,
      checkedAt: new Date(result.checkedAt),
    });
  } catch (error) {
    logger().debug({ err: error, applicationId }, 'failed to persist health check');
  }
}

async function lastCheck(
  applicationId: string,
): Promise<{ lastSuccessAt: string | null; lastFailureAt: string | null } | null> {
  const checks = schema.applicationHealthChecks;
  // Two filtered aggregates in one pass, so a failing service still reports when
  // it was last healthy.
  const [row] = await orm()
    .select({
      lastSuccess: sql<Date | null>`max(${checks.checkedAt}) filter (where ${checks.state} = 'healthy')`,
      lastFailure: sql<Date | null>`max(${checks.checkedAt}) filter (where ${checks.state} <> 'healthy')`,
    })
    .from(checks)
    .where(eq(checks.applicationId, applicationId));

  if (!row) return null;
  return {
    lastSuccessAt: row.lastSuccess?.toISOString() ?? null,
    lastFailureAt: row.lastFailure?.toISOString() ?? null,
  };
}

/**
 * Full status for the Services page: registry entry, live health, container
 * state where Docker is available, and the most recent deployment.
 */
export async function statuses(
  user: AuthenticatedUser,
  filters: { environment?: Environment; search?: string } = {},
): Promise<{ items: ApplicationStatus[]; cachedAgeMs?: number }> {
  const applications = await listApplications(user, filters);
  const cacheKey = `apps:status:${user.id}:${filters.environment ?? 'all'}:${filters.search ?? ''}`;

  const result = await providerCache.wrap(
    cacheKey,
    15_000,
    async () => {
      const [containers, deployments] = await Promise.all([
        docker.listContainers().then((response) => response.value).catch(() => []),
        latestDeployments(applications.map((application) => application.id)),
      ]);

      return Promise.all(
        applications.map(async (application) => ({
          application,
          health: await probe(application),
          container:
            containers.find((container) => container.name === application.containerName) ?? null,
          lastDeployment: deployments.get(application.id) ?? null,
        })),
      );
    },
    { fallbackToStale: true },
  );

  return { items: result.value, cachedAgeMs: result.cachedAgeMs };
}

async function latestDeployments(
  applicationIds: string[],
): Promise<Map<string, DeploymentSummary>> {
  if (applicationIds.length === 0) return new Map();

  const deployments = schema.deployments;
  const triggeredBy = alias(schema.users, 'triggered_by_user');
  const approvedBy = alias(schema.users, 'approved_by_user');

  // DISTINCT ON gives the newest deployment per application in one pass. The
  // leading ORDER BY column must match the DISTINCT ON column.
  const rows = await orm()
    .selectDistinctOn([deployments.applicationId], {
      id: deployments.id,
      applicationId: deployments.applicationId,
      applicationKey: schema.applications.key,
      environment: deployments.environment,
      version: deployments.version,
      commitSha: deployments.commitSha,
      branch: deployments.branch,
      status: deployments.status,
      triggeredBy: deployments.triggeredBy,
      triggeredEmail: triggeredBy.email,
      approvedBy: deployments.approvedBy,
      approvedEmail: approvedBy.email,
      startedAt: deployments.startedAt,
      finishedAt: deployments.finishedAt,
      ciRunUrl: deployments.ciRunUrl,
      rollbackOf: deployments.rollbackOf,
      message: deployments.message,
    })
    .from(deployments)
    .innerJoin(schema.applications, eq(schema.applications.id, deployments.applicationId))
    .innerJoin(triggeredBy, eq(triggeredBy.id, deployments.triggeredBy))
    .leftJoin(approvedBy, eq(approvedBy.id, deployments.approvedBy))
    .where(inArray(deployments.applicationId, applicationIds))
    .orderBy(deployments.applicationId, desc(deployments.createdAt));

  return new Map(
    rows.map((row) => [
      row.applicationId,
      {
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
      } satisfies DeploymentSummary,
    ]),
  );
}

export async function health(user: AuthenticatedUser): Promise<SubsystemHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const { items } = await statuses(user);
    const down = items.filter((item) => item.health.state === 'down').length;
    const degraded = items.filter((item) => item.health.state === 'degraded').length;
    const unknown = items.filter((item) => item.health.state === 'unknown').length;

    return {
      key: 'applications',
      label: 'Applications',
      state: down > 0 ? 'down' : degraded > 0 ? 'degraded' : items.length === 0 ? 'unknown' : 'healthy',
      detail:
        items.length === 0
          ? 'No applications registered.'
          : `${items.length - down - degraded - unknown}/${items.length} healthy` +
            (unknown > 0 ? `, ${unknown} not probed` : ''),
      configured: items.length > 0,
      lastCheckedAt: checkedAt,
      lastSuccessAt: checkedAt,
      latencyMs: null,
    };
  } catch (error) {
    return {
      key: 'applications',
      label: 'Applications',
      state: 'unknown',
      detail: error instanceof Error ? error.message : 'Health could not be determined.',
      configured: true,
      lastCheckedAt: checkedAt,
      lastSuccessAt: null,
      latencyMs: null,
    };
  }
}

export interface UpsertApplicationInput {
  key: string;
  name: string;
  kind: ApplicationKind;
  environment: Environment;
  host?: string | null;
  containerName?: string | null;
  repository?: string | null;
  branch?: string | null;
  healthUrl?: string | null;
  port?: number | null;
  dependsOn?: string[];
  ownerTeam?: string | null;
  operationsEnabled?: boolean;
}

export async function upsertApplication(
  input: UpsertApplicationInput,
): Promise<ApplicationRegistryEntry> {
  const values = {
    key: input.key,
    name: input.name,
    kind: input.kind,
    environment: input.environment,
    host: input.host ?? null,
    containerName: input.containerName ?? null,
    repository: input.repository ?? null,
    branch: input.branch ?? null,
    healthUrl: input.healthUrl ?? null,
    port: input.port ?? null,
    dependsOn: input.dependsOn ?? [],
    ownerTeam: input.ownerTeam ?? null,
    operationsEnabled: input.operationsEnabled ?? false,
  };

  // `version` and `commitSha` are deliberately absent from the update set: they
  // are owned by the deployment pipeline, not the registry form.
  const [row] = await orm()
    .insert(schema.applications)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.applications.key, schema.applications.environment],
      set: {
        name: values.name,
        kind: values.kind,
        host: values.host,
        containerName: values.containerName,
        repository: values.repository,
        branch: values.branch,
        healthUrl: values.healthUrl,
        port: values.port,
        dependsOn: values.dependsOn,
        ownerTeam: values.ownerTeam,
        operationsEnabled: values.operationsEnabled,
      },
    })
    .returning();

  if (!row) throw errors.internal({ reason: 'application upsert returned no row' });
  providerCache.invalidate('apps:status:', true);
  return toEntry(row);
}
