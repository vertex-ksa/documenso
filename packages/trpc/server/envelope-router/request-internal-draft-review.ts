import { requestInternalDraftReview } from '@documenso/lib/server-only/envelope/internal-draft-review';

import { authenticatedProcedure } from '../trpc';
import {
  ZInternalDraftReviewResponseSchema,
  ZRequestInternalDraftReviewRequestSchema,
} from './request-internal-draft-review.types';

export const requestInternalDraftReviewRoute = authenticatedProcedure
  .input(ZRequestInternalDraftReviewRequestSchema)
  .output(ZInternalDraftReviewResponseSchema)
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, reviewerUserId, operationKey, expiresAt } = input;
    return await requestInternalDraftReview({
      envelopeId,
      reviewerUserId,
      operationKey,
      expiresAt,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });
  });
