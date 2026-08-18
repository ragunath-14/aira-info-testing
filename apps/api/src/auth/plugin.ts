import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedUser, Environment, Permission } from '@airaos/types';
import { assertPermission } from '../rbac/index.js';
import { errors } from '../utils/errors.js';
import { SESSION_COOKIE, resolveSession } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present on every authenticated request; undefined on public routes. */
    user?: AuthenticatedUser;
  }
  interface FastifyInstance {
    /** Route-level preHandler that requires a valid session. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Requires a session plus one permission, optionally scoped to an environment. */
    requirePermission: (
      permission: Permission,
      environmentFrom?: (request: FastifyRequest) => Environment | undefined,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Authentication and authorisation hooks.
 *
 * Routes opt in explicitly: there is no global "authenticated by default" that a
 * new route could silently miss, and equally no route that grants access without
 * naming the permission it needs.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  app.decorate('authenticate', async (request: FastifyRequest) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) throw errors.unauthenticated();
    request.user = await resolveSession(token);
  });

  app.decorate(
    'requirePermission',
    (
      permission: Permission,
      environmentFrom?: (request: FastifyRequest) => Environment | undefined,
    ) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!request.user) {
          await app.authenticate(request, reply);
        }
        const user = request.user;
        if (!user) throw errors.unauthenticated();

        // The environment is derived from the request only to scope the check;
        // the resource's real environment is re-verified in the service layer
        // before anything is executed (rule 11).
        assertPermission(user, permission, environmentFrom?.(request));
      },
  );
}

export function requireUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.user;
  if (!user) throw errors.unauthenticated();
  return user;
}
