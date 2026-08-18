import type {
  AuthenticatedUser,
  DatabaseConnection,
  SqlClassification,
  WriteModeWindow,
} from '@airaos/types';
import { config } from '../../config.js';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { orm, schema } from '../../db/drizzle.js';
import { errors } from '../../utils/errors.js';
import { assertConfirmation, hasPermission } from '../../rbac/index.js';

/**
 * Database write policy (spec sections 22, 23, 43).
 *
 * The rules, in the order they are applied:
 *
 *  1. READ is allowed wherever the user holds `database.query`.
 *  2. UNKNOWN is always refused. There is no configuration that permits it.
 *  3. Production is read-only by default and there is no switch that changes
 *     that globally — a write requires `database.admin` plus an open write
 *     window, per connection, per user, time-boxed.
 *  4. Non-production writes require `database.write` and an open write window.
 *  5. DESTRUCTIVE in production requires `database.admin` and is additionally
 *     refused unless the connection is explicitly marked writable.
 *
 * The classifier decides the category; this module decides whether the category
 * is permitted for this user on this connection right now.
 */

export interface WritePolicyDecision {
  allowed: boolean;
  /** Operator-facing reason when not allowed. */
  reason: string | null;
  /** Set when the caller could proceed by opening a write window first. */
  needsWriteWindow: boolean;
  readOnlySession: boolean;
}

/** Effective read-only status for a connection, before any window is considered. */
export function isReadOnlyByDefault(connection: DatabaseConnection): boolean {
  if (connection.readOnlyOverride !== null) return connection.readOnlyOverride;
  return connection.environment === 'production';
}

export async function evaluate(
  user: AuthenticatedUser,
  connection: DatabaseConnection,
  classification: SqlClassification,
): Promise<WritePolicyDecision> {
  const deny = (reason: string, needsWriteWindow = false): WritePolicyDecision => ({
    allowed: false,
    reason,
    needsWriteWindow,
    readOnlySession: true,
  });

  if (!hasPermission(user, 'database.query')) {
    return deny('Running queries requires the database.query permission.');
  }
  if (!user.environments.includes(connection.environment)) {
    return deny(`Your role does not permit access to ${connection.environment} databases.`);
  }

  if (classification === 'READ') {
    return { allowed: true, reason: null, needsWriteWindow: false, readOnlySession: true };
  }

  if (classification === 'UNKNOWN') {
    return deny(
      'The console could not classify this statement as a permitted operation, so it was not run.',
    );
  }

  // Everything below changes data or schema.
  const isProduction = connection.environment === 'production';
  const requiredPermission = isProduction ? 'database.admin' : 'database.write';

  if (!hasPermission(user, requiredPermission)) {
    return deny(
      isProduction
        ? 'Changing production data requires the database.admin permission.'
        : 'Changing data requires the database.write permission.',
    );
  }

  if (isReadOnlyByDefault(connection) && !isProduction) {
    return deny(
      `Connection "${connection.name}" is marked read-only. An administrator must change that before writes are possible.`,
    );
  }

  if (classification === 'DDL' || classification === 'DESTRUCTIVE') {
    if (isProduction && connection.readOnlyOverride !== false) {
      // Production DDL through a console is how schema drift and outages happen.
      // Migrations are the supported path (spec section 25).
      return deny(
        'Schema changes to production are not permitted from the console. Use a reviewed migration.',
      );
    }
    if (classification === 'DESTRUCTIVE' && !hasPermission(user, 'database.admin')) {
      return deny('DROP and TRUNCATE require the database.admin permission.');
    }
  }

  const window = await activeWriteWindow(connection.id, user.id);
  if (!window) {
    return deny(
      `Activate a write window on "${connection.name}" before running statements that change data.`,
      true,
    );
  }

  return { allowed: true, reason: null, needsWriteWindow: false, readOnlySession: false };
}

export function assertAllowed(decision: WritePolicyDecision, environment: string): void {
  if (decision.allowed) return;
  if (decision.needsWriteWindow) throw errors.writeModeRequired();
  if (environment === 'production' && decision.reason?.includes('read-only')) {
    throw errors.readOnlyMode(environment);
  }
  throw errors.queryRejected(decision.reason ?? 'Statement not permitted.');
}

// ---------------------------------------------------------- write windows ----

const windows = schema.databaseWriteWindows;

const WINDOW_COLUMNS = {
  connectionId: windows.connectionId,
  userId: windows.userId,
  reason: windows.reason,
  activatedAt: windows.activatedAt,
  expiresAt: windows.expiresAt,
} as const;

/** A window is live only while un-revoked and unexpired; both are checked in SQL. */
function liveWindow() {
  return and(isNull(windows.revokedAt), gt(windows.expiresAt, sql`now()`));
}

function toWindow(row: {
  connectionId: string;
  userId: string;
  reason: string;
  activatedAt: Date;
  expiresAt: Date;
}): WriteModeWindow {
  return {
    connectionId: row.connectionId,
    userId: row.userId,
    activatedAt: row.activatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    reason: row.reason,
  };
}

export async function activeWriteWindow(
  connectionId: string,
  userId: string,
): Promise<WriteModeWindow | null> {
  const [row] = await orm()
    .select(WINDOW_COLUMNS)
    .from(windows)
    .where(
      and(eq(windows.connectionId, connectionId), eq(windows.userId, userId), liveWindow()),
    )
    .orderBy(desc(windows.expiresAt))
    .limit(1);

  return row ? toWindow(row) : null;
}

/**
 * Opens a write window. The caller must hold the right permission for the
 * environment and retype the connection name, which is what makes "I meant
 * staging" impossible to do silently (rule 12).
 */
export async function activateWriteWindow(
  user: AuthenticatedUser,
  connection: DatabaseConnection,
  input: { confirmation: string; reason: string; minutes?: number },
): Promise<WriteModeWindow> {
  const cfg = config();
  const isProduction = connection.environment === 'production';
  const requiredPermission = isProduction ? 'database.admin' : 'database.write';

  if (!hasPermission(user, requiredPermission)) {
    throw errors.forbidden(
      isProduction
        ? 'Opening a production write window requires the database.admin permission.'
        : 'Opening a write window requires the database.write permission.',
    );
  }
  if (!user.environments.includes(connection.environment)) {
    throw errors.environmentForbidden(connection.environment);
  }
  if (isReadOnlyByDefault(connection) && connection.readOnlyOverride === true) {
    throw errors.readOnlyMode(connection.environment);
  }

  assertConfirmation(connection.name, input.confirmation);

  const minutes = Math.min(input.minutes ?? cfg.DB_WRITE_MODE_TTL_MINUTES, 60);

  const [row] = await orm()
    .insert(windows)
    .values({
      connectionId: connection.id,
      userId: user.id,
      reason: input.reason,
      // Expiry is computed by the database, so a skewed application clock cannot
      // widen the window.
      expiresAt: sql`now() + (${minutes} || ' minutes')::interval`,
    })
    .returning({ activatedAt: windows.activatedAt, expiresAt: windows.expiresAt });

  if (!row) throw errors.internal({ reason: 'write window insert returned no row' });

  return {
    connectionId: connection.id,
    userId: user.id,
    activatedAt: row.activatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    reason: input.reason,
  };
}

export async function revokeWriteWindows(connectionId: string, userId: string): Promise<number> {
  const result = await orm()
    .update(windows)
    .set({ revokedAt: sql`now()` })
    .where(
      and(eq(windows.connectionId, connectionId), eq(windows.userId, userId), liveWindow()),
    );
  return result.rowCount ?? 0;
}

/** All windows the user currently holds, for the UI's write-mode indicator. */
export async function listActiveWindows(userId: string): Promise<WriteModeWindow[]> {
  const rows = await orm()
    .select(WINDOW_COLUMNS)
    .from(windows)
    .where(and(eq(windows.userId, userId), liveWindow()))
    .orderBy(desc(windows.expiresAt));

  return rows.map(toWindow);
}
