import type { Environment } from './environment.js';
import type { BackupState, HealthState } from './infrastructure.js';

export type DatabaseProvider = 'digitalocean_managed' | 'proxmox_vm' | 'self_hosted' | 'other';

/**
 * Metadata only. Credentials live encrypted in the console database and are
 * never included in any API response (spec section 17 / rule 1).
 */
export interface DatabaseConnection {
  id: string;
  name: string;
  environment: Environment;
  provider: DatabaseProvider;
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  description: string | null;
  /** Read-only enforcement is derived from environment + this override. */
  readOnlyOverride: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseConnectionStatus {
  connectionId: string;
  state: HealthState;
  latencyMs: number | null;
  serverVersion: string | null;
  databaseSizeBytes: number | null;
  activeConnections: number | null;
  maxConnections: number | null;
  /** Requires pg_stat_statements; null when the extension is absent. */
  slowQueryCount: number | null;
  cacheHitRatio: number | null;
  replicationRole: 'primary' | 'replica' | 'unknown';
  replicationLagBytes: number | null;
  backup: BackupState;
  checkedAt: string;
  message: string | null;
}

export type SqlClassification = 'READ' | 'WRITE' | 'DDL' | 'DESTRUCTIVE' | 'UNKNOWN';

export interface SqlClassificationResult {
  classification: SqlClassification;
  /** Every statement found in the submitted text, in order. */
  statements: Array<{ sql: string; verb: string | null; classification: SqlClassification }>;
  /** True when more than one statement was submitted. */
  multiStatement: boolean;
  /** Reasons the classifier escalated or rejected, for display and audit. */
  notes: string[];
}

export interface SchemaNode {
  name: string;
  owner: string | null;
  tableCount: number;
  viewCount: number;
  functionCount: number;
  sequenceCount: number;
  isSystem: boolean;
}

export type RelationKind = 'table' | 'view' | 'materialized_view' | 'partitioned_table' | 'foreign_table';

export interface RelationSummary {
  schema: string;
  name: string;
  kind: RelationKind;
  owner: string | null;
  estimatedRows: number | null;
  totalSizeBytes: number | null;
  comment: string | null;
}

export interface ColumnDefinition {
  position: number;
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isUnique: boolean;
  foreignKey: { schema: string; table: string; column: string } | null;
  comment: string | null;
}

export interface IndexDefinition {
  name: string;
  definition: string;
  isUnique: boolean;
  isPrimary: boolean;
  sizeBytes: number | null;
  columns: string[];
}

export interface ConstraintDefinition {
  name: string;
  type: 'primary_key' | 'foreign_key' | 'unique' | 'check' | 'exclusion' | 'other';
  definition: string;
}

export interface RelationDetail {
  relation: RelationSummary;
  columns: ColumnDefinition[];
  indexes: IndexDefinition[];
  constraints: ConstraintDefinition[];
  foreignKeys: Array<{
    name: string;
    columns: string[];
    referencedSchema: string;
    referencedTable: string;
    referencedColumns: string[];
    onDelete: string | null;
    onUpdate: string | null;
  }>;
  referencedBy: Array<{ schema: string; table: string; constraint: string }>;
}

export interface QueryResultColumn {
  name: string;
  dataTypeOid: number;
  dataType: string;
}

export interface QueryResult {
  columns: QueryResultColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  rowsAffected: number | null;
  /** True when the row cap trimmed the result set. */
  truncated: boolean;
  durationMs: number;
  classification: SqlClassification;
  /** Populated for EXPLAIN executions. */
  plan: string[] | null;
  notices: string[];
}

export interface QueryHistoryEntry {
  id: string;
  userId: string;
  userEmail: string;
  connectionId: string;
  connectionName: string;
  environment: Environment;
  /** SHA-256 of the normalised statement; raw SQL is stored only for writes. */
  queryHash: string;
  /** Redacted, truncated preview. Literal values are stripped. */
  queryPreview: string;
  classification: SqlClassification;
  success: boolean;
  errorCode: string | null;
  durationMs: number | null;
  rowsReturned: number | null;
  rowsAffected: number | null;
  executedAt: string;
}

export interface WriteModeWindow {
  connectionId: string;
  userId: string;
  activatedAt: string;
  expiresAt: string;
  reason: string;
}

export interface DataBrowserRequest {
  schema: string;
  table: string;
  page: number;
  pageSize: number;
  orderBy: string | null;
  orderDirection: 'asc' | 'desc';
  /** Structured filters only; never raw SQL fragments from the browser. */
  filters: Array<{ column: string; operator: DataFilterOperator; value: string | null }>;
  columns: string[] | null;
}

export const DATA_FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts_with',
  'ends_with',
  'is_null',
  'is_not_null',
] as const;

export type DataFilterOperator = (typeof DATA_FILTER_OPERATORS)[number];

export interface RedisOverview {
  configured: boolean;
  state: HealthState;
  environment: Environment;
  version: string | null;
  uptimeSeconds: number | null;
  usedMemoryBytes: number | null;
  maxMemoryBytes: number | null;
  connectedClients: number | null;
  blockedClients: number | null;
  commandsProcessed: number | null;
  opsPerSecond: number | null;
  keyspaceHits: number | null;
  keyspaceMisses: number | null;
  hitRate: number | null;
  evictedKeys: number | null;
  expiredKeys: number | null;
  totalKeys: number | null;
  /** Per-database key counts from INFO keyspace. */
  keyspace: Array<{ db: string; keys: number; expires: number }>;
  message: string | null;
}
