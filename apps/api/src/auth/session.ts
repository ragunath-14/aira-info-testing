import type { AuthenticatedUser, Role } from '@airaos/types';
import { ROLES } from '@airaos/types';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { orm, schema } from '../db/drizzle.js';
import { generateSessionToken, hashSessionToken } from '../security/crypto.js';
import { resolveGrants } from '../rbac/index.js';
import { errors } from '../utils/errors.js';

/**
 * Session storage and identity resolution.
 *
 * Identity comes from AIRAOS; the console mirrors it into `users` so audit
 * records survive and so console-specific role grants have somewhere to live.
 * Role assignment is console state (managed under Security > Users) and can be
 * bootstrapped from an SSO claim on first login.
 */

export const SESSION_COOKIE = 'airaos_console_session';

export interface SessionIdentity {
  externalId: string | null;
  email: string;
  name: string;
  mfaVerified: boolean;
  /** Roles asserted by the identity provider, used only to bootstrap. */
  assertedRoles?: Role[];
}

export interface CreatedSession {
  token: string;
  user: AuthenticatedUser;
  expiresAt: Date;
}

export interface MirroredUser {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
}

/** Creates or updates the mirrored user record, then returns it. */
export async function upsertUser(identity: SessionIdentity): Promise<MirroredUser> {
  return orm().transaction(async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({
        externalId: identity.externalId,
        email: identity.email,
        name: identity.name,
        mfaVerifiedAt: identity.mfaVerified ? sql`now()` : null,
        lastLoginAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: schema.users.email,
        set: {
          name: sql`excluded.name`,
          // An external id, once known, is never unset by a later login.
          externalId: sql`coalesce(${schema.users.externalId}, excluded.external_id)`,
          mfaVerifiedAt: identity.mfaVerified
            ? sql`now()`
            : sql`${schema.users.mfaVerifiedAt}`,
          lastLoginAt: sql`now()`,
        },
      })
      .returning({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        isActive: schema.users.isActive,
      });

    if (!user) throw new Error('failed to upsert user');
    if (!user.isActive) {
      throw errors.forbidden('This console account has been deactivated.');
    }

    // Bootstrap roles from the IdP only when the user has none yet. After that
    // the console's own grants are authoritative, so revoking a role here is
    // not silently undone by the next login.
    const asserted = (identity.assertedRoles ?? []).filter((role) =>
      (ROLES as readonly string[]).includes(role),
    );
    if (asserted.length > 0) {
      const [existing] = await tx
        .select({ roleKey: schema.userRoles.roleKey })
        .from(schema.userRoles)
        .where(eq(schema.userRoles.userId, user.id))
        .limit(1);

      if (!existing) {
        await tx
          .insert(schema.userRoles)
          .values(asserted.map((role) => ({ userId: user.id, roleKey: role })))
          .onConflictDoNothing();
      }
    }

    return user;
  });
}

export async function rolesForUser(userId: string): Promise<Role[]> {
  const rows = await orm()
    .select({ roleKey: schema.userRoles.roleKey })
    .from(schema.userRoles)
    .where(eq(schema.userRoles.userId, userId))
    .orderBy(schema.userRoles.roleKey);

  return rows
    .map((row) => row.roleKey)
    .filter((role): role is Role => (ROLES as readonly string[]).includes(role));
}

export async function createSession(
  identity: SessionIdentity,
  context: { ipAddress: string | null; userAgent: string | null },
): Promise<CreatedSession> {
  const cfg = config();
  const user = await upsertUser(identity);
  const roles = await rolesForUser(user.id);

  if (roles.length === 0) {
    // Authenticated but not authorised: an operator with no role would otherwise
    // land on an empty console with no explanation.
    throw errors.forbidden(
      'Your AIRAOS account is not yet assigned a console role. Ask an owner to grant one.',
      { email: user.email },
    );
  }

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + cfg.SESSION_TTL_MINUTES * 60_000);

  const [session] = await orm()
    .insert(schema.sessions)
    .values({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      mfaVerified: identity.mfaVerified,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      expiresAt,
    })
    .returning({ id: schema.sessions.id });

  if (!session) throw new Error('failed to create session');

  return {
    token,
    expiresAt,
    user: buildAuthenticatedUser({
      id: user.id,
      email: user.email,
      name: user.name,
      roles,
      mfaVerified: identity.mfaVerified,
      sessionId: session.id,
      sessionExpiresAt: expiresAt,
    }),
  };
}

/**
 * Resolves a raw cookie token to a live session, enforcing absolute expiry,
 * idle timeout, revocation, account deactivation and the MFA requirement.
 *
 * Also refreshes `last_seen_at`, which is what makes the idle timeout sliding.
 */
export async function resolveSession(token: string): Promise<AuthenticatedUser> {
  const cfg = config();
  const [row] = await orm()
    .select({
      sessionId: schema.sessions.id,
      userId: schema.sessions.userId,
      email: schema.users.email,
      name: schema.users.name,
      isActive: schema.users.isActive,
      mfaVerified: schema.sessions.mfaVerified,
      expiresAt: schema.sessions.expiresAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      revokedAt: schema.sessions.revokedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.tokenHash, hashSessionToken(token)))
    .limit(1);

  if (!row) throw errors.unauthenticated();
  if (row.revokedAt) throw errors.sessionExpired();
  if (row.expiresAt.getTime() <= Date.now()) throw errors.sessionExpired();
  if (!row.isActive) throw errors.forbidden('This console account has been deactivated.');

  const idleLimitMs = cfg.SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
  if (Date.now() - row.lastSeenAt.getTime() > idleLimitMs) {
    await revokeSession(row.sessionId, 'idle_timeout');
    throw errors.sessionExpired();
  }

  if (cfg.AUTH_REQUIRE_MFA && !row.mfaVerified) {
    throw errors.mfaRequired();
  }

  const roles = await rolesForUser(row.userId);
  if (roles.length === 0) {
    throw errors.forbidden('Your console role was removed. Ask an owner to restore access.');
  }

  // Fire-and-forget touch: a failed heartbeat must not fail the request.
  void orm()
    .update(schema.sessions)
    .set({ lastSeenAt: sql`now()` })
    .where(eq(schema.sessions.id, row.sessionId))
    .catch(() => undefined);

  return buildAuthenticatedUser({
    id: row.userId,
    email: row.email,
    name: row.name,
    roles,
    mfaVerified: row.mfaVerified,
    sessionId: row.sessionId,
    sessionExpiresAt: row.expiresAt,
  });
}

export function buildAuthenticatedUser(input: {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  mfaVerified: boolean;
  sessionId: string;
  sessionExpiresAt: Date;
}): AuthenticatedUser {
  const grants = resolveGrants(input.roles);
  return {
    id: input.id,
    email: input.email,
    name: input.name,
    roles: input.roles,
    permissions: [...grants.permissions].sort(),
    environments: [...grants.environments],
    mfaVerified: input.mfaVerified,
    sessionId: input.sessionId,
    sessionExpiresAt: input.sessionExpiresAt.toISOString(),
  };
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await orm()
    .update(schema.sessions)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)));
}

export async function revokeAllSessionsForUser(userId: string, reason: string): Promise<number> {
  const result = await orm()
    .update(schema.sessions)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
  return result.rowCount ?? 0;
}

export interface SessionDescriptor {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** Device / session list for the account menu (spec section 28). */
export async function listSessions(
  userId: string,
  currentSessionId: string,
): Promise<SessionDescriptor[]> {
  const rows = await orm()
    .select({
      id: schema.sessions.id,
      ipAddress: schema.sessions.ipAddress,
      userAgent: schema.sessions.userAgent,
      createdAt: schema.sessions.createdAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.userId, userId),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(schema.sessions.lastSeenAt));

  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

/** Cookie options. `secure` is forced on outside development. */
export function sessionCookieOptions(expiresAt: Date) {
  const cfg = config();
  return {
    httpOnly: true,
    // `lax` rather than `strict`: the SSO provider redirects back with a
    // top-level GET, which `strict` would strip the cookie from.
    sameSite: 'lax' as const,
    secure: !cfg.isDevelopment,
    path: '/',
    expires: expiresAt,
  };
}
