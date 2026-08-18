import type { ZodError, ZodTypeAny, z } from 'zod';
import { errors } from './errors.js';

/**
 * Parses untrusted input with a Zod schema and converts failures into the
 * standard validation error. Every route body, query and params object goes
 * through this — nothing reaches a service layer unvalidated.
 */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw errors.validation(formatIssues(result.error));
  }
  return result.data;
}

export function formatIssues(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}
