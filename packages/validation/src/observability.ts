import { z } from 'zod';
import { ENVIRONMENTS } from '@airaos/types';
import { environmentSchema, isoDateSchema } from './common.js';

export const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export const logSourceKindSchema = z.enum([
  'application',
  'container',
  'infrastructure',
  'deployment',
  'audit',
]);

const csvList = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value),
    z.array(item),
  );

export const logQuerySchema = z.object({
  sources: csvList(z.string().min(1).max(120)).default([]),
  kinds: csvList(logSourceKindSchema).default([]),
  environments: csvList(environmentSchema).default([]),
  levels: csvList(logLevelSchema).default([]),
  search: z.string().max(200).nullish(),
  from: isoDateSchema.nullish(),
  to: isoDateSchema.nullish(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.string().max(200).nullish(),
  errorsOnly: z.coerce.boolean().default(false),
});

export const logTailSchema = z.object({
  source: z.string().min(1).max(120),
  environment: environmentSchema,
  levels: csvList(logLevelSchema).default([]),
});

export const alertQuerySchema = z.object({
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  state: z.enum(['firing', 'pending', 'resolved', 'suppressed']).optional(),
  environment: environmentSchema.optional(),
  acknowledged: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Metric requests name a preset series rather than accepting PromQL from the
 * browser: arbitrary PromQL is a data-exfiltration and DoS surface.
 */
export const METRIC_PRESETS = [
  'node_cpu',
  'node_memory',
  'node_disk',
  'node_load',
  'node_network',
  'node_filesystem',
  'app_request_rate',
  'app_error_rate',
  'app_latency_p95',
  'app_status_codes',
  'container_cpu',
  'container_memory',
  'container_restarts',
  'pg_connections',
  'pg_database_size',
  'pg_cache_hit_ratio',
  'pg_locks',
  'pg_transactions',
  'pg_replication_lag',
  'redis_memory',
  'redis_commands',
  'redis_hit_rate',
  'redis_evictions',
  'redis_connections',
] as const;

export const metricQuerySchema = z.object({
  preset: z.enum(METRIC_PRESETS),
  /** Instance / job / container selector, validated as a plain label value. */
  target: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9._:/@-]*$/, 'Invalid metric target')
    .optional(),
  environment: environmentSchema.optional(),
  rangeMinutes: z.coerce.number().int().min(5).max(60 * 24 * 7).default(60),
  stepSeconds: z.coerce.number().int().min(15).max(3600).optional(),
});

export const environmentFilterSchema = z.object({
  environment: z.enum(ENVIRONMENTS).optional(),
});
