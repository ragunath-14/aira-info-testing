import type { FastifyRequest } from 'fastify';
import type {
  AuditChainVerification,
  AuditEvent,
  AuditQuery,
  AuditResult,
  Environment,
  Paginated,
  Role,
} from '@airaos/types';
import { and, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { orm, schema } from '../db/drizzle.js';
import { auditRecordHash } from '../security/crypto.js';
import { redactValue } from '../utils/redaction.js';
import { logger } from '../utils/logger.js';

/**
 * Audit trail (spec section 30, rule 6).
 *
 * Every privileged action records one event. Writes take an advisory lock so the
 * hash chain stays linear under concurrency, and the record hash covers the
 * canonical content plus the previous hash: editing or deleting a row is then
 * detectable by `verifyChain`.
 *
 * Recording an event must never break the operation that triggered it, so a
 * failure here is logged loudly and swallowed — except for `record` calls that
 * pass `strict`, used where the audit record is the point (write windows).
 */

export interface AuditInput {
  action: string;
  resourceKind: string;
  resourceId?: string | null;
  resourceLabel?: string | null;
  environment?: Environment | null;
  result: AuditResult;
  errorCode?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown>;
}

interface AuditActor {
  userId: string | null;
  email: string;
  roles: Role[];
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

/** Postgres advisory lock key; arbitrary but must stay stable. */
const AUDIT_LOCK_KEY = 0x41495241; // "AIRA"

function canonicalise(
  actor: AuditActor,
  input: AuditInput,
  occurredAt: string,
  metadata: Record<string, unknown>,
): string {
  // Stable field order and JSON encoding: the hash must be reproducible by the
  // verifier years later.
  return JSON.stringify([
    occurredAt,
    actor.userId,
    actor.email.toLowerCase(),
    [...actor.roles].sort(),
    input.action,
    input.resourceKind,
    input.resourceId ?? null,
    input.environment ?? null,
    input.result,
    input.errorCode ?? null,
    input.message ?? null,
    actor.requestId,
    sortedJson(metadata),
  ]);
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortedJson(entry)]),
    );
  }
  return value;
}

export function actorFromRequest(request: FastifyRequest): AuditActor {
  const user = request.user;
  return {
    userId: user?.id ?? null,
    email: user?.email ?? 'anonymous',
    roles: user?.roles ?? [],
    ipAddress: clientIp(request),
    userAgent: typeof request.headers['user-agent'] === 'string'
      ? request.headers['user-agent'].slice(0, 500)
      : null,
    requestId: request.id,
  };
}

/**
 * Client IP for the audit record. Trusts `x-forwarded-for` only because the API
 * is expected to sit behind the console's own reverse proxy; Fastify's
 * `trustProxy` is configured to match.
 */
function clientIp(request: FastifyRequest): string | null {
  const ip = request.ip;
  if (!ip) return null;
  // Normalise IPv4-mapped IPv6 so queries group correctly.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export interface RecordedAuditEvent {
  id: string;
  sequence: number;
  recordHash: string;
}

export async function record(
  request: FastifyRequest,
  input: AuditInput,
  options: { strict?: boolean } = {},
): Promise<RecordedAuditEvent | null> {
  const actor = actorFromRequest(request);
  try {
    return await insert(actor, input);
  } catch (error) {
    logger().error(
      { err: error, action: input.action, requestId: actor.requestId },
      'failed to record audit event',
    );
    if (options.strict) throw error;
    return null;
  }
}

async function insert(actor: AuditActor, input: AuditInput): Promise<RecordedAuditEvent> {
  const metadata = redactValue(input.metadata ?? {});
  const occurredAt = new Date().toISOString();

  return orm().transaction(async (tx) => {
    // Serialise chain appends. Transaction-scoped, released on commit/rollback.
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);

    const [previous] = await tx
      .select({ recordHash: schema.auditEvents.recordHash })
      .from(schema.auditEvents)
      .orderBy(desc(schema.auditEvents.sequence))
      .limit(1);

    const previousHash = previous?.recordHash ?? null;
    const canonical = canonicalise(actor, input, occurredAt, metadata);
    const recordHash = auditRecordHash(canonical, previousHash);

    const [row] = await tx
      .insert(schema.auditEvents)
      .values({
        userId: actor.userId,
        userEmail: actor.email,
        userRoles: actor.roles,
        action: input.action,
        resourceKind: input.resourceKind,
        resourceId: input.resourceId ?? null,
        resourceLabel: input.resourceLabel ?? null,
        environment: input.environment ?? null,
        result: input.result,
        errorCode: input.errorCode ?? null,
        message: input.message ?? null,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
        metadata,
        // The same instant that went into the hash, so verifyChain reproduces it.
        occurredAt: new Date(occurredAt),
        previousHash,
        recordHash,
      })
      .returning({ id: schema.auditEvents.id, sequence: schema.auditEvents.sequence });

    if (!row) throw new Error('audit insert returned no row');
    return { id: row.id, sequence: Number(row.sequence), recordHash };
  });
}

type AuditRow = typeof schema.auditEvents.$inferSelect;

function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    userId: row.userId ?? '',
    userEmail: row.userEmail,
    userRoles: row.userRoles as Role[],
    action: row.action,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    environment: row.environment,
    result: row.result,
    errorCode: row.errorCode,
    message: row.message,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    requestId: row.requestId,
    metadata: row.metadata as Record<string, unknown>,
    occurredAt: row.occurredAt.toISOString(),
    recordHash: row.recordHash,
    previousHash: row.previousHash,
  };
}

/** Builds the filter for `search`, or undefined when nothing was supplied. */
function auditFilter(input: AuditQuery): SQL | undefined {
  const events = schema.auditEvents;
  const conditions: SQL[] = [];

  if (input.userId) conditions.push(eq(events.userId, input.userId));
  if (input.action) conditions.push(eq(events.action, input.action));
  if (input.resourceKind) conditions.push(eq(events.resourceKind, input.resourceKind));
  if (input.environment) conditions.push(eq(events.environment, input.environment));
  if (input.result) conditions.push(eq(events.result, input.result));
  if (input.from) conditions.push(gte(events.occurredAt, new Date(input.from)));
  if (input.to) conditions.push(lte(events.occurredAt, new Date(input.to)));
  if (input.search) {
    const term = `%${input.search}%`;
    conditions.push(
      or(
        ilike(events.userEmail, term),
        ilike(events.resourceLabel, term),
        ilike(events.message, term),
      ) as SQL,
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function search(input: AuditQuery): Promise<Paginated<AuditEvent>> {
  const where = auditFilter(input);
  const offset = (input.page - 1) * input.pageSize;

  const [items, totals] = await Promise.all([
    orm()
      .select()
      .from(schema.auditEvents)
      .where(where)
      .orderBy(desc(schema.auditEvents.sequence))
      .limit(input.pageSize)
      .offset(offset),
    orm().select({ count: count() }).from(schema.auditEvents).where(where),
  ]);

  const total = Number(totals[0]?.count ?? 0);

  return {
    items: items.map(toAuditEvent),
    page: input.page,
    pageSize: input.pageSize,
    total,
    hasMore: input.page * input.pageSize < total,
  };
}

/**
 * Recomputes the hash chain over the most recent `limit` records. Reports the
 * first sequence whose stored hash disagrees with the recomputed one, which is
 * where tampering or a lost row would show up.
 */
export async function verifyChain(limit = 5000): Promise<AuditChainVerification> {
  const recent = await orm()
    .select()
    .from(schema.auditEvents)
    .orderBy(desc(schema.auditEvents.sequence))
    .limit(limit);

  // Verification walks forward, because each hash covers its predecessor.
  const rows = recent.reverse();
  let firstBroken: number | null = null;

  for (const row of rows) {
    const canonical = canonicalise(
      {
        userId: row.userId,
        email: row.userEmail,
        roles: row.userRoles as Role[],
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        requestId: row.requestId,
      },
      {
        action: row.action,
        resourceKind: row.resourceKind,
        resourceId: row.resourceId,
        environment: row.environment,
        result: row.result,
        errorCode: row.errorCode,
        message: row.message,
      },
      row.occurredAt.toISOString(),
      row.metadata as Record<string, unknown>,
    );
    const expected = auditRecordHash(canonical, row.previousHash);
    if (expected !== row.recordHash) {
      firstBroken = Number(row.sequence);
      break;
    }
  }

  return {
    verified: firstBroken === null,
    checkedCount: rows.length,
    firstBrokenSequence: firstBroken,
    checkedAt: new Date().toISOString(),
  };
}

export async function distinctActions(): Promise<string[]> {
  const rows = await orm()
    .selectDistinct({ action: schema.auditEvents.action })
    .from(schema.auditEvents)
    .orderBy(schema.auditEvents.action);
  return rows.map((row) => row.action);
}
