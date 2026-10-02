import { configureInternalDraftApprovalPolicy } from '@documenso/lib/server-only/envelope/internal-draft-review';
import { z } from 'zod';

import { authenticatedProcedure } from '../trpc';

export const configureInternalDraftApprovalPolicyRoute = authenticatedProcedure
  .input(
    z.object({ envelopeId: z.string().min(1), required: z.boolean(), expectedVersion: z.number().int().nonnegative() }),
  )
  .mutation(async ({ input, ctx }) => {
    const { envelopeId, required, expectedVersion } = input;
    return await configureInternalDraftApprovalPolicy({
      envelopeId,
      required,
      expectedVersion,
      userId: ctx.user.id,
      teamId: ctx.teamId,
    });
  });
