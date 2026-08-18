import type { AuthenticatedUser, Paginated, Role, RoleDefinition } from '@airaos/types';
import { ROLE_DEFINITIONS, ROLES } from '@airaos/types';
import { and, count, eq, gt, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { orm, schema, type DbOrTx } from '../db/drizzle.js';
import { errors } from '../utils/errors.js';
import { resolveGrants } from '../rbac/index.js';
import { revokeAllSessionsForUser } from '../auth/session.js';

/**
 * Console user and role administration (spec section 29).
 *
 * Identity lives in AIRAOS; what is managed here is which console role an
 * identity holds. Two safeguards apply:
 *
 *  - An owner cannot remove their own last owner role, and the console refuses to
 *    leave itself with zero owners.
 *  - Changing or removing roles revokes the affected user's sessions, so a
 *    downgrade takes effect immediately rather than at the next login.
 */

export interface ConsoleUser {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  roles: Role[];
  permissionCount: number;
  environments: string[];
  mfaVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  activeSessions: number;
}

interface BaseUserRow {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  mfaVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

function toConsoleUser(
  row: BaseUserRow,
  roleKeys: string[],
  activeSessions: number,
): ConsoleUser {
  const roles = roleKeys.filter((role): role is Role =>
    (ROLES as readonly string[]).includes(role),
  );
  const grants = resolveGrants(roles);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isActive: row.isActive,
    roles,
    permissionCount: grants.permissions.size,
    environments: [...grants.environments],
    mfaVerifiedAt: row.mfaVerifiedAt?.toISOString() ?? null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    activeSessions,
  };
}

const USER_COLUMNS = {
  id: schema.users.id,
  email: schema.users.email,
  name: schema.users.name,
  isActive: schema.users.isActive,
  mfaVerifiedAt: schema.users.mfaVerifiedAt,
  lastLoginAt: schema.users.lastLoginAt,
  createdAt: schema.users.createdAt,
} as const;

/**
 * Loads roles and live session counts for a page of users.
 *
 * Two extra indexed lookups rather than an aggregate join: the join form needed
 * `array_agg` plus a correlated subquery, and grouped correctly it is no faster.
 */
async function decorate(rows: BaseUserRow[]): Promise<ConsoleUser[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [roleRows, sessionRows] = await Promise.all([
    orm()
      .select({ userId: schema.userRoles.userId, roleKey: schema.userRoles.roleKey })
      .from(schema.userRoles)
      .where(inArray(schema.userRoles.userId, ids))
      .orderBy(schema.userRoles.roleKey),
    orm()
      .select({ userId: schema.sessions.userId, count: count() })
      .from(schema.sessions)
      .where(
        and(
          inArray(schema.sessions.userId, ids),
          isNull(schema.sessions.revokedAt),
          gt(schema.sessions.expiresAt, sql`now()`),
        ),
      )
      .groupBy(schema.sessions.userId),
  ]);

  const rolesByUser = new Map<string, string[]>();
  for (const row of roleRows) {
    const existing = rolesByUser.get(row.userId);
    if (existing) existing.push(row.roleKey);
    else rolesByUser.set(row.userId, [row.roleKey]);
  }

  const sessionsByUser = new Map(sessionRows.map((row) => [row.userId, Number(row.count)]));

  return rows.map((row) =>
    toConsoleUser(row, rolesByUser.get(row.id) ?? [], sessionsByUser.get(row.id) ?? 0),
  );
}

export async function listUsers(filters: {
  search?: string;
  role?: Role;
  active?: boolean;
  page: number;
  pageSize: number;
}): Promise<Paginated<ConsoleUser>> {
  const conditions: SQL[] = [];

  if (filters.search) {
    const term = `%${filters.search}%`;
    conditions.push(
      or(ilike(schema.users.email, term), ilike(schema.users.name, term)) as SQL,
    );
  }
  if (filters.active !== undefined) {
    conditions.push(eq(schema.users.isActive, filters.active));
  }
  if (filters.role) {
    conditions.push(
      inArray(
        schema.users.id,
        orm()
          .select({ userId: schema.userRoles.userId })
          .from(schema.userRoles)
          .where(eq(schema.userRoles.roleKey, filters.role)),
      ),
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (filters.page - 1) * filters.pageSize;

  const [rows, totals] = await Promise.all([
    orm()
      .select(USER_COLUMNS)
      .from(schema.users)
      .where(where)
      .orderBy(schema.users.email)
      .limit(filters.pageSize)
      .offset(offset),
    orm().select({ count: count() }).from(schema.users).where(where),
  ]);

  const totalCount = Number(totals[0]?.count ?? 0);
  return {
    items: await decorate(rows),
    page: filters.page,
    pageSize: filters.pageSize,
    total: totalCount,
    hasMore: filters.page * filters.pageSize < totalCount,
  };
}

export async function getUser(userId: string): Promise<ConsoleUser> {
  const [row] = await orm()
    .select(USER_COLUMNS)
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!row) throw errors.notFound('User');
  const [user] = await decorate([row]);
  if (!user) throw errors.notFound('User');
  return user;
}

/** Number of active owners other than `excludeUserId`. */
async function otherActiveOwners(tx: DbOrTx, excludeUserId: string): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(schema.userRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
    .where(
      and(
        eq(schema.userRoles.roleKey, 'owner'),
        eq(schema.users.isActive, true),
        ne(schema.userRoles.userId, excludeUserId),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Replaces a user's roles. Rejects the change if it would leave the console with
 * no owner, which would lock everyone out of user administration.
 */
export async function assignRoles(
  actor: AuthenticatedUser,
  userId: string,
  roles: Role[],
): Promise<ConsoleUser> {
  const unique = [...new Set(roles)];
  const invalid = unique.filter((role) => !(ROLES as readonly string[]).includes(role));
  if (invalid.length > 0) {
    throw errors.validation([{ path: 'roles', message: `Unknown role(s): ${invalid.join(', ')}` }]);
  }

  await orm().transaction(async (tx) => {
    const [target] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!target) throw errors.notFound('User');

    const isRemovingOwner = !unique.includes('owner');
    if (isRemovingOwner && (await otherActiveOwners(tx, userId)) === 0) {
      throw errors.conflict(
        'This is the last active owner. Grant the owner role to someone else before removing it here.',
      );
    }

    await tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
    if (unique.length > 0) {
      await tx
        .insert(schema.userRoles)
        .values(unique.map((role) => ({ userId, roleKey: role, grantedBy: actor.id })));
    }
  });

  // A permission change must not wait for the next login to take effect.
  await revokeAllSessionsForUser(userId, 'roles_changed');

  return getUser(userId);
}

export async function setActive(
  actor: AuthenticatedUser,
  userId: string,
  isActive: boolean,
): Promise<ConsoleUser> {
  if (!isActive && userId === actor.id) {
    throw errors.conflict('You cannot deactivate your own account.');
  }

  if (!isActive && (await otherActiveOwners(orm(), userId)) === 0) {
    throw errors.conflict('Deactivating this account would leave the console with no active owner.');
  }

  const result = await orm()
    .update(schema.users)
    .set({ isActive })
    .where(eq(schema.users.id, userId));
  if ((result.rowCount ?? 0) === 0) throw errors.notFound('User');

  if (!isActive) {
    await revokeAllSessionsForUser(userId, 'deactivated');
  }

  return getUser(userId);
}

/** Role catalogue for the Roles page, straight from the enforced definitions. */
export function roleCatalogue(): RoleDefinition[] {
  return ROLES.map((role) => ROLE_DEFINITIONS[role]);
}
