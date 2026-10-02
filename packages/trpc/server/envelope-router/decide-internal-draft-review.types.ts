import { z } from 'zod';

export const ZDecideInternalDraftReviewRequestSchema = z.object({
  envelopeId: z.string().min(1),
  reviewId: z.string().min(1),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['APPROVED', 'REJECTED']),
});
