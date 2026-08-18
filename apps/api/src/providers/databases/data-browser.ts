import type pg from 'pg';
import type {
  DataBrowserRequest,
  DataFilterOperator,
  DatabaseConnection,
  QueryResult,
  QueryResultColumn,
} from '@airaos/types';
import { config } from '../../config.js';
import { errors } from '../../utils/errors.js';
import { getTargetPool } from './connection-manager.js';
import { listColumns } from './introspection.js';

/**
 * Spreadsheet-style data browser (spec section 20).
 *
 * The browser sends structured intent — schema, table, columns, filters, sort,
 * page — never a SQL fragment. This module builds the statement.
 *
 * Injection defence has two independent layers:
 *
 *  1. Every identifier is checked against the table's real column list read from
 *     the catalog. A column the table does not have is rejected outright, so
 *     there is no path from client text to an identifier we have not verified.
 *  2. Verified identifiers are then quoted with PostgreSQL's own rules before
 *     interpolation, and all filter values are bound as parameters.
 *
 * The result is always read-only: the statement is a SELECT, and it runs on a
 * read-only session inside a read-only transaction.
 */

/** Quotes an identifier the same way PostgreSQL's quote_ident() does. */
export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

const OPERATOR_SQL: Record<DataFilterOperator, (column: string, placeholder: string) => string> = {
  eq: (column, placeholder) => `${column} = ${placeholder}`,
  neq: (column, placeholder) => `${column} <> ${placeholder}`,
  gt: (column, placeholder) => `${column} > ${placeholder}`,
  gte: (column, placeholder) => `${column} >= ${placeholder}`,
  lt: (column, placeholder) => `${column} < ${placeholder}`,
  lte: (column, placeholder) => `${column} <= ${placeholder}`,
  contains: (column, placeholder) => `${column}::text ILIKE ${placeholder}`,
  starts_with: (column, placeholder) => `${column}::text ILIKE ${placeholder}`,
  ends_with: (column, placeholder) => `${column}::text ILIKE ${placeholder}`,
  is_null: (column) => `${column} IS NULL`,
  is_not_null: (column) => `${column} IS NOT NULL`,
};

/** Operators whose bound value needs LIKE wildcards added. */
function likeValue(operator: DataFilterOperator, value: string): string {
  switch (operator) {
    case 'contains':
      return `%${escapeLike(value)}%`;
    case 'starts_with':
      return `${escapeLike(value)}%`;
    case 'ends_with':
      return `%${escapeLike(value)}`;
    default:
      return value;
  }
}

/** Escapes LIKE metacharacters so a search for "50%" is literal. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export interface BrowseOutcome {
  result: QueryResult;
  total: number | null;
  /** True when the total is an estimate rather than an exact count. */
  totalIsEstimate: boolean;
}

export async function browse(
  connection: DatabaseConnection,
  request: DataBrowserRequest,
): Promise<BrowseOutcome> {
  const cfg = config();
  const pool = await getTargetPool(connection.id, { readOnly: true });

  // Layer 1: the authoritative column list for this relation.
  const columns = await listColumns(connection.id, request.schema, request.table);
  if (columns.length === 0) throw errors.notFound('Table');
  const validColumns = new Set(columns.map((column) => column.name));

  const assertColumn = (name: string): string => {
    if (!validColumns.has(name)) {
      throw errors.validation([
        { path: 'column', message: `"${name}" is not a column of ${request.schema}.${request.table}` },
      ]);
    }
    return quoteIdent(name);
  };

  const selectedColumns =
    request.columns && request.columns.length > 0
      ? request.columns.map(assertColumn)
      : columns.map((column) => quoteIdent(column.name));

  const params: unknown[] = [];
  const whereParts: string[] = [];

  for (const filter of request.filters) {
    const column = assertColumn(filter.column);
    const needsValue = filter.operator !== 'is_null' && filter.operator !== 'is_not_null';

    if (!needsValue) {
      whereParts.push(OPERATOR_SQL[filter.operator](column, ''));
      continue;
    }
    if (filter.value === null || filter.value === undefined) {
      throw errors.validation([
        { path: 'filters', message: `Operator "${filter.operator}" requires a value.` },
      ]);
    }

    params.push(likeValue(filter.operator, filter.value));
    whereParts.push(OPERATOR_SQL[filter.operator](column, `$${params.length}`));
  }

  const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
  const relation = `${quoteIdent(request.schema)}.${quoteIdent(request.table)}`;

  const orderBy = request.orderBy
    ? `ORDER BY ${assertColumn(request.orderBy)} ${request.orderDirection === 'desc' ? 'DESC' : 'ASC'}`
    : // Deterministic paging needs a stable order; prefer the primary key.
      defaultOrder(columns);

  const pageSize = Math.min(request.pageSize, cfg.DB_QUERY_MAX_ROWS);
  const offset = (request.page - 1) * pageSize;

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${Number(cfg.DB_QUERY_TIMEOUT_MS)}`);
    await client.query('BEGIN READ ONLY');

    const started = Date.now();
    const rows = await client.query({
      text: `SELECT ${selectedColumns.join(', ')} FROM ${relation} ${where} ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`,
      values: params as never[],
      rowMode: 'array' as const,
    });
    const durationMs = Date.now() - started;

    const { total, totalIsEstimate } = await resolveTotal(
      client,
      relation,
      where,
      params,
      whereParts.length > 0,
    );

    await client.query('COMMIT');

    const resultColumns: QueryResultColumn[] = (rows.fields ?? []).map((field) => ({
      name: field.name,
      dataTypeOid: field.dataTypeID,
      dataType: columns.find((column) => column.name === field.name)?.dataType ?? 'unknown',
    }));

    return {
      result: {
        columns: resultColumns,
        rows: (rows.rows ?? []).map((row) =>
          Object.fromEntries(
            (row as unknown[]).map((value, index) => [
              resultColumns[index]?.name ?? `column_${index}`,
              normalise(value),
            ]),
          ),
        ),
        rowCount: rows.rows?.length ?? 0,
        rowsAffected: null,
        truncated: (rows.rows?.length ?? 0) >= pageSize,
        durationMs,
        classification: 'READ',
        plan: null,
        notices: [],
      },
      total,
      totalIsEstimate,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Row count strategy.
 *
 * An exact `count(*)` on a large table is a sequential scan, which is exactly
 * the accidental load the spec warns about. So: exact count only when filters
 * are applied (the result set is presumably small) or when the planner's
 * estimate is modest. Otherwise report the estimate and say so.
 */
async function resolveTotal(
  client: pg.PoolClient,
  relation: string,
  where: string,
  params: unknown[],
  hasFilters: boolean,
): Promise<{ total: number | null; totalIsEstimate: boolean }> {
  const EXACT_COUNT_THRESHOLD = 500_000;

  // The relation name is bound as a parameter rather than interpolated, even
  // though it has already been validated and quoted.
  const estimateResult = await client.query<{ estimate: string | null }>(
    'SELECT reltuples::bigint::text AS estimate FROM pg_class WHERE oid = $1::regclass',
    [relation],
  );
  const rawEstimate = estimateResult.rows[0]?.estimate;
  const estimate = rawEstimate === null || rawEstimate === undefined ? null : Number(rawEstimate);

  if (!hasFilters && estimate !== null && estimate > EXACT_COUNT_THRESHOLD) {
    return { total: estimate, totalIsEstimate: true };
  }

  const exact = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ${relation} ${where}`,
    params as never[],
  );

  return { total: Number(exact.rows[0]?.total ?? 0), totalIsEstimate: false };
}

/** Stable default ordering: primary key if there is one, otherwise ctid. */
function defaultOrder(columns: Awaited<ReturnType<typeof listColumns>>): string {
  const primaryKey = columns.filter((column) => column.isPrimaryKey);
  if (primaryKey.length > 0) {
    return `ORDER BY ${primaryKey.map((column) => quoteIdent(column.name)).join(', ')}`;
  }
  // ctid is physical order — good enough to make paging deterministic within a
  // single browsing session, which is what matters here.
  return 'ORDER BY ctid';
}

function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `\\x[${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * CSV export of the current view. Uses the same builder as `browse`, so an export
 * cannot reach rows or columns the browser would not show.
 */
export async function exportCsv(
  connection: DatabaseConnection,
  request: DataBrowserRequest,
): Promise<string> {
  const { result } = await browse(connection, request);
  const header = result.columns.map((column) => csvCell(column.name)).join(',');
  const lines = result.rows.map((row) =>
    result.columns.map((column) => csvCell(row[column.name])).join(','),
  );
  return [header, ...lines].join('\r\n');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Neutralise spreadsheet formula injection: a leading =, +, -, @ or tab is
  // executed by Excel when the file is opened.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}
