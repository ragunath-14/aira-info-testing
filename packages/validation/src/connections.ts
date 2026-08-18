import { z } from 'zod';
import { CONNECTION_TYPES } from '@airaos/types';
import { environmentSchema, uuidSchema } from './common.js';

/**
 * Per-type connection schemas (spec sections 6-9, 20-22).
 *
 * Each type declares exactly the fields the Add Connection form should show, so
 * the UI can render the right form from the schema rather than hardcoding a
 * layout per provider (spec section 36: no provider names in core logic).
 *
 * Secret fields are marked write-only in the comments and are stripped from every
 * response by the service layer.
 */

export const connectionTypeSchema = z.enum(CONNECTION_TYPES);

export const connectionStatusSchema = z.enum(['connected', 'degraded', 'offline', 'not_tested']);

/** Fields every connection carries, regardless of type. */
const baseConnectionFields = {
  name: z.string().min(1).max(120),
  environment: environmentSchema,
  description: z.string().max(500).nullish(),
};

/**
 * Internal URL validator.
 *
 * Requires an absolute http(s) URL. Deliberately permits private hostnames and
 * IPs, because that is exactly where this infrastructure lives — the SSRF concern
 * is handled by the fact that only an operator with `settings.manage` can set
 * these, and the API never follows a URL supplied by an ordinary request.
 */
const internalUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an absolute http(s) URL');

const hostname = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Not a valid hostname or IP address');

const port = z.coerce.number().int().min(1).max(65535);

// ------------------------------------------------------------ digitalocean ----

export const digitalOceanConnectionSchema = z.object({
  ...baseConnectionFields,
  type: z.literal('digitalocean'),
  apiUrl: internalUrl.default('https://api.digitalocean.com/v2'),
  /** Write-only. Read-scoped token used for all monitoring. */
  apiToken: z.string().trim().min(20).max(500),
  /**
   * Write-only and optional. Supplying a separately-scoped write token is what
   * enables droplet power actions; without it they are refused rather than
   * falling back to the read token.
   */
  writeApiToken: z.string().trim().min(20).max(500).nullish(),
});

// ----------------------------------------------------------------- proxmox ----

export const proxmoxConnectionSchema = z
  .object({
    ...baseConnectionFields,
    type: z.literal('proxmox'),
    apiUrl: internalUrl,
    /** e.g. console@pve!infra — the full token id, not just the token name. */
    tokenId: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .regex(/^[^!\s]+@[^!\s]+![^!\s]+$/, 'Expected user@realm!tokenname'),
    /** Write-only. */
    tokenSecret: z.string().trim().min(8).max(500),
    rejectUnauthorized: z.boolean().default(true),
    caCertPath: z.string().trim().max(500).nullish(),
  })
  .refine(
    (value) => value.rejectUnauthorized || Boolean(value.caCertPath),
    {
      // An unverified TLS session to the thing that controls your VMs should be
      // an explicit trust decision, not a checkbox.
      message: 'Disabling TLS verification requires a CA certificate path',
      path: ['caCertPath'],
    },
  );

// ---------------------------------------------------------------- postgres ----

export const postgresConnectionSchema = z
  .object({
    ...baseConnectionFields,
    type: z.literal('postgres'),
    host: hostname,
    port: port.default(5432),
    database: z.string().trim().min(1).max(120),
    username: z.string().trim().min(1).max(120),
    /** Write-only. */
    password: z.string().min(1).max(512),
    sslMode: z.enum(['disable', 'require', 'verify-ca', 'verify-full']).default('require'),
    readOnlyOverride: z.boolean().nullish(),
  })
  .refine((value) => value.environment !== 'production' || value.sslMode !== 'disable', {
    message: 'Production connections must not disable TLS',
    path: ['sslMode'],
  });

// ------------------------------------------------------------------- redis ----

export const redisConnectionSchema = z.object({
  ...baseConnectionFields,
  type: z.literal('redis'),
  host: hostname,
  port: port.default(6379),
  /** Write-only and optional: Redis on a trusted network may have no password. */
  password: z.string().max(512).nullish(),
  tls: z.boolean().default(false),
  db: z.coerce.number().int().min(0).max(15).default(0),
});

// -------------------------------------------------------------- prometheus ----

export const prometheusConnectionSchema = z
  .object({
    ...baseConnectionFields,
    type: z.literal('prometheus'),
    url: internalUrl,
    username: z.string().trim().max(200).nullish(),
    /** Write-only. Only used when a username is supplied. */
    password: z.string().max(512).nullish(),
  })
  .refine((value) => !value.username || Boolean(value.password), {
    message: 'A password is required when a username is set',
    path: ['password'],
  });

// ----------------------------------------------------------------- grafana ----

export const grafanaConnectionSchema = z.object({
  ...baseConnectionFields,
  type: z.literal('grafana'),
  url: internalUrl,
  /**
   * Write-only and optional. Only needed for API calls; deep-linking to
   * dashboards works without one, and the token never appears in a link.
   */
  apiToken: z.string().trim().max(500).nullish(),
  organisationId: z.coerce.number().int().min(1).nullish(),
});

/**
 * Discriminated union across every type. `type` selects the shape, so one
 * endpoint validates all six without a per-provider branch.
 */
export const createConnectionSchema = z.discriminatedUnion('type', [
  digitalOceanConnectionSchema,
  proxmoxConnectionSchema.innerType(),
  postgresConnectionSchema.innerType(),
  redisConnectionSchema,
  prometheusConnectionSchema.innerType(),
  grafanaConnectionSchema,
]);

/**
 * Update accepts the same shapes with everything optional except `type`, which
 * pins the discriminator. A connection's type is immutable: changing it would
 * invalidate its stored credential and configuration together.
 */
export const updateConnectionSchema = z.discriminatedUnion('type', [
  digitalOceanConnectionSchema.partial().extend({ type: z.literal('digitalocean') }),
  proxmoxConnectionSchema.innerType().partial().extend({ type: z.literal('proxmox') }),
  postgresConnectionSchema.innerType().partial().extend({ type: z.literal('postgres') }),
  redisConnectionSchema.partial().extend({ type: z.literal('redis') }),
  prometheusConnectionSchema.innerType().partial().extend({ type: z.literal('prometheus') }),
  grafanaConnectionSchema.partial().extend({ type: z.literal('grafana') }),
]);

/**
 * Testing a candidate configuration before it is saved (spec section 6). Accepts
 * the same payload as create, so the operator tests exactly what they will save.
 */
export const testConnectionSchema = createConnectionSchema;

/** Testing an already-saved connection by id, using its stored credential. */
export const testSavedConnectionSchema = z.object({
  connectionId: uuidSchema,
});

export const connectionQuerySchema = z.object({
  type: connectionTypeSchema.optional(),
  environment: environmentSchema.optional(),
  status: connectionStatusSchema.optional(),
  enabled: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
});

export const setConnectionEnabledSchema = z.object({
  isEnabled: z.boolean(),
});

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;
export type TestConnectionInput = z.infer<typeof testConnectionSchema>;
