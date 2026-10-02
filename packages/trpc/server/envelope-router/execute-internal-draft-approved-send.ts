import { executeInternalDraftApprovedSend } from '@documenso/lib/server-only/envelope/internal-draft-approved-send';
import { z } from 'zod';

import { authenticatedProcedure } from '../trpc';

export const executeInternalDraftApprovedSendRoute = authenticatedProcedure
  .input(
    z.object({
      envelopeId: z.string().min(1),
      reviewId: z.string().min(1),
      operationKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
      preparedHash: z.string().regex(/^[a-f0-9]{64}$/),
      sendEmail: z.boolean().optional(),
    }),
  )
  .mutation(async ({ input, ctx }) => {
    const operation = await executeInternalDraftApprovedSend({
      ...input,
      userId: ctx.user.id,
      teamId: ctx.teamId,
      requestMetadata: ctx.metadata,
    });
    return {
      id: operation.id,
      reviewId: operation.reviewId,
      dispatchState: operation.dispatchState,
      createdAt: operation.createdAt,
    };
  });
