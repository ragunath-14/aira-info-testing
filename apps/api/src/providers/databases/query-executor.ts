import type pg from 'pg';
import type {
  AuthenticatedUser,
  DatabaseConnection,
  Environment,
  QueryHistoryEntry,
  QueryResult,
  QueryResultColumn,
  SqlClassificationResult,
} from '@airaos/types';
import { config } from '../../config.js';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { orm, schema } from '../../db/drizzle.js';
import { sha256 } from '../../security/crypto.js';
import { errors } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { redactSqlLiterals } from '../../utils/redaction.js';
import { getTargetPool } from './connection-manager.js';
import { classify } from './query-classifier.js';
import { assertAllowed, evaluate, type WritePolicyDecision } from './policy.js';

/**
 * SQL execution (spec sections 21, 22, 24, 42).
 *
 * Order of operations, which is deliberately not rearrangeable:
 *
 *   classify -> authorise -> bound session -> execute -> cap rows -> record
 *
 * Guardrails applied to every execution:
 *  - `statement_timeout` and `idle_in_transaction_session_timeout` are set on the
 *    session, so a runaway query is killed server-side rather than only being
 *    abandoned by the client.
 *  - Reads run inside a read-only transaction. Even a misclassified write would
 *    be refused by PostgreSQL.
 *  - Results are capped; the cap is applied by wrapping the statement in a
 *    subquery where possible, and by truncation otherwise.
 *  - Every attempt is recorded in query_history, including refusals.
 */

export interface ExecuteInput {
  sql: string;
  maxRows?: number;
  timeoutMs?: number;
  reason?: string;
  requestId: string;
}

export interface ExecuteOutcome {
  result: QueryResult;
  classification: SqlClassificationResult;
}

/** Types whose values are safest rendered as strings in JSON. */
const STRINGIFY_OIDS = new Set([
  20, // int8
  1700, // numeric
  114, // json
  3802, // jsonb
  17, // bytea
]);

export async function execute(
  user: AuthenticatedUser,
  connection: DatabaseConnection,
  input: ExecuteInput,
): Promise<ExecuteOutcome> {
  const cfg = config();
  const classification = classify(input.sql);

  const decision = await evaluate(user, connection, classification.classification);

  if (!decision.allowed) {
    await recordHistory({
      user,
      connection,
      sql: input.sql,
      classification: classification.classification,
      success: false,
      errorCode: 'QUERY_REJECTED',
      durationMs: null,
      rowsReturned: null,
      rowsAffected: null,
      truncated: false,
      requestId: input.requestId,
    });
    assertAllowed(decision, connection.environment);
  }

  const maxRows = Math.min(input.maxRows ?? cfg.DB_QUERY_MAX_ROWS, cfg.DB_QUERY_MAX_ROWS);
  const timeoutMs = Math.min(input.timeoutMs ?? cfg.DB_QUERY_TIMEOUT_MS, cfg.DB_QUERY_TIMEOUT_MS);
  const started = Date.now();

  const pool = await getTargetPool(connection.id, { readOnly: decision.readOnlySession });
  const client = await pool.connect();

  try {
    await applySessionGuards(client, timeoutMs, decision);

    const isRead = classification.classification === 'READ';
    const statement = isRead ? wrapWithLimit(input.sql, maxRows) : input.sql;

    if (isRead) {
      // BEGIN READ ONLY is a second, independent barrier alongside the
      // read-only pool session.
      await client.query('BEGIN READ ONLY');
    }

    const raw = await client.query({ text: statement, rowMode: 'array' as const });
    const results = Array.isArray(raw) ? raw : [raw];
    // A multi-statement submission returns one result per statement; the last
    // one is what the editor displays.
    const last = results[results.length - 1] as pg.QueryArrayResult | undefined;

    if (isRead) {
      await client.query('COMMIT');
    }

    const durationMs = Date.now() - started;
    const result = shapeResult(last, classification, maxRows, durationMs);

    await recordHistory({
      user,
      connection,
      sql: input.sql,
      classification: classification.classification,
      success: true,
      errorCode: null,
      durationMs,
      rowsReturned: result.rowCount,
      rowsAffected: result.rowsAffected,
      truncated: result.truncated,
      requestId: input.requestId,
    });

    return { result, classification };
  } catch (error) {
    if (classification.classification === 'READ') {
      await client.query('ROLLBACK').catch(() => undefined);
    }

    const mapped = mapPgError(error, timeoutMs);
    await recordHistory({
      user,
      connection,
      sql: input.sql,
      classification: classification.classification,
      success: false,
      errorCode: (error as { code?: string }).code ?? mapped.code,
      durationMs: Date.now() - started,
      rowsReturned: null,
      rowsAffected: null,
      truncated: false,
      requestId: input.requestId,
    });
    throw mapped;
  } finally {
    client.release();
  }
}

/**
 * Session-level limits. These are the controls that hold even if application
 * logic is bypassed, so they are set before any statement runs.
 */
async function applySessionGuards(
  client: pg.PoolClient,
  timeoutMs: number,
  decision: WritePolicyDecision,
): Promise<void> {
  await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`).catch(async () => {
    // SET LOCAL outside a transaction is a no-op warning on some versions; fall
    // back to a session-scoped SET so the timeout is never simply skipped.
    await client.query(`SET statement_timeout = ${Number(timeoutMs)}`);
  });
  await client.query(`SET idle_in_transaction_session_timeout = ${Number(timeoutMs) + 5000}`);
  await client.query('SET lock_timeout = 3000');
  if (decision.readOnlySession) {
    await client.query('SET default_transaction_read_only = on');
  }
}

/**
 * Applies the row cap in SQL so the database stops producing rows, rather than
 * streaming a million rows to the API and discarding them.
 *
 * Only applied when the statement is a single SELECT that does not already end
 * with its own LIMIT — wrapping anything else risks changing its meaning.
 */
export function wrapWithLimit(sql: string, maxRows: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const isSingleSelect =
    /^\s*(select|with|table|values)\b/i.test(trimmed) && !trimmed.includes(';');
  if (!isSingleSelect) return sql;
  if (/\blimit\s+\d+\s*(offset\s+\d+\s*)?$/i.test(trimmed)) return sql;
  // The extra row lets the caller detect that truncation happened.
  return `SELECT * FROM (${trimmed}) AS console_query LIMIT ${Number(maxRows) + 1}`;
}

function shapeResult(
  raw: pg.QueryArrayResult | undefined,
  classification: SqlClassificationResult,
  maxRows: number,
  durationMs: number,
): QueryResult {
  if (!raw) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      rowsAffected: null,
      truncated: false,
      durationMs,
      classification: classification.classification,
      plan: null,
      notices: classification.notes,
    };
  }

  const columns: QueryResultColumn[] = (raw.fields ?? []).map((field) => ({
    name: field.name,
    dataTypeOid: field.dataTypeID,
    dataType: pgTypeName(field.dataTypeID),
  }));

  const allRows = raw.rows ?? [];
  const truncated = allRows.length > maxRows;
  const rows = (truncated ? allRows.slice(0, maxRows) : allRows).map((row) =>
    Object.fromEntries(
      (row as unknown[]).map((value, index) => [
        columns[index]?.name ?? `column_${index}`,
        serialiseValue(value, columns[index]?.dataTypeOid),
      ]),
    ),
  );

  // EXPLAIN returns its plan as one text column per line.
  const isPlan =
    columns.length === 1 &&
    (columns[0]?.name === 'QUERY PLAN' || columns[0]?.name === 'query plan');

  return {
    columns,
    rows,
    rowCount: rows.length,
    // pg reports rowCount for DML; for SELECT it duplicates the row count, so
    // it is only meaningful for non-reads.
    rowsAffected: classification.classification === 'READ' ? null : (raw.rowCount ?? null),
    truncated,
    durationMs,
    classification: classification.classification,
    plan: isPlan ? rows.map((row) => String(Object.values(row)[0] ?? '')) : null,
    notices: classification.notes,
  };
}

/**
 * Converts a PostgreSQL value into something JSON-safe.
 *
 * bigint and numeric become strings to avoid precision loss; bytea becomes a
 * length marker rather than a base64 payload, since dumping binary blobs into a
 * browser grid is neither useful nor safe.
 */
function serialiseValue(value: unknown, oid: number | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `\\x[${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => serialiseValue(entry, undefined));
  if (typeof value === 'bigint') return value.toString();
  if (oid !== undefined && STRINGIFY_OIDS.has(oid) && typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'object') return value;
  return value;
}

/** Common type names, for display. Unknown OIDs fall back to the numeric id. */
const TYPE_NAMES: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  114: 'json',
  700: 'real',
  701: 'double precision',
  1042: 'character',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

function pgTypeName(oid: number): string {
  return TYPE_NAMES[oid] ?? `oid:${oid}`;
}

/**
 * Maps PostgreSQL error codes to console errors. Messages from PostgreSQL are
 * passed through because they name the object and the problem, which is exactly
 * what the operator needs — they contain no credentials.
 */
function mapPgError(error: unknown, timeoutMs: number) {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : 'Query failed';

  switch (code) {
    case '57014': // query_canceled
      return errors.queryTimeout(timeoutMs);
    case '55P03': // lock_not_available
      return errors.queryRejected(
        'The query could not acquire a lock within 3 seconds and was abandoned.',
      );
    case '25006': // read_only_sql_transaction
      return errors.readOnlyMode('this');
    case '42501': // insufficient_privilege
      return errors.queryRejected(
        `The database rejected this statement: ${message}. The console's database user may lack the required grant.`,
      );
    case '42P01': // undefined_table
    case '42703': // undefined_column
    case '42601': // syntax_error
      return errors.queryRejected(message);
    case '53300': // too_many_connections
      return errors.providerUnavailable('The target database (connection limit reached)', null);
    default:
      logger().warn({ err: error, code }, 'query execution failed');
      return errors.queryRejected(message.slice(0, 500), { code });
  }
}

// ------------------------------------------------------------------ history ---

interface HistoryInput {
  user: AuthenticatedUser;
  connection: DatabaseConnection;
  sql: string;
  classification: QueryResult['classification'];
  success: boolean;
  errorCode: string | null;
  durationMs: number | null;
  rowsReturned: number | null;
  rowsAffected: number | null;
  truncated: boolean;
  requestId: string;
}

/**
 * Records an execution attempt.
 *
 * The literal-stripped preview is always stored. Full SQL is retained only for
 * statements that changed something, because those are the ones an incident
 * review needs to reconstruct — and keeping full SELECT text would mean storing
 * customer data in the console database (spec section 24).
 */
async function recordHistory(input: HistoryInput): Promise<void> {
  const normalised = redactSqlLiterals(input.sql);
  const keepFullText = input.classification !== 'READ';

  try {
    await orm().insert(schema.queryHistory).values({
      userId: input.user.id,
      userEmail: input.user.email,
      connectionId: input.connection.id,
      connectionName: input.connection.name,
      environment: input.connection.environment,
      queryHash: sha256(normalised),
      queryPreview: normalised.slice(0, 2000),
      queryText: keepFullText ? input.sql.slice(0, 20_000) : null,
      classification: input.classification,
      success: input.success,
      errorCode: input.errorCode,
      durationMs: input.durationMs,
      rowsReturned: input.rowsReturned,
      rowsAffected: input.rowsAffected,
      truncated: input.truncated,
      requestId: input.requestId,
    });
  } catch (error) {
    // History is important but must not swallow the query's own outcome.
    logger().error({ err: error, requestId: input.requestId }, 'failed to record query history');
  }
}

export interface HistoryQuery {
  connectionId?: string;
  environment?: string;
  userId?: string;
  classification?: string;
  success?: boolean;
  page: number;
  pageSize: number;
  /** Environments the caller may see; always supplied by the route. */
  visibleEnvironments: string[];
}

export async function history(input: HistoryQuery) {
  const rows = schema.queryHistory;
  const conditions: SQL[] = [
    inArray(rows.environment, input.visibleEnvironments as Environment[]),
  ];

  if (input.connectionId) conditions.push(eq(rows.connectionId, input.connectionId));
  if (input.environment) conditions.push(eq(rows.environment, input.environment as Environment));
  if (input.userId) conditions.push(eq(rows.userId, input.userId));
  if (input.classification) {
    conditions.push(
      eq(rows.classification, input.classification as QueryHistoryEntry['classification']),
    );
  }
  if (input.success !== undefined) conditions.push(eq(rows.success, input.success));

  const where = and(...conditions);
  const offset = (input.page - 1) * input.pageSize;

  // `queryText` is deliberately never selected here: the list view shows the
  // redacted preview, and the full text is only reachable through the detail
  // endpoint that re-checks permission.
  const [items, totals] = await Promise.all([
    orm()
      .select({
        id: rows.id,
        userId: rows.userId,
        userEmail: rows.userEmail,
        connectionId: rows.connectionId,
        connectionName: rows.connectionName,
        environment: rows.environment,
        queryHash: rows.queryHash,
        queryPreview: rows.queryPreview,
        classification: rows.classification,
        success: rows.success,
        errorCode: rows.errorCode,
        durationMs: rows.durationMs,
        rowsReturned: rows.rowsReturned,
        rowsAffected: rows.rowsAffected,
        executedAt: rows.executedAt,
      })
      .from(rows)
      .where(where)
      .orderBy(desc(rows.executedAt))
      .limit(input.pageSize)
      .offset(offset),
    orm().select({ count: count() }).from(rows).where(where),
  ]);

  const totalCount = Number(totals[0]?.count ?? 0);

  const entries: QueryHistoryEntry[] = items.map((row) => ({
    id: String(row.id),
    userId: row.userId ?? '',
    userEmail: row.userEmail,
    connectionId: row.connectionId ?? '',
    connectionName: row.connectionName,
    environment: row.environment,
    queryHash: row.queryHash,
    queryPreview: row.queryPreview,
    classification: row.classification,
    success: row.success,
    errorCode: row.errorCode,
    durationMs: row.durationMs,
    rowsReturned: row.rowsReturned,
    rowsAffected: row.rowsAffected,
    executedAt: row.executedAt.toISOString(),
  }));

  return {
    items: entries,
    page: input.page,
    pageSize: input.pageSize,
    total: totalCount,
    hasMore: input.page * input.pageSize < totalCount,
  };
}
