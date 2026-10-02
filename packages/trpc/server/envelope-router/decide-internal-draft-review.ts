import { decideInternalDraftReview } from '@documenso/lib/server-only/envelope/internal-draft-review';

import { authenticatedProcedure } from '../trpc';
import { ZDecideInternalDraftReviewRequestSchema } from './decide-internal-draft-review.types';
import { ZInternalDraftReviewResponseSchema } from './request-internal-draft-review.types';

export const decideInternalDraftReviewRoute = authenticatedProcedure
  .input(ZDecideInternalDraftReviewRequestSchema)
  .output(ZInternalDraftReviewResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, reviewId, snapshotHash, decision } = input;
    return await decideInternalDraftReview({
      envelopeId,
      reviewId,
      snapshotHash,
      decision,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });
  });
