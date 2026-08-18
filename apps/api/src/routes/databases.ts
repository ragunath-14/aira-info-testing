import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  activateWriteModeSchema,
  createDatabaseConnectionSchema,
  dataBrowserSchema,
  executeQuerySchema,
  explorerParamsSchema,
  pgIdentifierSchema,
  queryHistorySchema,
  relationParamsSchema,
  updateDatabaseConnectionSchema,
  uuidSchema,
} from '@airaos/validation';
import { errors } from '../utils/errors.js';
import { ok, noStore } from '../utils/reply.js';
import { parse } from '../utils/validate.js';
import { requireUser } from '../auth/plugin.js';
import { visibleEnvironments } from '../rbac/index.js';
import * as audit from '../audit/service.js';
import * as connections from '../providers/databases/connection-manager.js';
import * as introspection from '../providers/databases/introspection.js';
import * as executor from '../providers/databases/query-executor.js';
import * as browser from '../providers/databases/data-browser.js';
import * as policy from '../providers/databases/policy.js';
import { classify } from '../providers/databases/query-classifier.js';

/**
 * Database Manager routes (spec sections 16-24).
 *
 * Invariants enforced here rather than in the UI:
 *
 *  - No response ever carries a password, cipher blob or DSN.
 *  - Every route resolves the connection through `requireConnection`, which
 *    checks the caller's environment access from the stored row.
 *  - Execution is refused unless the policy layer agrees, and the refusal is
 *    recorded in query history and the audit trail.
 */
export async function registerDatabaseRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('database.view') };
  const run = { preHandler: app.requirePermission('database.query') };
  const admin = { preHandler: app.requirePermission('database.admin') };

  // ------------------------------------------------------------ connections ---

  app.get('/connections', view, async (request, reply) => {
    const user = requireUser(request);
    const items = await connections.listConnections(visibleEnvironments(user));
    const windows = await policy.listActiveWindows(user.id);

    noStore(reply);
    return ok(request, {
      items: items.map((connection) => ({
        ...connection,
        readOnly: policy.isReadOnlyByDefault(connection),
        writeWindow: windows.find((window) => window.connectionId === connection.id) ?? null,
      })),
    });
  });

  app.get('/connections/:connectionId/status', view, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const connection = await connections.requireConnection(connectionId, visibleEnvironments(user));

    noStore(reply);
    return ok(request, await introspection.connectionStatus(connection));
  });

  app.post('/connections/:connectionId/test', view, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const connection = await connections.requireConnection(connectionId, visibleEnvironments(user));
    const result = await connections.testConnection(connectionId);

    await audit.record(request, {
      action: 'TEST_DATABASE_CONNECTION',
      resourceKind: 'database',
      resourceId: connectionId,
      resourceLabel: connection.name,
      environment: connection.environment,
      result: result.ok ? 'success' : 'failure',
      message: result.ok ? 'Connection succeeded.' : result.message,
    });

    noStore(reply);
    return ok(request, result);
  });

  app.post('/connections', admin, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(createDatabaseConnectionSchema, request.body);

    if (!user.environments.includes(body.environment)) {
      throw errors.environmentForbidden(body.environment);
    }

    const connection = await connections.createConnection(
      { ...body, description: body.description ?? null, readOnlyOverride: body.readOnlyOverride ?? null },
      user.id,
    );

    await audit.record(request, {
      action: 'CREATE_DATABASE_CONNECTION',
      resourceKind: 'database',
      resourceId: connection.id,
      resourceLabel: connection.name,
      environment: connection.environment,
      result: 'success',
      message: `Registered ${connection.host}:${connection.port}/${connection.database}.`,
      // The password is not in metadata; only non-secret connection facts are.
      metadata: { host: connection.host, database: connection.database, sslMode: connection.sslMode },
    });

    noStore(reply);
    return ok(request, connection);
  });

  app.patch('/connections/:connectionId', admin, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const body = parse(updateDatabaseConnectionSchema, request.body);
    const existing = await connections.requireConnection(connectionId, visibleEnvironments(user));

    const updated = await connections.updateConnection(connectionId, body);

    await audit.record(request, {
      action: 'UPDATE_DATABASE_CONNECTION',
      resourceKind: 'database',
      resourceId: connectionId,
      resourceLabel: existing.name,
      environment: existing.environment,
      result: 'success',
      message: 'Connection settings changed.',
      metadata: { fields: Object.keys(body).filter((key) => key !== 'password') },
    });

    noStore(reply);
    return ok(request, updated);
  });

  app.delete('/connections/:connectionId', admin, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const existing = await connections.requireConnection(connectionId, visibleEnvironments(user));

    await connections.deleteConnection(connectionId);
    await audit.record(request, {
      action: 'DELETE_DATABASE_CONNECTION',
      resourceKind: 'database',
      resourceId: connectionId,
      resourceLabel: existing.name,
      environment: existing.environment,
      result: 'success',
      message: 'Connection removed from the console. The database itself is untouched.',
    });

    noStore(reply);
    return ok(request, { deleted: true });
  });

  // --------------------------------------------------------------- explorer ---

  app.get('/connections/:connectionId/schemas', view, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(explorerParamsSchema, {
      ...(request.params as object),
      ...(request.query as object),
    });
    await connections.requireConnection(connectionId, visibleEnvironments(user));

    noStore(reply);
    return ok(request, { items: await introspection.listSchemas(connectionId) });
  });

  app.get('/connections/:connectionId/schemas/:schema/relations', view, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId, schema } = parse(
      z.object({ connectionId: uuidSchema, schema: pgIdentifierSchema }),
      request.params,
    );
    await connections.requireConnection(connectionId, visibleEnvironments(user));

    noStore(reply);
    return ok(request, { items: await introspection.listRelations(connectionId, schema) });
  });

  app.get('/connections/:connectionId/schemas/:schema/objects', view, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId, schema } = parse(
      z.object({ connectionId: uuidSchema, schema: pgIdentifierSchema }),
      request.params,
    );
    await connections.requireConnection(connectionId, visibleEnvironments(user));

    noStore(reply);
    return ok(request, await introspection.listSchemaObjects(connectionId, schema));
  });

  app.get(
    '/connections/:connectionId/schemas/:schema/relations/:relation',
    view,
    async (request, reply) => {
      const user = requireUser(request);
      const { connectionId, schema, relation } = parse(relationParamsSchema, request.params);
      await connections.requireConnection(connectionId, visibleEnvironments(user));

      noStore(reply);
      return ok(request, await introspection.getRelationDetail(connectionId, schema, relation));
    },
  );

  // ----------------------------------------------------------- data browser ---

  app.post('/connections/:connectionId/browse', run, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(dataBrowserSchema, {
      ...(request.body as object),
      ...(request.params as object),
    });
    const connection = await connections.requireConnection(
      body.connectionId,
      visibleEnvironments(user),
    );

    const outcome = await browser.browse(connection, {
      schema: body.schema,
      table: body.table,
      page: body.page,
      pageSize: body.pageSize,
      orderBy: body.orderBy ?? null,
      orderDirection: body.orderDirection,
      filters: body.filters.map((filter) => ({
        column: filter.column,
        operator: filter.operator,
        value: filter.value ?? null,
      })),
      columns: body.columns ?? null,
    });

    noStore(reply);
    return ok(request, outcome);
  });

  app.post('/connections/:connectionId/browse/export', view, async (request, reply) => {
    const user = requireUser(request);
    if (!user.permissions.includes('logs.export') && !user.permissions.includes('database.admin')) {
      // Exporting rows takes data out of the console, so it needs an explicit
      // grant rather than riding on `database.view`.
      throw errors.forbidden('Exporting data requires the logs.export or database.admin permission.');
    }

    const body = parse(dataBrowserSchema, {
      ...(request.body as object),
      ...(request.params as object),
    });
    const connection = await connections.requireConnection(
      body.connectionId,
      visibleEnvironments(user),
    );

    const csv = await browser.exportCsv(connection, {
      schema: body.schema,
      table: body.table,
      page: body.page,
      pageSize: body.pageSize,
      orderBy: body.orderBy ?? null,
      orderDirection: body.orderDirection,
      filters: body.filters.map((filter) => ({
        column: filter.column,
        operator: filter.operator,
        value: filter.value ?? null,
      })),
      columns: body.columns ?? null,
    });

    await audit.record(request, {
      action: 'EXPORT_TABLE_DATA',
      resourceKind: 'database',
      resourceId: connection.id,
      resourceLabel: `${body.schema}.${body.table}`,
      environment: connection.environment,
      result: 'success',
      message: `Exported up to ${body.pageSize} row(s) as CSV.`,
      metadata: { schema: body.schema, table: body.table, rows: body.pageSize },
    });

    noStore(reply);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${body.schema}.${body.table}.csv"`,
      )
      .send(csv);
  });

  // ------------------------------------------------------------- sql editor ---

  /**
   * Classifies a statement without running it. The editor calls this as the
   * operator types so the danger banner appears before they press execute.
   */
  app.post('/classify', run, async (request, reply) => {
    const body = parse(z.object({ sql: z.string().max(100_000) }), request.body);
    noStore(reply);
    return ok(request, classify(body.sql));
  });

  app.post('/execute', run, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(executeQuerySchema, request.body);
    const connection = await connections.requireConnection(
      body.connectionId,
      visibleEnvironments(user),
    );

    const outcome = await executor.execute(user, connection, {
      sql: body.sql,
      maxRows: body.maxRows,
      timeoutMs: body.timeoutMs,
      reason: body.reason,
      requestId: request.id,
    });

    // Reads are recorded in query history only; anything that changed data also
    // gets an audit event, because that is a privileged action.
    if (outcome.classification.classification !== 'READ') {
      await audit.record(request, {
        action: 'EXECUTE_SQL',
        resourceKind: 'database',
        resourceId: connection.id,
        resourceLabel: connection.name,
        environment: connection.environment,
        result: 'success',
        message: `Executed a ${outcome.classification.classification} statement.`,
        metadata: {
          classification: outcome.classification.classification,
          rowsAffected: outcome.result.rowsAffected,
          statements: outcome.classification.statements.length,
          reason: body.reason,
        },
      });
    }

    noStore(reply);
    return ok(request, outcome);
  });

  // ----------------------------------------------------------- write windows ---

  app.get('/write-windows', view, async (request, reply) => {
    const user = requireUser(request);
    noStore(reply);
    return ok(request, { items: await policy.listActiveWindows(user.id) });
  });

  app.post('/write-windows', { preHandler: app.requirePermission('database.write') }, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(activateWriteModeSchema, request.body);
    const connection = await connections.requireConnection(
      body.connectionId,
      visibleEnvironments(user),
    );

    let window;
    try {
      window = await policy.activateWriteWindow(user, connection, {
        confirmation: body.confirmation,
        reason: body.reason,
        minutes: body.minutes,
      });
    } catch (error) {
      await audit.record(request, {
        action: 'ACTIVATE_DATABASE_WRITE_MODE',
        resourceKind: 'database',
        resourceId: connection.id,
        resourceLabel: connection.name,
        environment: connection.environment,
        result: 'denied',
        errorCode: (error as { code?: string }).code ?? null,
        message: error instanceof Error ? error.message : 'Refused.',
      });
      throw error;
    }

    // Strict: if this audit write fails the window is rolled back, because an
    // unaudited write window is exactly what rule 6 forbids.
    try {
      await audit.record(
        request,
        {
          action: 'ACTIVATE_DATABASE_WRITE_MODE',
          resourceKind: 'database',
          resourceId: connection.id,
          resourceLabel: connection.name,
          environment: connection.environment,
          result: 'success',
          message: `Write mode open until ${window.expiresAt}.`,
          metadata: { reason: body.reason, minutes: body.minutes },
        },
        { strict: true },
      );
    } catch (error) {
      await policy.revokeWriteWindows(connection.id, user.id);
      throw error;
    }

    noStore(reply);
    return ok(request, window);
  });

  app.delete('/write-windows/:connectionId', view, async (request, reply) => {
    const user = requireUser(request);
    const { connectionId } = parse(z.object({ connectionId: uuidSchema }), request.params);
    const connection = await connections.requireConnection(connectionId, visibleEnvironments(user));
    const revoked = await policy.revokeWriteWindows(connectionId, user.id);

    if (revoked > 0) {
      await audit.record(request, {
        action: 'CLOSE_DATABASE_WRITE_MODE',
        resourceKind: 'database',
        resourceId: connectionId,
        resourceLabel: connection.name,
        environment: connection.environment,
        result: 'success',
        message: 'Write mode closed early.',
      });
    }

    noStore(reply);
    return ok(request, { revoked });
  });

  // ---------------------------------------------------------- query history ---

  app.get('/history', view, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(queryHistorySchema, request.query);

    noStore(reply);
    return ok(
      request,
      await executor.history({
        ...query,
        visibleEnvironments: visibleEnvironments(user),
      }),
    );
  });
}
