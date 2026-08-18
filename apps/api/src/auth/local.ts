import { eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { orm, schema } from '../db/drizzle.js';
import { verifyPassword } from '../security/crypto.js';
import { errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { SessionIdentity } from './session.js';

/**
 * Development-only local login.
 *
 * Exists so the console can be run without a live AIRAOS identity provider.
 * Three independent guards keep it out of production: loadConfig refuses to boot
 * with LOCAL_AUTH_ENABLED in production, `assertLocalAuthAvailable` re-checks at
 * request time, and the route is not registered at all when it is disabled.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export function localAuthAvailable(): boolean {
  const cfg = config();
  return cfg.LOCAL_AUTH_ENABLED && !cfg.isProduction;
}

export function assertLocalAuthAvailable(): void {
  if (!localAuthAvailable()) {
    throw errors.forbidden('Local login is disabled on this console instance.');
  }
}

export async function authenticateLocal(
  email: string,
  password: string,
): Promise<SessionIdentity> {
  assertLocalAuthAvailable();

  const [row] = await orm()
    .select({
      userId: schema.localCredentials.userId,
      email: schema.users.email,
      name: schema.users.name,
      isActive: schema.users.isActive,
      passwordHash: schema.localCredentials.passwordHash,
      failedAttempts: schema.localCredentials.failedAttempts,
      lockedUntil: schema.localCredentials.lockedUntil,
    })
    .from(schema.localCredentials)
    .innerJoin(schema.users, eq(schema.users.id, schema.localCredentials.userId))
    .where(eq(schema.users.email, email))
    .limit(1);

  // Same error for unknown user and wrong password: no account enumeration.
  const invalid = errors.unauthenticated('Email or password is incorrect.');

  if (!row) {
    // Spend comparable time so a missing row is not detectably faster.
    verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    throw invalid;
  }
  if (!row.isActive) {
    throw errors.forbidden('This console account has been deactivated.');
  }
  if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60_000);
    throw errors.forbidden(`Too many failed attempts. Try again in ${minutes} minute(s).`);
  }

  if (!verifyPassword(password, row.passwordHash)) {
    const attempts = row.failedAttempts + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    await orm()
      .update(schema.localCredentials)
      .set({
        // On lock the counter resets, so the next window starts clean.
        failedAttempts: lock ? 0 : attempts,
        lockedUntil: lock ? sql`now() + (${LOCK_MINUTES} || ' minutes')::interval` : null,
      })
      .where(eq(schema.localCredentials.userId, row.userId));

    if (lock) {
      logger().warn({ email: row.email }, 'local account locked after repeated failures');
    }
    throw invalid;
  }

  await orm()
    .update(schema.localCredentials)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(schema.localCredentials.userId, row.userId));

  return {
    externalId: null,
    email: row.email,
    name: row.name,
    // Local development sessions are marked MFA-verified because there is no
    // second factor to assert. Production never reaches this path.
    mfaVerified: true,
  };
}
