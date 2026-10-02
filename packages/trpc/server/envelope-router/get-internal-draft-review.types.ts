import { z } from 'zod';

import { ZInternalDraftReviewResponseSchema } from './request-internal-draft-review.types';

export const ZGetInternalDraftReviewRequestSchema = z.object({
  envelopeId: z.string().min(1),
  reviewId: z.string().min(1),
});
export const ZGetInternalDraftReviewResponseSchema = ZInternalDraftReviewResponseSchema.extend({
  materialMatches: z.boolean(),
  expired: z.boolean(),
  canRecordDecision: z.boolean(),
});
