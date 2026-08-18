import type {
  AuthenticatedUser,
  Environment,
  LogEntry,
  LogLevel,
  LogQuery,
  LogSourceKind,
} from '@airaos/types';
import { and, count, desc, eq, gt, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { orm, schema } from '../db/drizzle.js';
import { visibleEnvironments } from '../rbac/index.js';
import { redactString, redactValue } from '../utils/redaction.js';
import { logger } from '../utils/logger.js';
import * as docker from '../providers/docker/service.js';

/**
 * Log access (spec section 12).
 *
 * Two sources are stitched together: the console's own ingest buffer (which holds
 * application, deployment and infrastructure lines pushed to it) and live
 * container logs read from the allowlisted Docker containers.
 *
 * Every line passes through redaction on the way in *and* on the way out. On the
 * way in because that is where it belongs; on the way out because lines written
 * before a redaction pattern was added would otherwise stay exposed.
 */

const ENTRY_COLUMNS = {
  id: schema.logEntries.id,
  occurredAt: schema.logEntries.occurredAt,
  level: schema.logEntries.level,
  kind: schema.logEntries.kind,
  environment: schema.logEntries.environment,
  source: schema.logEntries.source,
  message: schema.logEntries.message,
  fields: schema.logEntries.fields,
  requestId: schema.logEntries.requestId,
} as const;

interface LogRow {
  id: number;
  occurredAt: Date;
  level: LogLevel;
  kind: LogSourceKind;
  environment: Environment;
  source: string;
  message: string;
  fields: unknown;
  requestId: string | null;
}

function toEntry(row: LogRow): LogEntry {
  return {
    id: String(row.id),
    timestamp: row.occurredAt.toISOString(),
    level: row.level,
    environment: row.environment,
    source: row.source,
    message: redactString(row.message),
    fields: redactValue((row.fields ?? {}) as Record<string, unknown>),
    requestId: row.requestId,
  };
}

export interface LogSearchResult {
  items: LogEntry[];
  /** Opaque cursor for the next page: the id of the oldest row returned. */
  nextCursor: string | null;
}

export async function search(
  user: AuthenticatedUser,
  input: LogQuery & { visibleEnvironmentsOverride?: Environment[] },
): Promise<LogSearchResult> {
  const allowed = input.visibleEnvironmentsOverride ?? visibleEnvironments(user);
  const environments =
    input.environments.length > 0
      ? input.environments.filter((environment) => allowed.includes(environment))
      : allowed;

  // A filter naming only environments the user cannot see yields nothing rather
  // than silently widening back to everything they can see.
  if (environments.length === 0) {
    return { items: [], nextCursor: null };
  }

  const entries = schema.logEntries;
  const conditions: SQL[] = [inArray(entries.environment, environments)];

  if (input.sources.length > 0) conditions.push(inArray(entries.source, input.sources));
  if (input.kinds.length > 0) conditions.push(inArray(entries.kind, input.kinds));
  if (input.errorsOnly) {
    conditions.push(inArray(entries.level, ['error', 'fatal']));
  } else if (input.levels.length > 0) {
    conditions.push(inArray(entries.level, input.levels));
  }
  if (input.from) conditions.push(gte(entries.occurredAt, new Date(input.from)));
  if (input.to) conditions.push(lte(entries.occurredAt, new Date(input.to)));
  if (input.search) {
    // Full-text where possible, ILIKE as the fallback for partial words.
    conditions.push(
      or(
        sql`to_tsvector('simple', ${entries.message}) @@ plainto_tsquery('simple', ${input.search})`,
        sql`${entries.message} ilike ${`%${input.search}%`}`,
      ) as SQL,
    );
  }
  if (input.cursor) conditions.push(lt(entries.id, Number(input.cursor)));

  const limit = Math.min(input.limit, 1000);

  const rows = await orm()
    .select(ENTRY_COLUMNS)
    .from(entries)
    .where(and(...conditions))
    .orderBy(desc(entries.id))
    .limit(limit);

  return {
    items: rows.map(toEntry),
    nextCursor: rows.length === limit ? String(rows[rows.length - 1]?.id ?? '') : null,
  };
}

export interface IngestInput {
  level: LogLevel;
  kind: LogSourceKind;
  environment: Environment;
  source: string;
  message: string;
  fields?: Record<string, unknown>;
  requestId?: string | null;
  deploymentId?: string | null;
  occurredAt?: string;
}

function toInsertRow(input: IngestInput) {
  return {
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : sql`now()`,
    level: input.level,
    kind: input.kind,
    environment: input.environment,
    source: input.source.slice(0, 120),
    message: redactString(input.message).slice(0, 10_000),
    fields: redactValue(input.fields ?? {}),
    requestId: input.requestId ?? null,
    deploymentId: input.deploymentId ?? null,
  };
}

/** Writes one line into the buffer, redacted. */
export async function ingest(input: IngestInput): Promise<void> {
  try {
    await orm().insert(schema.logEntries).values(toInsertRow(input));
  } catch (error) {
    logger().error({ err: error, source: input.source }, 'failed to ingest log line');
  }
}

export async function ingestBatch(entries: IngestInput[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    // One multi-row insert rather than a statement per line: batches arrive from
    // deployment log shipping, where per-line round trips dominated the cost.
    await orm().insert(schema.logEntries).values(entries.map(toInsertRow));
  } catch (error) {
    logger().error({ err: error, count: entries.length }, 'failed to ingest log batch');
  }
}

/** Sources available for the filter dropdown. */
export async function listSources(
  user: AuthenticatedUser,
): Promise<Array<{ source: string; kind: LogSourceKind; environment: Environment; count: number }>> {
  const entries = schema.logEntries;
  const rows = await orm()
    .select({
      source: entries.source,
      kind: entries.kind,
      environment: entries.environment,
      count: count(),
    })
    .from(entries)
    .where(
      and(
        inArray(entries.environment, visibleEnvironments(user)),
        gt(entries.occurredAt, sql`now() - interval '7 days'`),
      ),
    )
    .groupBy(entries.source, entries.kind, entries.environment)
    .orderBy(entries.source);

  const fromBuffer = rows.map((row) => ({
    source: row.source,
    kind: row.kind,
    environment: row.environment,
    count: Number(row.count),
  }));

  // Allowlisted containers are always offered, even if nothing has been buffered
  // for them yet, because their logs are read live.
  const containerSources = docker.configured()
    ? docker.allowedContainers().map((name) => ({
        source: name,
        kind: 'container' as LogSourceKind,
        environment: 'development' as Environment,
        count: 0,
      }))
    : [];

  const seen = new Set(fromBuffer.map((entry) => entry.source));
  return [...fromBuffer, ...containerSources.filter((entry) => !seen.has(entry.source))];
}

/**
 * Live container log lines, mapped into the same shape as buffered entries.
 * Used by the live-tail view for container sources.
 */
export async function tailContainer(
  containerName: string,
  environment: Environment,
  lines = 200,
): Promise<LogEntry[]> {
  const raw = await docker.containerLogs(containerName, lines);

  return raw.map((line, index) => {
    // Docker prefixes each line with an RFC3339 timestamp when timestamps=true.
    const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(.*)$/.exec(line);
    const timestamp = match?.[1] ?? new Date().toISOString();
    const message = match?.[2] ?? line;

    return {
      id: `${containerName}:${timestamp}:${index}`,
      timestamp: new Date(timestamp).toISOString(),
      level: inferLevel(message),
      environment,
      source: containerName,
      message: redactString(message).slice(0, 10_000),
      fields: {},
      requestId: null,
    } satisfies LogEntry;
  });
}

/** Best-effort level detection for unstructured container output. */
function inferLevel(message: string): LogLevel {
  const upper = message.slice(0, 200).toUpperCase();
  if (/\b(FATAL|PANIC)\b/.test(upper)) return 'fatal';
  if (/\b(ERROR|ERR|EXCEPTION|FAILED)\b/.test(upper)) return 'error';
  if (/\bWARN(ING)?\b/.test(upper)) return 'warn';
  if (/\bDEBUG\b/.test(upper)) return 'debug';
  if (/\bTRACE\b/.test(upper)) return 'trace';
  return 'info';
}

/** Logs attached to a deployment, for the deployment detail drawer. */
export async function deploymentLogs(deploymentId: string): Promise<LogEntry[]> {
  const rows = await orm()
    .select(ENTRY_COLUMNS)
    .from(schema.logEntries)
    .where(eq(schema.logEntries.deploymentId, deploymentId))
    .orderBy(schema.logEntries.id)
    .limit(2000);
  return rows.map(toEntry);
}

/** Plain-text export of a filtered view, for incident write-ups. */
export function toPlainText(entries: LogEntry[]): string {
  return entries
    .slice()
    .reverse()
    .map(
      (entry) =>
        `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} [${entry.environment}] [${entry.source}] ${entry.message}`,
    )
    .join('\n');
}
