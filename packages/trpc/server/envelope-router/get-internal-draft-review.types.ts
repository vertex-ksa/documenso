import { z } from 'zod';

import { ZInternalDraftReviewResponseSchema } from './request-internal-draft-review.types';

export const ZGetInternalDraftReviewRequestSchema = z
  .object({
    envelopeId: z.string().min(1),
    reviewId: z.string().min(1).optional(),
    operationKey: z.string().min(16).max(128).optional(),
  })
  .refine((value) => Boolean(value.reviewId) !== Boolean(value.operationKey), {
    message: 'Provide exactly one review locator.',
  });
export const ZGetInternalDraftReviewResponseSchema = ZInternalDraftReviewResponseSchema.extend({
  materialMatches: z.boolean(),
  expired: z.boolean(),
  canRecordDecision: z.boolean(),
  canWithdrawReview: z.boolean().default(false),
  canRevokeReview: z.boolean().default(false),
});
