import { z } from 'zod';
import { ENVIRONMENTS } from '@airaos/types';

export const environmentSchema = z.enum(ENVIRONMENTS);

export const uuidSchema = z.string().uuid();

/**
 * Provider resource identifiers are echoed back into provider URLs, so they are
 * restricted to a conservative character set rather than trusted verbatim.
 */
export const providerResourceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Resource id contains unsupported characters');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const isoDateSchema = z.string().datetime({ offset: true });

export const timeRangeSchema = z
  .object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine(
    (value) => !value.from || !value.to || new Date(value.from) <= new Date(value.to),
    { message: '`from` must not be after `to`', path: ['from'] },
  );

/**
 * PostgreSQL identifier accepted from the client for schema/table/column names.
 * Identifiers are additionally quoted server-side before interpolation; this
 * check exists so obviously hostile input never reaches the query builder.
 */
export const pgIdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/, 'Not a valid PostgreSQL identifier');

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('asc');
