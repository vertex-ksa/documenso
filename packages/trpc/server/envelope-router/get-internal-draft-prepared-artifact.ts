import { readInternalDraftPreparedArtifact } from '@documenso/lib/server-only/envelope/internal-draft-review';
import { z } from 'zod';

import { authenticatedProcedure } from '../trpc';

export const getInternalDraftPreparedArtifactRoute = authenticatedProcedure
  .input(z.object({ envelopeId: z.string().min(1), reviewId: z.string().min(1), envelopeItemId: z.string().min(1) }))
  .query(async ({ input, ctx }) =>
    readInternalDraftPreparedArtifact({ ...input, userId: ctx.user.id, teamId: ctx.teamId }),
  );
