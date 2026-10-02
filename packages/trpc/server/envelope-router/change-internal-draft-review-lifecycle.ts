import { changeInternalDraftReviewLifecycle } from '@documenso/lib/server-only/envelope/internal-draft-review';
import { z } from 'zod';

import { authenticatedProcedure } from '../trpc';
import { ZInternalDraftReviewResponseSchema } from './request-internal-draft-review.types';

export const changeInternalDraftReviewLifecycleRoute = authenticatedProcedure
  .input(
    z.object({
      envelopeId: z.string().min(1),
      reviewId: z.string().min(1),
      action: z.enum(['WITHDRAW', 'REVOKE']),
      reason: z.string().trim().min(1).max(1000),
    }),
  )
  .output(ZInternalDraftReviewResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, reviewId, action, reason } = input;
    return await changeInternalDraftReviewLifecycle({
      envelopeId,
      reviewId,
      action,
      reason,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });
  });
