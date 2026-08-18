import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONNECTION_TYPE_PRESENTATION, CONNECTION_TYPES } from '@airaos/types';
import {
  connectionQuerySchema,
  createConnectionSchema,
  setConnectionEnabledSchema,
  testConnectionSchema,
  updateConnectionSchema,
  uuidSchema,
} from '@airaos/validation';
import { ok, noStore } from '../utils/reply.js';
import { parse } from '../utils/validate.js';
import { requireUser } from '../auth/plugin.js';
import * as audit from '../audit/service.js';
import * as connections from '../connections/service.js';
import * as registry from '../providers/registry.js';

/**
 * Connection Manager routes (spec sections 3-6, 31).
 *
 * Permissions: viewing needs `settings.view`, mutating needs `settings.manage`.
 * Testing counts as viewing — it makes no change — but it is still audited,
 * because a test proves a credential works and that is worth a record.
 *
 * No response on any route here can carry a secret: they all return the
 * repository's public projection, which has no field for one (rule 1).
 */
export async function registerConnectionRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('settings.view') };
  const manage = { preHandler: app.requirePermission('settings.manage') };

  /**
   * Catalogue for the Add Connection picker. Served from the type registry so the
   * UI lists exactly what this build can talk to (spec section 6).
   */
  app.get('/types', view, async (request, reply) => {
    const supported = new Set(registry.supportedTypes());
    noStore(reply);
    return ok(request, {
      items: CONNECTION_TYPES.filter((type) => supported.has(type)).map((type) => ({
        type,
        ...CONNECTION_TYPE_PRESENTATION[type],
      })),
    });
  });

  app.get('/', view, async (request, reply) => {
    const user = requireUser(request);
    const filters = parse(connectionQuerySchema, request.query);

    const [items, summary, sources] = await Promise.all([
      connections.list(user, filters),
      connections.summary(user),
      connections.providerSources(),
    ]);

    noStore(reply);
    return ok(request, { items, summary, sources });
  });

  app.get('/:connectionId', view, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);

    noStore(reply);
    return ok(request, await connections.get(user, connectionId));
  });

  /**
   * Tests a candidate configuration that has not been saved yet. Nothing is
   * persisted, so an operator can iterate on the form freely.
   */
  app.post('/test', manage, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(testConnectionSchema, request.body);
    const result = await connections.testCandidate(user, body);

    await audit.record(request, {
      action: 'TEST_CONNECTION',
      resourceKind: 'connection',
      resourceId: null,
      resourceLabel: body.name,
      environment: body.environment,
      result: result.ok ? 'success' : 'failure',
      message: result.message,
      // Only the type and outcome; the candidate credential is never recorded.
      metadata: { type: body.type, latencyMs: result.latencyMs },
    });

    noStore(reply);
    return ok(request, result);
  });

  /** Tests an already-saved connection with its stored credential. */
  app.post('/:connectionId/test', view, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const { connection, result } = await connections.testSaved(user, connectionId);

    await audit.record(request, {
      action: 'TEST_CONNECTION',
      resourceKind: 'connection',
      resourceId: connectionId,
      resourceLabel: connection.name,
      environment: connection.environment,
      result: result.ok ? 'success' : 'failure',
      message: result.message,
      metadata: { type: connection.type, latencyMs: result.latencyMs },
    });

    noStore(reply);
    return ok(request, { connection, result });
  });

  app.post('/', manage, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(createConnectionSchema, request.body);
    const { connection, result } = await connections.create(user, body);

    await audit.record(request, {
      action: 'CREATE_CONNECTION',
      resourceKind: 'connection',
      resourceId: connection.id,
      resourceLabel: connection.name,
      environment: connection.environment,
      result: 'success',
      message: `Registered a ${connection.type} connection.`,
      // Non-secret facts only. `split()` keeps credentials out of configuration.
      metadata: { type: connection.type, configuration: connection.configuration },
    });

    noStore(reply);
    return ok(request, { connection, result });
  });

  app.patch('/:connectionId', manage, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const body = parse(updateConnectionSchema, request.body);

    const before = await connections.get(user, connectionId);
    const updated = await connections.update(user, connectionId, body);

    // Naming a credential change explicitly makes it findable in the trail.
    const credentialFields = ['apiToken', 'writeApiToken', 'tokenSecret', 'password'];
    const changedCredential = credentialFields.some(
      (field) => (body as Record<string, unknown>)[field] !== undefined,
    );

    await audit.record(request, {
      action: changedCredential ? 'CHANGE_CONNECTION_CREDENTIAL' : 'UPDATE_CONNECTION',
      resourceKind: 'connection',
      resourceId: connectionId,
      resourceLabel: before.name,
      environment: before.environment,
      result: 'success',
      message: changedCredential
        ? 'Connection credential replaced. The connection must be tested again.'
        : 'Connection settings changed.',
      metadata: {
        type: before.type,
        // Field names only, never values.
        fields: Object.keys(body).filter((key) => !credentialFields.includes(key)),
        credentialChanged: changedCredential,
      },
    });

    noStore(reply);
    return ok(request, updated);
  });

  app.post('/:connectionId/enabled', manage, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const body = parse(setConnectionEnabledSchema, request.body);

    const updated = await connections.setEnabled(user, connectionId, body.isEnabled);

    await audit.record(request, {
      action: body.isEnabled ? 'ENABLE_CONNECTION' : 'DISABLE_CONNECTION',
      resourceKind: 'connection',
      resourceId: connectionId,
      resourceLabel: updated.name,
      environment: updated.environment,
      result: 'success',
      message: body.isEnabled
        ? 'Connection enabled. Dashboards will use it.'
        : 'Connection disabled. Dashboards fall back to any other configuration.',
      metadata: { type: updated.type },
    });

    noStore(reply);
    return ok(request, updated);
  });

  app.delete('/:connectionId', manage, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const removed = await connections.remove(user, connectionId);

    await audit.record(request, {
      action: 'DELETE_CONNECTION',
      resourceKind: 'connection',
      resourceId: connectionId,
      resourceLabel: removed.name,
      environment: removed.environment,
      result: 'success',
      message: 'Connection removed from the console. The infrastructure itself is untouched.',
      metadata: { type: removed.type },
    });

    noStore(reply);
    return ok(request, { deleted: true, connection: removed });
  });
}
