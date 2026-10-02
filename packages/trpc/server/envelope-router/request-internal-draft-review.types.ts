import { z } from 'zod';

export const ZRequestInternalDraftReviewRequestSchema = z.object({
  envelopeId: z.string().min(1),
  reviewerUserId: z.number().int().positive(),
  operationKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  expiresAt: z.coerce.date(),
});

export const ZInternalDraftReviewResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.number().int().positive(),
  expiresAt: z.date(),
  createdAt: z.date(),
  decidedAt: z.date().nullable(),
  withdrawnAt: z.date().nullable().default(null),
  revokedAt: z.date().nullable().default(null),
  preparedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
  preparedItems: z
    .array(z.object({ envelopeItemId: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }))
    .default([]),
  canAuthorizeSend: z.literal(false),
  sendEnforcement: z.literal('NATIVE_TRANSACTIONAL_SEND'),
});
