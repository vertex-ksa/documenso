import { readInternalDraftApprovalPolicy } from '@documenso/lib/server-only/envelope/internal-draft-review';
import { z } from 'zod';

import { authenticatedProcedure } from '../trpc';

export const getInternalDraftApprovalPolicyRoute = authenticatedProcedure
  .input(z.object({ envelopeId: z.string().min(1) }))
  .query(async ({ input, ctx }) =>
    readInternalDraftApprovalPolicy({ ...input, userId: ctx.user.id, teamId: ctx.teamId }),
  );
