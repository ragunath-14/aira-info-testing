import { z } from 'zod';
import { ROLES } from '@airaos/types';
import { environmentSchema, uuidSchema } from './common.js';

export const localLoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
});

export const ssoCallbackSchema = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().min(1).max(500),
});

export const roleAssignmentSchema = z.object({
  userId: uuidSchema,
  roles: z.array(z.enum(ROLES)).min(1).max(6),
});

export const userQuerySchema = z.object({
  search: z.string().max(200).optional(),
  role: z.enum(ROLES).optional(),
  active: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const auditQuerySchema = z.object({
  userId: uuidSchema.optional(),
  action: z.string().max(100).optional(),
  resourceKind: z.string().max(100).optional(),
  environment: environmentSchema.optional(),
  result: z.enum(['success', 'failure', 'denied']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const applicationUpsertSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z][a-z0-9-]*$/, 'Use lowercase letters, digits and hyphens'),
  name: z.string().min(1).max(120),
  kind: z.enum(['api', 'web', 'worker', 'service', 'cron']),
  environment: environmentSchema,
  host: z.string().max(255).nullish(),
  containerName: z.string().max(120).nullish(),
  repository: z.string().max(255).nullish(),
  branch: z.string().max(200).nullish(),
  healthUrl: z
    .string()
    .url()
    .max(500)
    .nullish()
    .refine(
      (value) => !value || value.startsWith('http://') || value.startsWith('https://'),
      'Health URL must be http(s)',
    ),
  port: z.coerce.number().int().min(1).max(65535).nullish(),
  dependsOn: z.array(z.string().max(60)).max(30).default([]),
  ownerTeam: z.string().max(120).nullish(),
  operationsEnabled: z.boolean().default(false),
});

export const settingsUpdateSchema = z.object({
  key: z.string().min(1).max(120),
  /** Settings hold operational policy only; secrets go through the secret store. */
  value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
});
