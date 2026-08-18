import type { FastifyInstance } from 'fastify';
import { localLoginSchema, ssoCallbackSchema } from '@airaos/validation';
import { config } from '../config.js';
import { errors } from '../utils/errors.js';
import { ok, noStore } from '../utils/reply.js';
import { parse } from '../utils/validate.js';
import * as audit from '../audit/service.js';
import {
  SESSION_COOKIE,
  createSession,
  listSessions,
  revokeSession,
  sessionCookieOptions,
} from '../auth/session.js';
import { authenticateLocal, localAuthAvailable } from '../auth/local.js';
import { buildAuthorizationRequest, exchangeCode } from '../auth/airaos.js';
import { requireUser } from '../auth/plugin.js';
import * as dbPolicy from '../providers/databases/policy.js';

/**
 * Authentication routes.
 *
 * The SSO flow keeps `state`, the PKCE verifier and the nonce in short-lived
 * httpOnly cookies rather than in server memory, so the flow survives an API
 * restart and works across replicas without shared state.
 */

const OAUTH_STATE_COOKIE = 'airaos_oauth_state';
const OAUTH_VERIFIER_COOKIE = 'airaos_oauth_verifier';
const OAUTH_NONCE_COOKIE = 'airaos_oauth_nonce';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const cfg = config();

  /** What the login page needs to know before showing anything. */
  app.get('/methods', async (request, reply) => {
    noStore(reply);
    return ok(request, {
      sso: cfg.ssoConfigured,
      local: localAuthAvailable(),
      mfaRequired: cfg.AUTH_REQUIRE_MFA,
      environment: cfg.APP_ENV,
    });
  });

  /** Starts the SSO flow. */
  app.get('/login', async (request, reply) => {
    if (!cfg.ssoConfigured) throw errors.providerNotConfigured('AIRAOS authentication');

    const authorization = buildAuthorizationRequest();
    const shortLived = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: !cfg.isDevelopment,
      path: '/',
      maxAge: 600,
    };

    reply.setCookie(OAUTH_STATE_COOKIE, authorization.state, shortLived);
    reply.setCookie(OAUTH_VERIFIER_COOKIE, authorization.codeVerifier, shortLived);
    reply.setCookie(OAUTH_NONCE_COOKIE, authorization.nonce, shortLived);

    noStore(reply);
    return ok(request, { authorizationUrl: authorization.url });
  });

  /** SSO callback: exchanges the code and establishes the console session. */
  app.post('/callback', async (request, reply) => {
    const body = parse(ssoCallbackSchema, request.body);

    const expectedState = request.cookies?.[OAUTH_STATE_COOKIE];
    const verifier = request.cookies?.[OAUTH_VERIFIER_COOKIE];
    const nonce = request.cookies?.[OAUTH_NONCE_COOKIE];

    // Clear the flow cookies immediately: a code exchange is single-use, and a
    // leftover verifier is a replay opportunity.
    for (const name of [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_NONCE_COOKIE]) {
      reply.clearCookie(name, { path: '/' });
    }

    if (!expectedState || !verifier || !nonce || body.state !== expectedState) {
      throw errors.unauthenticated('Sign-in could not be completed. Start again from the login page.');
    }

    const identity = await exchangeCode({ code: body.code, codeVerifier: verifier, nonce });
    const session = await createSession(identity, {
      ipAddress: request.ip,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });

    reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
    request.user = session.user;

    await audit.record(request, {
      action: 'SIGN_IN',
      resourceKind: 'session',
      resourceId: session.user.sessionId,
      result: 'success',
      message: 'Signed in with AIRAOS SSO.',
      metadata: { method: 'sso', mfaVerified: session.user.mfaVerified },
    });

    noStore(reply);
    return ok(request, { user: session.user });
  });

  /**
   * Development-only local login. Not registered at all when local auth is
   * unavailable, so it cannot be probed in production.
   */
  if (localAuthAvailable()) {
    app.post('/local', {
      config: {
        // Tighter than the global limit: this is the one credential-guessing
        // surface the console exposes.
        rateLimit: { max: 10, timeWindow: '5 minutes' },
      },
      handler: async (request, reply) => {
        const body = parse(localLoginSchema, request.body);
        const identity = await authenticateLocal(body.email, body.password);
        const session = await createSession(identity, {
          ipAddress: request.ip,
          userAgent:
            typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        });

        reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
        request.user = session.user;

        await audit.record(request, {
          action: 'SIGN_IN',
          resourceKind: 'session',
          resourceId: session.user.sessionId,
          result: 'success',
          message: 'Signed in with local development credentials.',
          metadata: { method: 'local' },
        });

        noStore(reply);
        return ok(request, { user: session.user });
      },
    });
  }

  /** Current session, permissions and any open database write windows. */
  app.get('/session', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    const [sessions, writeWindows] = await Promise.all([
      listSessions(user.id, user.sessionId),
      dbPolicy.listActiveWindows(user.id),
    ]);

    noStore(reply);
    return ok(request, { user, sessions, writeWindows });
  });

  app.post('/logout', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    await revokeSession(user.sessionId, 'user_logout');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });

    await audit.record(request, {
      action: 'SIGN_OUT',
      resourceKind: 'session',
      resourceId: user.sessionId,
      result: 'success',
      message: 'Signed out.',
    });

    noStore(reply);
    return ok(request, { signedOut: true });
  });

  /** Revokes another of the operator's own sessions (device management). */
  app.post('/sessions/:sessionId/revoke', { preHandler: app.authenticate }, async (request, reply) => {
    const user = requireUser(request);
    const { sessionId } = request.params as { sessionId: string };

    const sessions = await listSessions(user.id, user.sessionId);
    // Only the operator's own sessions are revocable here; admin revocation goes
    // through the users API.
    if (!sessions.some((session) => session.id === sessionId)) {
      throw errors.notFound('Session');
    }

    await revokeSession(sessionId, 'revoked_by_user');
    await audit.record(request, {
      action: 'REVOKE_SESSION',
      resourceKind: 'session',
      resourceId: sessionId,
      result: 'success',
      message: 'Revoked one of their own sessions.',
    });

    noStore(reply);
    return ok(request, { revoked: true });
  });
}
