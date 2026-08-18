import type {
  ColumnDefinition,
  ConstraintDefinition,
  DatabaseConnection,
  DatabaseConnectionStatus,
  IndexDefinition,
  RelationDetail,
  RelationKind,
  RelationSummary,
  SchemaNode,
} from '@airaos/types';
import { providerCache } from '../../utils/cache.js';
import { errors } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { unverifiedBackup } from './backup.js';
import { getTargetPool } from './connection-manager.js';

/**
 * Schema introspection for the Database Explorer (spec sections 18, 19, 25).
 *
 * Every query here is a parameterised read against the catalog, run on a
 * read-only session. Identifiers supplied by the client are bound as parameters
 * and compared against catalog values — they are never interpolated into SQL,
 * which is why the explorer cannot be used as an injection vector.
 */

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

async function readQuery<T extends Record<string, unknown>>(
  connectionId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = await getTargetPool(connectionId, { readOnly: true });
  const result = await pool.query<T>(sql, params as never[]);
  return result.rows;
}

export async function listSchemas(connectionId: string): Promise<SchemaNode[]> {
  const result = await providerCache.wrap(
    `db:schemas:${connectionId}`,
    60_000,
    async () =>
      readQuery<{
        name: string;
        owner: string | null;
        table_count: string;
        view_count: string;
        function_count: string;
        sequence_count: string;
      }>(
        connectionId,
        `SELECT n.nspname                                            AS name,
                pg_get_userbyid(n.nspowner)                          AS owner,
                count(*) FILTER (WHERE c.relkind IN ('r','p','f'))::text AS table_count,
                count(*) FILTER (WHERE c.relkind IN ('v','m'))::text     AS view_count,
                (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid)::text AS function_count,
                count(*) FILTER (WHERE c.relkind = 'S')::text            AS sequence_count
           FROM pg_namespace n
           LEFT JOIN pg_class c ON c.relnamespace = n.oid
          WHERE n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast%'
          GROUP BY n.oid, n.nspname, n.nspowner
          ORDER BY (n.nspname = ANY($1::text[])), n.nspname`,
        [SYSTEM_SCHEMAS],
      ),
    { fallbackToStale: true },
  );

  return result.value.map((row) => ({
    name: row.name,
    owner: row.owner,
    tableCount: Number(row.table_count),
    viewCount: Number(row.view_count),
    functionCount: Number(row.function_count),
    sequenceCount: Number(row.sequence_count),
    isSystem: SYSTEM_SCHEMAS.includes(row.name),
  }));
}

function mapRelKind(relkind: string): RelationKind {
  switch (relkind) {
    case 'v':
      return 'view';
    case 'm':
      return 'materialized_view';
    case 'p':
      return 'partitioned_table';
    case 'f':
      return 'foreign_table';
    default:
      return 'table';
  }
}

export async function listRelations(
  connectionId: string,
  schema: string,
): Promise<RelationSummary[]> {
  const result = await providerCache.wrap(
    `db:relations:${connectionId}:${schema}`,
    45_000,
    async () =>
      readQuery<{
        schema: string;
        name: string;
        relkind: string;
        owner: string | null;
        estimated_rows: string | null;
        total_size: string | null;
        comment: string | null;
      }>(
        connectionId,
        `SELECT n.nspname AS schema,
                c.relname AS name,
                c.relkind::text AS relkind,
                pg_get_userbyid(c.relowner) AS owner,
                CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint::text END AS estimated_rows,
                pg_total_relation_size(c.oid)::text AS total_size,
                obj_description(c.oid, 'pg_class') AS comment
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND c.relkind IN ('r','p','v','m','f')
          ORDER BY c.relkind, c.relname`,
        [schema],
      ),
    { fallbackToStale: true },
  );

  return result.value.map((row) => ({
    schema: row.schema,
    name: row.name,
    kind: mapRelKind(row.relkind),
    owner: row.owner,
    estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
    totalSizeBytes: row.total_size === null ? null : Number(row.total_size),
    comment: row.comment,
  }));
}

export async function getRelationDetail(
  connectionId: string,
  schema: string,
  relation: string,
): Promise<RelationDetail> {
  const [summary] = await readQuery<{
    schema: string;
    name: string;
    relkind: string;
    owner: string | null;
    estimated_rows: string | null;
    total_size: string | null;
    comment: string | null;
  }>(
    connectionId,
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind,
            pg_get_userbyid(c.relowner) AS owner,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint::text END AS estimated_rows,
            pg_total_relation_size(c.oid)::text AS total_size,
            obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p','v','m','f')`,
    [schema, relation],
  );

  // Reuse the generic not-found so probing for table names yields nothing useful.
  if (!summary) throw errors.notFound('Table or view');

  const [columns, indexes, constraints, foreignKeys, referencedBy] = await Promise.all([
    listColumns(connectionId, schema, relation),
    listIndexes(connectionId, schema, relation),
    listConstraints(connectionId, schema, relation),
    listForeignKeys(connectionId, schema, relation),
    listReferencedBy(connectionId, schema, relation),
  ]);

  return {
    relation: {
      schema: summary.schema,
      name: summary.name,
      kind: mapRelKind(summary.relkind),
      owner: summary.owner,
      estimatedRows: summary.estimated_rows === null ? null : Number(summary.estimated_rows),
      totalSizeBytes: summary.total_size === null ? null : Number(summary.total_size),
      comment: summary.comment,
    },
    columns,
    indexes,
    constraints,
    foreignKeys,
    referencedBy,
  };
}

export async function listColumns(
  connectionId: string,
  schema: string,
  relation: string,
): Promise<ColumnDefinition[]> {
  const rows = await readQuery<{
    position: number;
    name: string;
    data_type: string;
    nullable: boolean;
    default_value: string | null;
    is_primary_key: boolean;
    is_unique: boolean;
    fk_schema: string | null;
    fk_table: string | null;
    fk_column: string | null;
    comment: string | null;
  }>(
    connectionId,
    `WITH target AS (
       SELECT c.oid
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
     )
     SELECT a.attnum                                        AS position,
            a.attname                                       AS name,
            format_type(a.atttypid, a.atttypmod)             AS data_type,
            NOT a.attnotnull                                 AS nullable,
            pg_get_expr(d.adbin, d.adrelid)                  AS default_value,
            COALESCE(pk.is_pk, FALSE)                        AS is_primary_key,
            COALESCE(uq.is_unique, FALSE)                    AS is_unique,
            fk.fk_schema, fk.fk_table, fk.fk_column,
            col_description(a.attrelid, a.attnum)            AS comment
       FROM pg_attribute a
       JOIN target t ON t.oid = a.attrelid
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN (
         SELECT conrelid, unnest(conkey) AS attnum, TRUE AS is_pk
           FROM pg_constraint WHERE contype = 'p'
       ) pk ON pk.conrelid = a.attrelid AND pk.attnum = a.attnum
       LEFT JOIN (
         SELECT conrelid, unnest(conkey) AS attnum, TRUE AS is_unique
           FROM pg_constraint WHERE contype = 'u'
       ) uq ON uq.conrelid = a.attrelid AND uq.attnum = a.attnum
       LEFT JOIN (
         SELECT con.conrelid,
                unnest(con.conkey)                AS attnum,
                fn.nspname                        AS fk_schema,
                fc.relname                        AS fk_table,
                (SELECT attname FROM pg_attribute
                  WHERE attrelid = con.confrelid AND attnum = con.confkey[1]) AS fk_column
           FROM pg_constraint con
           JOIN pg_class fc ON fc.oid = con.confrelid
           JOIN pg_namespace fn ON fn.oid = fc.relnamespace
          WHERE con.contype = 'f'
       ) fk ON fk.conrelid = a.attrelid AND fk.attnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, relation],
  );

  return rows.map((row) => ({
    position: row.position,
    name: row.name,
    dataType: row.data_type,
    nullable: row.nullable,
    defaultValue: row.default_value,
    isPrimaryKey: row.is_primary_key,
    isUnique: row.is_unique || row.is_primary_key,
    foreignKey:
      row.fk_schema && row.fk_table && row.fk_column
        ? { schema: row.fk_schema, table: row.fk_table, column: row.fk_column }
        : null,
    comment: row.comment,
  }));
}

export async function listIndexes(
  connectionId: string,
  schema: string,
  relation: string,
): Promise<IndexDefinition[]> {
  const rows = await readQuery<{
    name: string;
    definition: string;
    is_unique: boolean;
    is_primary: boolean;
    size_bytes: string | null;
    columns: string[];
  }>(
    connectionId,
    `SELECT ic.relname                          AS name,
            pg_get_indexdef(i.indexrelid)       AS definition,
            i.indisunique                       AS is_unique,
            i.indisprimary                      AS is_primary,
            pg_relation_size(i.indexrelid)::text AS size_bytes,
            ARRAY(
              SELECT a.attname FROM pg_attribute a
               WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
               ORDER BY array_position(i.indkey, a.attnum)
            )                                   AS columns
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class tc ON tc.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = tc.relnamespace
      WHERE n.nspname = $1 AND tc.relname = $2
      ORDER BY i.indisprimary DESC, ic.relname`,
    [schema, relation],
  );

  return rows.map((row) => ({
    name: row.name,
    definition: row.definition,
    isUnique: row.is_unique,
    isPrimary: row.is_primary,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    columns: row.columns ?? [],
  }));
}

export async function listConstraints(
  connectionId: string,
  schema: string,
  relation: string,
): Promise<ConstraintDefinition[]> {
  const rows = await readQuery<{ name: string; contype: string; definition: string }>(
    connectionId,
    `SELECT con.conname AS name, con.contype::text AS contype,
            pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY con.contype, con.conname`,
    [schema, relation],
  );

  const typeMap: Record<string, ConstraintDefinition['type']> = {
    p: 'primary_key',
    f: 'foreign_key',
    u: 'unique',
    c: 'check',
    x: 'exclusion',
  };

  return rows.map((row) => ({
    name: row.name,
    type: typeMap[row.contype] ?? 'other',
    definition: row.definition,
  }));
}

export async function listForeignKeys(
  connectionId: string,
  schema: string,
  relation: string,
): Promise<RelationDetail['foreignKeys']> {
  const rows = await readQuery<{
    name: string;
    columns: string[];
    referenced_schema: string;
    referenced_table: string;
    referenced_columns: string[];
    on_delete: string;
    on_update: string;
  }>(
    connectionId,
    `SELECT con.conname AS name,
            ARRAY(SELECT attname FROM pg_attribute
                   WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)) AS columns,
            fn.nspname AS referenced_schema,
            fc.relname AS referenced_table,
            ARRAY(SELECT attname FROM pg_attribute
                   WHERE attrelid = con.confrelid AND attnum = ANY(con.confkey)) AS referenced_columns,
            con.confdeltype::text AS on_delete,
            con.confupdtype::text AS on_update
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
      ORDER BY con.conname`,
    [schema, relation],
  );

  const actions: Record<string, string> = {
    a: 'NO ACTION',
    r: 'RESTRICT',
    c: 'CASCADE',
    n: 'SET NULL',
    d: 'SET DEFAULT',
  };

  return rows.map((row) => ({
    name: row.name,
    columns: row.columns ?? [],
    referencedSchema: row.referenced_schema,
    referencedTable: row.referenced_table,
    referencedColumns: row.referenced_columns ?? [],
    onDelete: actions[row.on_delete] ?? null,
    onUpdate: actions[row.on_update] ?? null,
  }));
}

/** Inbound foreign keys, so the UI can warn before a destructive operation. */
export async function listReferencedBy(
  connectionId: string,
  schema: string,
  relation: string,
): Promise<RelationDetail['referencedBy']> {
  const rows = await readQuery<{ schema: string; table: string; constraint: string }>(
    connectionId,
    `SELECT n.nspname AS schema, c.relname AS table, con.conname AS constraint
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE con.contype = 'f' AND fn.nspname = $1 AND fc.relname = $2
      ORDER BY n.nspname, c.relname`,
    [schema, relation],
  );
  return rows.map((row) => ({ schema: row.schema, table: row.table, constraint: row.constraint }));
}

export interface SchemaObjects {
  functions: Array<{ schema: string; name: string; arguments: string; returns: string; kind: string }>;
  sequences: Array<{ schema: string; name: string; lastValue: string | null; increment: string }>;
  extensions: Array<{ name: string; version: string; schema: string }>;
  triggers: Array<{ schema: string; table: string; name: string; timing: string; event: string }>;
}

export async function listSchemaObjects(
  connectionId: string,
  schema: string,
): Promise<SchemaObjects> {
  const [functions, sequences, extensions, triggers] = await Promise.all([
    readQuery<{ schema: string; name: string; arguments: string; returns: string; kind: string }>(
      connectionId,
      `SELECT n.nspname AS schema, p.proname AS name,
              pg_get_function_arguments(p.oid) AS arguments,
              pg_get_function_result(p.oid) AS returns,
              CASE p.prokind WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window'
                             WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
        ORDER BY p.proname
        LIMIT 500`,
      [schema],
    ),
    readQuery<{ schema: string; name: string; last_value: string | null; increment: string }>(
      connectionId,
      `SELECT schemaname AS schema, sequencename AS name,
              last_value::text AS last_value, increment_by::text AS increment
         FROM pg_sequences WHERE schemaname = $1 ORDER BY sequencename LIMIT 500`,
      [schema],
    ),
    readQuery<{ name: string; version: string; schema: string }>(
      connectionId,
      `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        ORDER BY e.extname`,
    ),
    readQuery<{ schema: string; table: string; name: string; timing: string; event: string }>(
      connectionId,
      `SELECT event_object_schema AS schema, event_object_table AS table,
              trigger_name AS name, action_timing AS timing,
              string_agg(event_manipulation, ', ' ORDER BY event_manipulation) AS event
         FROM information_schema.triggers
        WHERE trigger_schema = $1
        GROUP BY 1,2,3,4
        ORDER BY 2, 3
        LIMIT 500`,
      [schema],
    ),
  ]);

  return {
    functions,
    sequences: sequences.map((row) => ({
      schema: row.schema,
      name: row.name,
      lastValue: row.last_value,
      increment: row.increment,
    })),
    extensions,
    triggers,
  };
}

/**
 * Connection health and vital statistics.
 *
 * Every optional figure degrades to null instead of a zero when the underlying
 * view or extension is missing, so the UI can distinguish "not available" from
 * "genuinely zero".
 */
export async function connectionStatus(
  connection: DatabaseConnection,
): Promise<DatabaseConnectionStatus> {
  const checkedAt = new Date().toISOString();
  const started = Date.now();

  try {
    const pool = await getTargetPool(connection.id, { readOnly: true });

    const [vitals, slowQueries] = await Promise.all([
      pool.query<{
        version: string;
        size: string;
        active: string;
        max_connections: string;
        cache_hit_ratio: string | null;
        in_recovery: boolean;
      }>(
        `SELECT version()                                              AS version,
                pg_database_size(current_database())::text             AS size,
                (SELECT count(*)::text FROM pg_stat_activity
                  WHERE datname = current_database())                  AS active,
                current_setting('max_connections')                     AS max_connections,
                (SELECT CASE WHEN sum(blks_hit + blks_read) > 0
                             THEN round(100.0 * sum(blks_hit) / sum(blks_hit + blks_read), 2)::text
                             ELSE NULL END
                   FROM pg_stat_database WHERE datname = current_database()) AS cache_hit_ratio,
                pg_is_in_recovery()                                    AS in_recovery`,
      ),
      // pg_stat_statements is not installed everywhere; absence is not an error.
      pool
        .query<{ slow: string }>(
          `SELECT count(*)::text AS slow FROM pg_stat_statements
            WHERE mean_exec_time > 1000`,
        )
        .catch(() => null),
    ]);

    const row = vitals.rows[0];
    const inRecovery = row?.in_recovery ?? false;

    let replicationLagBytes: number | null = null;
    if (inRecovery) {
      const lag = await pool
        .query<{ lag: string | null }>(
          `SELECT pg_wal_lsn_diff(
                    pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()
                  )::text AS lag`,
        )
        .catch(() => null);
      const raw = lag?.rows[0]?.lag;
      replicationLagBytes = raw === null || raw === undefined ? null : Number(raw);
    }

    return {
      connectionId: connection.id,
      state: 'healthy',
      latencyMs: Date.now() - started,
      serverVersion: row?.version?.split(' ').slice(0, 2).join(' ') ?? null,
      databaseSizeBytes: row?.size ? Number(row.size) : null,
      activeConnections: row?.active ? Number(row.active) : null,
      maxConnections: row?.max_connections ? Number(row.max_connections) : null,
      slowQueryCount: slowQueries?.rows[0]?.slow ? Number(slowQueries.rows[0].slow) : null,
      cacheHitRatio: row?.cache_hit_ratio ? Number(row.cache_hit_ratio) : null,
      replicationRole: inRecovery ? 'replica' : 'primary',
      replicationLagBytes,
      backup: await unverifiedBackup(connection),
      checkedAt,
      message: null,
    };
  } catch (error) {
    logger().warn({ err: error, connectionId: connection.id }, 'connection status failed');
    return {
      connectionId: connection.id,
      state: 'down',
      latencyMs: null,
      serverVersion: null,
      databaseSizeBytes: null,
      activeConnections: null,
      maxConnections: null,
      slowQueryCount: null,
      cacheHitRatio: null,
      replicationRole: 'unknown',
      replicationLagBytes: null,
      backup: await unverifiedBackup(connection),
      checkedAt,
      message: error instanceof Error ? error.message.slice(0, 300) : 'Connection failed',
    };
  }
}
