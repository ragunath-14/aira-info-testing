import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiSuccess, Paginated } from '@airaos/types';

/** Wraps a payload in the standard success envelope. */
export function ok<T>(
  request: FastifyRequest,
  data: T,
  meta: { cachedAgeMs?: number } = {},
): ApiSuccess<T> {
  return {
    ok: true,
    data,
    meta: {
      requestId: request.id,
      generatedAt: new Date().toISOString(),
      ...(meta.cachedAgeMs !== undefined ? { cachedAgeMs: meta.cachedAgeMs } : {}),
    },
  };
}

export function paginate<T>(items: T[], page: number, pageSize: number, total: number): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total,
  };
}

/**
 * Applies cache headers appropriate for an internal console: never store
 * infrastructure state in a shared cache, and never let a browser reuse it
 * after a permission change.
 */
export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
}
