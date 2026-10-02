import { retireInternalDraftPreparedArtifacts } from '@documenso/lib/server-only/envelope/internal-draft-review';
import { z } from 'zod';
import { authenticatedProcedure } from '../trpc';
export const retireInternalDraftPreparedArtifactsRoute = authenticatedProcedure
  .input(z.object({ envelopeId: z.string().min(1), reviewId: z.string().min(1) }))
  .mutation(({ input, ctx }) =>
    retireInternalDraftPreparedArtifacts({ ...input, userId: ctx.user.id, teamId: ctx.teamId }),
  );
