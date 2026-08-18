import { z } from 'zod';
import { DATA_FILTER_OPERATORS } from '@airaos/types';
import {
  environmentSchema,
  pgIdentifierSchema,
  sortDirectionSchema,
  uuidSchema,
} from './common.js';

export const databaseProviderSchema = z.enum([
  'digitalocean_managed',
  'proxmox_vm',
  'self_hosted',
  'other',
]);

export const sslModeSchema = z.enum(['disable', 'require', 'verify-ca', 'verify-full']);

export const createDatabaseConnectionSchema = z
  .object({
    name: z.string().min(1).max(120),
    environment: environmentSchema,
    provider: databaseProviderSchema,
    host: z.string().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535).default(5432),
    database: z.string().min(1).max(120),
    username: z.string().min(1).max(120),
    /** Write-only. Encrypted at rest and never returned by any endpoint. */
    password: z.string().min(1).max(512),
    sslMode: sslModeSchema.default('require'),
    description: z.string().max(500).nullish(),
    readOnlyOverride: z.boolean().nullish(),
  })
  .refine((value) => value.environment !== 'production' || value.sslMode !== 'disable', {
    message: 'Production connections must not disable TLS',
    path: ['sslMode'],
  });

export const updateDatabaseConnectionSchema = createDatabaseConnectionSchema
  .innerType()
  .partial()
  .omit({ environment: true });

export const explorerParamsSchema = z.object({
  connectionId: uuidSchema,
  schema: pgIdentifierSchema.optional(),
});

export const relationParamsSchema = z.object({
  connectionId: uuidSchema,
  schema: pgIdentifierSchema,
  relation: pgIdentifierSchema,
});

export const dataBrowserSchema = z.object({
  connectionId: uuidSchema,
  schema: pgIdentifierSchema,
  table: pgIdentifierSchema,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
  orderBy: pgIdentifierSchema.nullish(),
  orderDirection: sortDirectionSchema,
  columns: z.array(pgIdentifierSchema).min(1).max(200).nullish(),
  filters: z
    .array(
      z.object({
        column: pgIdentifierSchema,
        operator: z.enum(DATA_FILTER_OPERATORS),
        /** Bound as a parameter, never concatenated into SQL. */
        value: z.string().max(1000).nullish(),
      }),
    )
    .max(20)
    .default([]),
});

export const executeQuerySchema = z.object({
  connectionId: uuidSchema,
  sql: z.string().min(1).max(100_000),
  /** Client hint only. The backend re-classifies and re-authorises regardless. */
  intent: z.enum(['read', 'write', 'explain']).default('read'),
  maxRows: z.coerce.number().int().min(1).max(10_000).optional(),
  timeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  /** Required by the backend for anything classified beyond READ. */
  confirmation: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
});

export const activateWriteModeSchema = z.object({
  connectionId: uuidSchema,
  /** Must equal the connection name; checked server-side. */
  confirmation: z.string().min(1).max(200),
  reason: z.string().min(10).max(500),
  minutes: z.coerce.number().int().min(1).max(60).default(15),
});

export const queryHistorySchema = z.object({
  connectionId: uuidSchema.optional(),
  environment: environmentSchema.optional(),
  userId: uuidSchema.optional(),
  classification: z.enum(['READ', 'WRITE', 'DDL', 'DESTRUCTIVE', 'UNKNOWN']).optional(),
  success: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
