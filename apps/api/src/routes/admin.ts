import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES } from '@airaos/types';
import { auditQuerySchema, roleAssignmentSchema, settingsUpdateSchema, userQuerySchema, uuidSchema } from '@airaos/validation';
import { ok, noStore } from '../utils/reply.js';
import { parse } from '../utils/validate.js';
import { requireUser } from '../auth/plugin.js';
import * as audit from '../audit/service.js';
import * as users from '../services/users.js';
import * as settings from '../services/settings.js';
import { revokeAllSessionsForUser } from '../auth/session.js';

/**
 * Security and settings routes: users, roles, the audit trail, and console
 * configuration.
 *
 * The audit trail is readable but never writable through the API: there is no
 * route that edits or deletes an event, and the database grants would refuse it
 * even if one existed (rule 6).
 */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('users.view') };
  const manage = { preHandler: app.requirePermission('users.manage') };

  app.get('/', view, async (request, reply) => {
    const query = parse(userQuerySchema, request.query);
    noStore(reply);
    return ok(request, await users.listUsers(query));
  });

  app.get('/roles', view, async (request, reply) => {
    noStore(reply);
    return ok(request, { items: users.roleCatalogue() });
  });

  app.get('/:userId', view, async (request, reply) => {
    const { userId } = parse(z.object({ userId: uuidSchema }), request.params);
    noStore(reply);
    return ok(request, await users.getUser(userId));
  });

  app.put('/:userId/roles', manage, async (request, reply) => {
    const actor = requireUser(request);
    const { userId } = parse(z.object({ userId: uuidSchema }), request.params);
    const body = parse(roleAssignmentSchema.omit({ userId: true }), request.body);

    const before = await users.getUser(userId);
    const updated = await users.assignRoles(actor, userId, body.roles);

    await audit.record(request, {
      action: 'ASSIGN_ROLES',
      resourceKind: 'user',
      resourceId: userId,
      resourceLabel: before.email,
      environment: null,
      result: 'success',
      message: `Roles changed from [${before.roles.join(', ') || 'none'}] to [${updated.roles.join(', ')}].`,
      metadata: { before: before.roles, after: updated.roles },
    });

    noStore(reply);
    return ok(request, updated);
  });

  app.post('/:userId/active', manage, async (request, reply) => {
    const actor = requireUser(request);
    const { userId } = parse(z.object({ userId: uuidSchema }), request.params);
    const body = parse(z.object({ isActive: z.boolean() }), request.body);

    const before = await users.getUser(userId);
    const updated = await users.setActive(actor, userId, body.isActive);

    await audit.record(request, {
      action: body.isActive ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
      resourceKind: 'user',
      resourceId: userId,
      resourceLabel: before.email,
      environment: null,
      result: 'success',
      message: body.isActive ? 'Account reactivated.' : 'Account deactivated and sessions revoked.',
    });

    noStore(reply);
    return ok(request, updated);
  });

  /** Admin revocation of every session a user holds, for offboarding. */
  app.post('/:userId/revoke-sessions', manage, async (request, reply) => {
    const { userId } = parse(z.object({ userId: uuidSchema }), request.params);
    const target = await users.getUser(userId);
    const revoked = await revokeAllSessionsForUser(userId, 'revoked_by_admin');

    await audit.record(request, {
      action: 'REVOKE_USER_SESSIONS',
      resourceKind: 'user',
      resourceId: userId,
      resourceLabel: target.email,
      environment: null,
      result: 'success',
      message: `Revoked ${revoked} session(s).`,
    });

    noStore(reply);
    return ok(request, { revoked });
  });
}

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('audit.view') };

  app.get('/', view, async (request, reply) => {
    const query = parse(auditQuerySchema, request.query);
    noStore(reply);
    return ok(request, await audit.search(query));
  });

  app.get('/actions', view, async (request, reply) => {
    noStore(reply);
    return ok(request, { items: await audit.distinctActions() });
  });

  /**
   * Verifies the hash chain. Recomputing every record's HMAC is the check that
   * makes tampering visible; the endpoint reports the first sequence that fails.
   */
  app.get('/verify', view, async (request, reply) => {
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(100).max(50_000).default(5000) }),
      request.query,
    );

    const result = await audit.verifyChain(limit);

    // A broken chain is itself worth recording — the record of the check joins
    // the chain it just examined.
    await audit.record(request, {
      action: 'VERIFY_AUDIT_CHAIN',
      resourceKind: 'audit',
      resourceId: null,
      environment: null,
      result: result.verified ? 'success' : 'failure',
      message: result.verified
        ? `Verified ${result.checkedCount} record(s).`
        : `Chain broken at sequence ${result.firstBrokenSequence}.`,
    });

    noStore(reply);
    return ok(request, result);
  });
}

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('settings.view') };
  const manage = { preHandler: app.requirePermission('settings.manage') };

  app.get('/', view, async (request, reply) => {
    noStore(reply);
    return ok(request, {
      settings: await settings.listSettings(),
      // Reports which secrets are configured, never their values.
      runtime: settings.runtimeSummary(),
      roles: ROLES,
    });
  });

  app.patch('/', manage, async (request, reply) => {
    const actor = requireUser(request);
    const body = parse(settingsUpdateSchema, request.body);

    const updated = await settings.updateSetting(actor, body.key, body.value);

    await audit.record(request, {
      action: 'UPDATE_SETTING',
      resourceKind: 'setting',
      resourceId: body.key,
      resourceLabel: body.key,
      environment: null,
      result: 'success',
      message: `Setting ${body.key} changed.`,
      metadata: { key: body.key, value: body.value },
    });

    noStore(reply);
    return ok(request, updated);
  });
}
