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
  policyVersion: z.literal(1),
  expiresAt: z.date(),
  createdAt: z.date(),
  decidedAt: z.date().nullable(),
  canAuthorizeSend: z.literal(false),
  sendEnforcement: z.literal('NOT_INTEGRATED'),
});
