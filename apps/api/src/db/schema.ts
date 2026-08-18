import { relations, sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema for the console's own database.
 *
 * This is the source of truth for the schema going forward: new tables and
 * columns are added here and generated with drizzle-kit. It is written to match
 * the tables that migrations 0001-0009 already created, so introducing Drizzle
 * required no data migration.
 *
 * Two deliberate boundaries:
 *
 *  1. This schema describes the CONSOLE's database only. The Database Manager
 *     talks to arbitrary external PostgreSQL databases through the raw driver,
 *     because those have schemas the console cannot know (spec section 11).
 *  2. Existing service code still issues raw SQL through `pg` for its queries.
 *     That works and is covered by tests, so it is being converted incrementally
 *     rather than rewritten wholesale.
 */

// citext is a contrib type with no Drizzle builtin; emails need case-insensitive
// comparison so a single identity cannot be duplicated by capitalisation.
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

// inet keeps audit IP addresses queryable by subnet rather than as opaque text.
const inet = customType<{ data: string; driverData: string }>({
  dataType: () => 'inet',
});

export const environmentEnum = pgEnum('environment', [
  'development',
  'testing',
  'staging',
  'production',
]);

export const auditResultEnum = pgEnum('audit_result', ['success', 'failure', 'denied']);

export const applicationKindEnum = pgEnum('application_kind', [
  'api',
  'web',
  'worker',
  'service',
  'cron',
]);

export const healthStateEnum = pgEnum('health_state', [
  'healthy',
  'degraded',
  'down',
  'unknown',
]);

export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending',
  'awaiting_approval',
  'running',
  'succeeded',
  'failed',
  'rolled_back',
  'cancelled',
]);

export const databaseProviderEnum = pgEnum('database_provider', [
  'digitalocean_managed',
  'proxmox_vm',
  'self_hosted',
  'other',
]);

export const sslModeEnum = pgEnum('ssl_mode', ['disable', 'require', 'verify-ca', 'verify-full']);

export const sqlClassificationEnum = pgEnum('sql_classification', [
  'READ',
  'WRITE',
  'DDL',
  'DESTRUCTIVE',
  'UNKNOWN',
]);

export const alertSeverityEnum = pgEnum('alert_severity', ['critical', 'warning', 'info']);

export const operationStatusEnum = pgEnum('operation_status', [
  'completed',
  'in_progress',
  'rejected',
  'failed',
  'awaiting_approval',
]);

export const logLevelEnum = pgEnum('log_level', [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

export const logSourceKindEnum = pgEnum('log_source_kind', [
  'application',
  'container',
  'infrastructure',
  'deployment',
  'audit',
]);

/**
 * Connection types the Connection Manager supports.
 *
 * `provider_kind` was created by migration 0003 for a table that was never used;
 * the Connection Manager reuses the enum and adds `postgres`. SSH is deliberately
 * absent — each system is reached through its own native protocol (spec §26).
 */
export const connectionTypeEnum = pgEnum('connection_type', [
  'digitalocean',
  'proxmox',
  'postgres',
  'redis',
  'prometheus',
  'grafana',
]);

export const connectionStatusEnum = pgEnum('connection_status', [
  'connected',
  'degraded',
  'offline',
  'not_tested',
]);

// ---------------------------------------------------------------- identity ----

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalId: text('external_id').unique(),
  email: citext('email').notNull().unique(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable('roles', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  description: text('description').notNull(),
  environments: environmentEnum('environments').array().notNull().default(sql`'{}'`),
  isSystem: boolean('is_system').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.roleKey, table.permissionKey] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key, { onDelete: 'restrict' }),
    grantedBy: uuid('granted_by').references(() => users.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleKey] }),
    index('user_roles_role_idx').on(table.roleKey),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Only a keyed hash is stored; the raw token lives in the operator's cookie.
    tokenHash: text('token_hash').notNull().unique(),
    mfaVerified: boolean('mfa_verified').notNull().default(false),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (table) => [index('sessions_expiry_idx').on(table.expiresAt)],
);

export const localCredentials = pgTable('local_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  mustChange: boolean('must_change').notNull().default(true),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ------------------------------------------------------------------- audit ----

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sequence: bigserial('sequence', { mode: 'number' }).unique(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Denormalised so history survives user deletion.
    userEmail: citext('user_email').notNull(),
    userRoles: text('user_roles').array().notNull().default(sql`'{}'`),
    action: text('action').notNull(),
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id'),
    resourceLabel: text('resource_label'),
    environment: environmentEnum('environment'),
    result: auditResultEnum('result').notNull(),
    errorCode: text('error_code'),
    message: text('message'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    previousHash: text('previous_hash'),
    recordHash: text('record_hash').notNull(),
  },
  (table) => [
    index('audit_events_occurred_idx').on(table.occurredAt),
    index('audit_events_action_idx').on(table.action, table.occurredAt),
  ],
);

// ------------------------------------------------------------- connections ----

/**
 * The Connection Manager's table (spec sections 3, 23).
 *
 * `configuration` holds non-secret settings only — URLs, ports, hostnames, TLS
 * modes. Every secret goes in `credentialCipher` as an AES-256-GCM envelope bound
 * to this row's id, or is referenced by `credentialRef` when an external secret
 * manager owns it. Neither column is ever selected by a read path that feeds an
 * API response.
 */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    type: connectionTypeEnum('type').notNull(),
    environment: environmentEnum('environment').notNull(),
    description: text('description'),
    // Non-secret settings, shape validated per type by @airaos/validation.
    configuration: jsonb('configuration').notNull().default({}),
    // Envelope-encrypted secret bundle: { v, iv, tag, ciphertext }.
    credentialCipher: jsonb('credential_cipher'),
    // Alternative when an external secret manager holds the value.
    credentialRef: text('credential_ref'),
    isEnabled: boolean('is_enabled').notNull().default(true),
    status: connectionStatusEnum('status').notNull().default('not_tested'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    // Sanitised message. Never contains credential material.
    lastError: text('last_error'),
    latencyMs: integer('latency_ms'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('connections_name_idx').on(table.name),
    index('connections_type_env_idx').on(table.type, table.environment),
    index('connections_enabled_idx').on(table.isEnabled),
    // A connection must be usable: either a sealed secret or a reference to one.
    // Prometheus and Grafana may legitimately need neither, so unauthenticated
    // types are allowed to carry nothing.
    check(
      'connections_secret_present',
      sql`credential_cipher IS NOT NULL OR credential_ref IS NOT NULL OR type IN ('prometheus', 'grafana')`,
    ),
  ],
);

// ------------------------------------------------------------ applications ----

export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    kind: applicationKindEnum('kind').notNull(),
    environment: environmentEnum('environment').notNull(),
    host: text('host'),
    containerName: text('container_name'),
    repository: text('repository'),
    branch: text('branch'),
    version: text('version'),
    commitSha: text('commit_sha'),
    healthUrl: text('health_url'),
    port: integer('port'),
    dependsOn: text('depends_on').array().notNull().default(sql`'{}'`),
    ownerTeam: text('owner_team'),
    operationsEnabled: boolean('operations_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('applications_key_env_idx').on(table.key, table.environment),
    index('applications_env_idx').on(table.environment),
  ],
);

export const applicationHealthChecks = pgTable(
  'application_health_checks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    state: healthStateEnum('state').notNull(),
    httpStatus: integer('http_status'),
    responseTimeMs: integer('response_time_ms'),
    message: text('message'),
    dependencies: jsonb('dependencies').notNull().default([]),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('application_health_checks_app_idx').on(table.applicationId, table.checkedAt)],
);

export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    environment: environmentEnum('environment').notNull(),
    version: text('version').notNull(),
    commitSha: text('commit_sha').notNull(),
    branch: text('branch'),
    status: deploymentStatusEnum('status').notNull().default('pending'),
    triggeredBy: uuid('triggered_by')
      .notNull()
      .references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ciRunUrl: text('ci_run_url'),
    rollbackOf: uuid('rollback_of'),
    message: text('message'),
    logs: text('logs'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('deployments_app_idx').on(table.applicationId, table.createdAt),
    index('deployments_env_status_idx').on(table.environment, table.status),
    // A production deployment can never be approved by the operator who asked
    // for it. Also enforced in the service layer and by a trigger.
    check('deployments_approver_distinct', sql`approved_by IS NULL OR approved_by <> triggered_by`),
  ],
);

// --------------------------------------------------------------- databases ----

/**
 * Managed PostgreSQL targets for the Database Manager.
 *
 * Kept distinct from `connections` on purpose: a database target carries write
 * policy that no other connection type has (read-only override, write windows,
 * query history), and it predates the Connection Manager. The Connections UI
 * presents both under one list.
 */
export const databaseConnections = pgTable(
  'database_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    environment: environmentEnum('environment').notNull(),
    provider: databaseProviderEnum('provider').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(5432),
    database: text('database').notNull(),
    username: text('username').notNull(),
    passwordCipher: jsonb('password_cipher'),
    passwordRef: text('password_ref'),
    sslMode: sslModeEnum('ssl_mode').notNull().default('require'),
    description: text('description'),
    // NULL means "derive from environment": production is read-only by default.
    readOnlyOverride: boolean('read_only_override'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('database_connections_env_idx').on(table.environment)],
);

export const databaseWriteWindows = pgTable(
  'database_write_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => databaseConnections.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    auditEventId: uuid('audit_event_id'),
  },
  (table) => [
    index('database_write_windows_lookup_idx').on(
      table.connectionId,
      table.userId,
      table.expiresAt,
    ),
  ],
);

export const queryHistory = pgTable(
  'query_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    userEmail: citext('user_email').notNull(),
    connectionId: uuid('connection_id').references(() => databaseConnections.id, {
      onDelete: 'set null',
    }),
    connectionName: text('connection_name').notNull(),
    environment: environmentEnum('environment').notNull(),
    queryHash: text('query_hash').notNull(),
    // Literal-stripped preview; full text kept only for statements that wrote.
    queryPreview: text('query_preview').notNull(),
    queryText: text('query_text'),
    classification: sqlClassificationEnum('classification').notNull(),
    success: boolean('success').notNull(),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms'),
    rowsReturned: integer('rows_returned'),
    rowsAffected: integer('rows_affected'),
    truncated: boolean('truncated').notNull().default(false),
    requestId: text('request_id'),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('query_history_user_idx').on(table.userId, table.executedAt),
    index('query_history_conn_idx').on(table.connectionId, table.executedAt),
  ],
);

// ------------------------------------------------------ alerts and settings ----

export const alertAcknowledgements = pgTable('alert_acknowledgements', {
  fingerprint: text('fingerprint').primaryKey(),
  alertName: text('alert_name').notNull(),
  severity: alertSeverityEnum('severity').notNull(),
  environment: environmentEnum('environment'),
  resource: text('resource'),
  summary: text('summary'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
  acknowledgedEmail: citext('acknowledged_email'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  note: text('note'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionDetail: text('resolution_detail'),
  labels: jsonb('labels').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const operationRecords = pgTable(
  'operation_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationKey: text('operation_key').notNull(),
    resourceKind: text('resource_kind').notNull(),
    resourceId: text('resource_id').notNull(),
    resourceLabel: text('resource_label'),
    environment: environmentEnum('environment').notNull(),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedEmail: citext('requested_email').notNull(),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    status: operationStatusEnum('status').notNull(),
    providerActionId: text('provider_action_id'),
    reason: text('reason'),
    message: text('message'),
    auditEventId: uuid('audit_event_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('operation_records_started_idx').on(table.startedAt)],
);

export const consoleSettings = pgTable('console_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const logEntries = pgTable(
  'log_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    level: logLevelEnum('level').notNull(),
    kind: logSourceKindEnum('kind').notNull(),
    environment: environmentEnum('environment').notNull(),
    source: text('source').notNull(),
    // Already passed through secret redaction before insert.
    message: text('message').notNull(),
    fields: jsonb('fields').notNull().default({}),
    requestId: text('request_id'),
    deploymentId: uuid('deployment_id').references(() => deployments.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('log_entries_time_idx').on(table.occurredAt),
    index('log_entries_source_idx').on(table.source, table.occurredAt),
  ],
);

export const schemaMigrations = pgTable('schema_migrations', {
  name: text('name').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer('duration_ms').notNull(),
});

// ----------------------------------------------------------------- relations ---

export const usersRelations = relations(users, ({ many }) => ({
  roles: many(userRoles),
  sessions: many(sessions),
  connections: many(connections),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleKey], references: [roles.key] }),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  permissions: many(rolePermissions),
  users: many(userRoles),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleKey], references: [roles.key] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionKey],
    references: [permissions.key],
  }),
}));

export const connectionsRelations = relations(connections, ({ one }) => ({
  createdByUser: one(users, { fields: [connections.createdBy], references: [users.id] }),
}));

export const applicationsRelations = relations(applications, ({ many }) => ({
  healthChecks: many(applicationHealthChecks),
  deployments: many(deployments),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  application: one(applications, {
    fields: [deployments.applicationId],
    references: [applications.id],
  }),
  triggeredByUser: one(users, { fields: [deployments.triggeredBy], references: [users.id] }),
}));

export const databaseConnectionsRelations = relations(databaseConnections, ({ many }) => ({
  writeWindows: many(databaseWriteWindows),
  queries: many(queryHistory),
}));

/** Inferred row types, used instead of hand-written interfaces in new code. */
export type ConnectionRow = typeof connections.$inferSelect;
export type NewConnectionRow = typeof connections.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
export type DatabaseConnectionRow = typeof databaseConnections.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
