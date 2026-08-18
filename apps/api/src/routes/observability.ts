import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  alertAcknowledgeSchema,
  alertQuerySchema,
  alertResolveSchema,
  logQuerySchema,
  logTailSchema,
  metricQuerySchema,
} from '@airaos/validation';
import { errors } from '../utils/errors.js';
import { ok, noStore } from '../utils/reply.js';
import { parse } from '../utils/validate.js';
import { requireUser } from '../auth/plugin.js';
import { visibleEnvironments } from '../rbac/index.js';
import * as audit from '../audit/service.js';
import * as prometheus from '../providers/prometheus/service.js';
import * as alertmanager from '../providers/alertmanager/service.js';
import * as redisProvider from '../providers/redis/service.js';
import * as logs from '../services/logs.js';

/**
 * Monitoring, logs, alerts and Redis routes.
 *
 * Metric requests name a preset rather than carrying PromQL, so the browser
 * cannot craft an expression that reads unrelated series or costs the TSDB a
 * full scan (see providers/prometheus/presets.ts).
 */
export async function registerMonitoringRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('infra.view') };

  app.get('/presets', view, async (request, reply) => {
    noStore(reply);
    return ok(request, {
      items: prometheus.listPresets(),
      configured: await prometheus.configured(),
      grafana: await prometheus.grafanaLinks(),
    });
  });

  app.get('/metric', view, async (request, reply) => {
    const query = parse(metricQuerySchema, request.query);
    noStore(reply);
    return ok(
      request,
      await prometheus.summary(query.preset, {
        target: query.target,
        rangeMinutes: query.rangeMinutes,
        withSeries: true,
      }),
    );
  });

  app.post('/metrics', view, async (request, reply) => {
    const body = parse(
      z.object({
        requests: z
          .array(
            z.object({
              preset: metricQuerySchema.shape.preset,
              target: metricQuerySchema.shape.target,
              withSeries: z.boolean().default(false),
              rangeMinutes: z.coerce.number().int().min(5).max(10_080).default(60),
            }),
          )
          // Bounded so one request cannot fan out into hundreds of Prometheus
          // queries.
          .min(1)
          .max(12),
      }),
      request.body,
    );

    noStore(reply);
    return ok(request, { items: await prometheus.summaries(body.requests) });
  });

  app.get('/redis', view, async (request, reply) => {
    const result = await redisProvider.overview();
    noStore(reply);
    return ok(request, result.value, { cachedAgeMs: result.cachedAgeMs });
  });
}

export async function registerAlertRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('alerts.view') };
  const manage = { preHandler: app.requirePermission('alerts.manage') };

  app.get('/', view, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(alertQuerySchema, request.query);

    const result = await alertmanager.listAlerts({
      ...query,
      visibleEnvironments: visibleEnvironments(user),
    });

    const offset = (query.page - 1) * query.pageSize;
    const page = result.items.slice(offset, offset + query.pageSize);

    noStore(reply);
    return ok(
      request,
      {
        items: page,
        page: query.page,
        pageSize: query.pageSize,
        total: result.items.length,
        hasMore: offset + query.pageSize < result.items.length,
        configured: alertmanager.configured(),
        counts: {
          critical: result.items.filter((alert) => alert.severity === 'critical').length,
          warning: result.items.filter((alert) => alert.severity === 'warning').length,
          info: result.items.filter((alert) => alert.severity === 'info').length,
          unacknowledged: result.items.filter((alert) => !alert.acknowledgement).length,
        },
      },
      { cachedAgeMs: result.cachedAgeMs },
    );
  });

  app.post('/acknowledge', manage, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(alertAcknowledgeSchema, request.body);

    const alert = await alertmanager.findAlert(body.fingerprint);
    if (!alert) throw errors.notFound('Alert');
    if (alert.environment && !user.environments.includes(alert.environment)) {
      throw errors.environmentForbidden(alert.environment);
    }

    await alertmanager.acknowledge(alert, user, body.note ?? null);
    await audit.record(request, {
      action: 'ACKNOWLEDGE_ALERT',
      resourceKind: 'alert',
      resourceId: body.fingerprint,
      resourceLabel: alert.name,
      environment: alert.environment,
      result: 'success',
      message: 'Alert acknowledged. The underlying condition is unchanged.',
      metadata: { severity: alert.severity, note: body.note },
    });

    noStore(reply);
    return ok(request, { acknowledged: true });
  });

  app.post('/resolve', manage, async (request, reply) => {
    const user = requireUser(request);
    const body = parse(alertResolveSchema, request.body);

    const alert = await alertmanager.findAlert(body.fingerprint);
    if (alert?.environment && !user.environments.includes(alert.environment)) {
      throw errors.environmentForbidden(alert.environment);
    }

    await alertmanager.resolve(body.fingerprint, body.resolutionDetail);
    await audit.record(request, {
      action: 'RESOLVE_ALERT',
      resourceKind: 'alert',
      resourceId: body.fingerprint,
      resourceLabel: alert?.name ?? body.fingerprint,
      environment: alert?.environment ?? null,
      result: 'success',
      message: 'Resolution recorded.',
      metadata: { detail: body.resolutionDetail },
    });

    noStore(reply);
    return ok(request, { resolved: true });
  });
}

export async function registerLogRoutes(app: FastifyInstance): Promise<void> {
  const view = { preHandler: app.requirePermission('logs.view') };

  app.get('/sources', view, async (request, reply) => {
    const user = requireUser(request);
    noStore(reply);
    return ok(request, { items: await logs.listSources(user) });
  });

  app.get('/', view, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(logQuerySchema, request.query);

    const result = await logs.search(user, {
      sources: query.sources,
      kinds: query.kinds,
      environments: query.environments,
      levels: query.levels,
      search: query.search ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      limit: query.limit,
      cursor: query.cursor ?? null,
      errorsOnly: query.errorsOnly,
    });

    noStore(reply);
    return ok(request, result);
  });

  app.get('/export', { preHandler: app.requirePermission('logs.export') }, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(logQuerySchema, request.query);

    const result = await logs.search(user, {
      sources: query.sources,
      kinds: query.kinds,
      environments: query.environments,
      levels: query.levels,
      search: query.search ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      limit: Math.min(query.limit, 1000),
      cursor: null,
      errorsOnly: query.errorsOnly,
    });

    await audit.record(request, {
      action: 'EXPORT_LOGS',
      resourceKind: 'logs',
      resourceId: null,
      environment: query.environments[0] ?? null,
      result: 'success',
      message: `Exported ${result.items.length} log line(s).`,
      metadata: { sources: query.sources, levels: query.levels, errorsOnly: query.errorsOnly },
    });

    noStore(reply);
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('content-disposition', 'attachment; filename="airaos-console-logs.txt"')
      // Redaction has already been applied by logs.search.
      .send(logs.toPlainText(result.items));
  });

  /**
   * Live tail over Server-Sent Events (spec section 39).
   *
   * Polls the buffer (or the container log) on an interval and pushes new lines.
   * SSE rather than WebSockets because the stream is one-directional and SSE
   * survives an ordinary HTTP proxy without extra configuration.
   */
  app.get('/tail', view, async (request, reply) => {
    const user = requireUser(request);
    const query = parse(logTailSchema, request.query);

    if (!user.environments.includes(query.environment)) {
      throw errors.environmentForbidden(query.environment);
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Disables proxy buffering, which otherwise holds events until the
      // response closes.
      'x-accel-buffering': 'no',
    });

    let cursor: string | null = null;
    let closed = false;
    const send = (event: string, data: unknown) => {
      if (closed) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const poll = async () => {
      try {
        const result = await logs.search(user, {
          sources: [query.source],
          kinds: [],
          environments: [query.environment],
          levels: query.levels,
          search: null,
          // On the first pass, only fetch a small backlog so the tail starts
          // near "now" instead of replaying the whole buffer.
          from: cursor ? null : new Date(Date.now() - 60_000).toISOString(),
          to: null,
          limit: 100,
          cursor: null,
          errorsOnly: false,
        });

        const fresh = cursor
          ? result.items.filter((entry) => entry.id > cursor!)
          : result.items;

        if (fresh.length > 0) {
          cursor = fresh[0]?.id ?? cursor;
          send('lines', fresh.slice().reverse());
        }
      } catch (error) {
        send('error', { message: 'Log tail interrupted.' });
        request.log.debug({ err: error }, 'log tail poll failed');
      }
    };

    await poll();
    const interval = setInterval(() => void poll(), 3000);
    // Keeps intermediaries from treating a quiet stream as dead.
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(': keep-alive\n\n');
    }, 20_000);

    const cleanup = () => {
      closed = true;
      clearInterval(interval);
      clearInterval(heartbeat);
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
