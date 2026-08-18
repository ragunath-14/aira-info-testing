import { z } from 'zod';
import { OPERATION_KEYS } from '@airaos/types';
import { environmentSchema, providerResourceIdSchema } from './common.js';

/**
 * The only shape accepted by the operations endpoint. There is deliberately no
 * field that can carry a shell command, script, or arbitrary provider payload
 * (spec section 40 / rule 2).
 */
export const operationRequestSchema = z.object({
  key: z.enum(OPERATION_KEYS),
  resourceId: providerResourceIdSchema,
  environment: environmentSchema,
  confirmation: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
  metadata: z
    .record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
    .optional(),
});

export const deploymentRequestSchema = z.object({
  applicationId: z.string().uuid(),
  environment: environmentSchema,
  version: z.string().min(1).max(100).regex(/^[A-Za-z0-9._+-]+$/, 'Invalid version string'),
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/, 'Invalid commit sha'),
  branch: z.string().min(1).max(200).optional(),
  confirmation: z.string().max(200).optional(),
  reason: z.string().max(500).optional(),
});

export const deploymentApprovalSchema = z.object({
  deploymentId: z.string().uuid(),
  approve: z.boolean(),
  note: z.string().max(500).optional(),
});

export const alertAcknowledgeSchema = z.object({
  fingerprint: z.string().min(1).max(200).regex(/^[A-Za-z0-9]+$/, 'Invalid fingerprint'),
  note: z.string().max(500).optional(),
});

export const alertResolveSchema = z.object({
  fingerprint: z.string().min(1).max(200).regex(/^[A-Za-z0-9]+$/, 'Invalid fingerprint'),
  resolutionDetail: z.string().min(1).max(1000),
});
