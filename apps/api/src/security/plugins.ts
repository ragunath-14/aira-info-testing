import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { errors } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Transport-level security (spec section 35).
 *
 * The API is browser-facing but same-origin in production: the Next.js server
 * proxies /api/proxy/* to it. CORS therefore allows only the console's own
 * origins, and every state-changing request must carry a matching origin plus
 * the double-submit CSRF token.
 */

const CSRF_COOKIE = 'airaos_console_csrf';
const CSRF_HEADER = 'x-airaos-csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  const cfg = config();

  await app.register(helmet, {
    // The API serves JSON only; a restrictive default policy is free here.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: cfg.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    // The console is internal; nothing should frame or sniff it.
    frameguard: { action: 'deny' },
    noSniff: true,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and server-to-server requests arrive without an Origin.
      if (!origin) return callback(null, true);
      callback(null, cfg.CORS_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', CSRF_HEADER, 'x-request-id'],
    maxAge: 600,
  });

  await app.register(cookie, {
    secret: cfg.SESSION_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'lax', secure: !cfg.isDevelopment, path: '/' },
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Per-session where possible so one operator cannot exhaust another's budget.
    keyGenerator: (request) => request.user?.id ?? request.ip,
    redis: buildRateLimitRedis(),
    // Health probes must never be throttled.
    allowList: (request) => request.url.startsWith('/health'),
    errorResponseBuilder: (_request, context) => {
      const retryAfter = Math.ceil(context.ttl / 1000);
      const error = errors.rateLimited(retryAfter);
      return {
        ok: false,
        error: { code: error.code, message: error.message, retryable: true },
        meta: { requestId: 'rate-limited', generatedAt: new Date().toISOString() },
      };
    },
  });

  registerCsrf(app);
}

/**
 * Rate-limit state goes in Redis when available so limits hold across API
 * replicas. Without Redis the limiter is per-process, which is noted in
 * docs/deployment.md as a single-replica constraint.
 */
function buildRateLimitRedis(): Redis | undefined {
  const cfg = config();
  if (!cfg.REDIS_URL) return undefined;
  try {
    return new Redis(cfg.REDIS_URL, {
      connectionName: 'airaos-console-ratelimit',
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    });
  } catch (error) {
    logger().warn({ err: error }, 'rate limit Redis unavailable; falling back to in-process limits');
    return undefined;
  }
}

/**
 * Double-submit CSRF protection. The token is a non-httpOnly cookie the web app
 * echoes in a header; an attacker's cross-site form can send the cookie but
 * cannot read it to populate the header.
 */
function registerCsrf(app: FastifyInstance): void {
  const cfg = config();

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.cookies?.[CSRF_COOKIE]) {
      const token = randomUUID();
      reply.setCookie(CSRF_COOKIE, token, {
        // Readable by the web app, which is why it carries no secret value:
        // its only job is to prove same-origin script execution.
        httpOnly: false,
        sameSite: 'lax',
        secure: !cfg.isDevelopment,
        path: '/',
      });
    }
  });

  app.addHook('preHandler', async (request: FastifyRequest) => {
    if (SAFE_METHODS.has(request.method)) return;
    // Login by SSO redirect and the health endpoints are exempt; neither
    // performs a privileged state change on the operator's behalf.
    if (request.url.startsWith('/health') || request.url.startsWith('/api/v1/auth/callback')) {
      return;
    }

    const cookieToken = request.cookies?.[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];
    if (!cookieToken || typeof headerToken !== 'string' || headerToken !== cookieToken) {
      throw errors.forbidden('This request failed the cross-site request check. Reload and retry.');
    }

    const origin = request.headers.origin;
    if (origin && !cfg.CORS_ORIGINS.includes(origin)) {
      throw errors.forbidden('Request origin is not allowed.');
    }
  });
}

export { CSRF_COOKIE, CSRF_HEADER };
