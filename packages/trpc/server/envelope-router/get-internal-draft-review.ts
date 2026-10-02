import { readInternalDraftReview } from '@documenso/lib/server-only/envelope/internal-draft-review';

import { authenticatedProcedure } from '../trpc';
import {
  ZGetInternalDraftReviewRequestSchema,
  ZGetInternalDraftReviewResponseSchema,
} from './get-internal-draft-review.types';

export const getInternalDraftReviewRoute = authenticatedProcedure
  .input(ZGetInternalDraftReviewRequestSchema)
  .output(ZGetInternalDraftReviewResponseSchema)
  .query(async ({ input, ctx }) => {
    const { envelopeId, reviewId, operationKey } = input;
    return await readInternalDraftReview({
      envelopeId,
      reviewId,
      operationKey,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });
  });
