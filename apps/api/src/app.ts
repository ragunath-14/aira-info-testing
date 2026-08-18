import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { ApiError } from '@airaos/types';
import { config } from './config.js';
import { loggerOptions } from './utils/logger.js';
import { AppError, isAppError } from './utils/errors.js';
import { formatIssues } from './utils/validate.js';
import { redactString } from './utils/redaction.js';
import { registerSecurity } from './security/plugins.js';
import { registerAuth } from './auth/plugin.js';
import { registerRoutes } from './routes/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = config();

  const app = Fastify({
    logger: loggerOptions(),
    // The console sits behind its own reverse proxy; client IPs in the audit
    // trail come from X-Forwarded-For, which only that proxy may set.
    trustProxy: true,
    bodyLimit: 1_048_576,
    // Correlates a browser action, the API log line and the audit record.
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      if (typeof supplied === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(supplied)) {
        return supplied;
      }
      return randomUUID();
    },
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  await registerSecurity(app);
  await registerAuth(app);

  // Error handling is installed BEFORE routes, and the ordering is load-bearing.
  // `registerRoutes` awaits `app.register(...)`, which loads the encapsulated
  // /api/v1 context immediately; a child context inherits the error handler that
  // exists at the moment it is created. Registering these afterwards would leave
  // every /api/v1 error falling through to Fastify's default handler, which
  // reads `error.statusCode` (AppError carries `httpStatus`) and so would answer
  // 500 with a body that is not the documented envelope.
  app.setNotFoundHandler((request, reply) => {
    const body: ApiError = {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'No such endpoint.', retryable: false },
      meta: { requestId: request.id, generatedAt: new Date().toISOString() },
    };
    reply.status(404).send(body);
  });

  /**
   * Single error boundary. Clients receive a stable code plus operator-facing
   * prose; stack traces, provider payloads and credentials stay in the log
   * (spec section 36, rule 1).
   */
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof ZodError) {
      return reply.status(400).send(errorBody('VALIDATION_FAILED', 'The request was rejected by validation.', requestId, {
        details: formatIssues(error),
      }));
    }

    if (isAppError(error)) {
      const level = error.httpStatus >= 500 ? 'error' : 'warn';
      request.log[level](
        {
          err: error,
          code: error.code,
          internal: error.internal,
          userId: request.user?.id,
        },
        'request failed',
      );
      return reply.status(error.httpStatus).send(
        errorBody(error.code, error.message, requestId, {
          details: error.details,
          retryable: error.retryable,
          lastSuccessAt: error.lastSuccessAt,
        }),
      );
    }

    // Fastify's own validation / payload errors.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      request.log.warn({ err: error }, 'client error');
      const detail = error instanceof Error ? error.message : 'The request was rejected.';
      return reply.status(statusCode).send(
        errorBody(
          statusCode === 429 ? 'RATE_LIMITED' : 'VALIDATION_FAILED',
          redactString(detail),
          requestId,
        ),
      );
    }

    request.log.error({ err: error, userId: request.user?.id }, 'unhandled error');
    return reply.status(500).send(
      errorBody(
        'INTERNAL_ERROR',
        'The console hit an unexpected error. Quote the request id when reporting it.',
        requestId,
      ),
    );
  });

  // Routes last, so every encapsulated context inherits the handlers above.
  await registerRoutes(app);

  if (cfg.isDevelopment) {
    app.log.info(
      {
        providers: cfg.providers,
        ssoConfigured: cfg.ssoConfigured,
        localAuth: cfg.LOCAL_AUTH_ENABLED,
      },
      'console API configured',
    );
  }

  return app;
}

function errorBody(
  code: ApiError['error']['code'],
  message: string,
  requestId: string,
  extra: {
    details?: Array<{ path: string; message: string }>;
    retryable?: boolean;
    lastSuccessAt?: string | null;
  } = {},
): ApiError {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: extra.retryable ?? false,
      ...(extra.details ? { details: extra.details } : {}),
      ...(extra.lastSuccessAt !== undefined ? { lastSuccessAt: extra.lastSuccessAt } : {}),
    },
    meta: { requestId, generatedAt: new Date().toISOString() },
  };
}

export { AppError };
