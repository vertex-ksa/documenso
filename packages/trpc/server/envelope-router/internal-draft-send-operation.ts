import {
  dispatchInternalDraftSendOperation,
  readInternalDraftSendOperation,
} from '@documenso/lib/server-only/envelope/internal-draft-approved-send';
import { z } from 'zod';

import { authenticatedProcedure } from '../trpc';

const input = z.object({ envelopeId: z.string().min(1), operationKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) });
export const getInternalDraftSendOperationRoute = authenticatedProcedure
  .input(input)
  .query(({ input, ctx }) => readInternalDraftSendOperation({ ...input, userId: ctx.user.id, teamId: ctx.teamId }));
export const dispatchInternalDraftSendOperationRoute = authenticatedProcedure
  .input(input)
  .mutation(({ input, ctx }) =>
    dispatchInternalDraftSendOperation({ ...input, userId: ctx.user.id, teamId: ctx.teamId }),
  );
