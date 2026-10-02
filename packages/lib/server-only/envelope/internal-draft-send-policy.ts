import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { AppError, AppErrorCode } from '../../errors/app-error';

// Persisted requirements survive turning off the development review UI. Ordinary
// distribution must use the protected approved executor for required policies.
export const assertInternalDraftSendPolicy = async (
  envelopeId: string,
  db: Pick<Prisma.TransactionClient, 'internalDraftApprovalPolicy'> = prisma,
) => {
  const policy = await db.internalDraftApprovalPolicy.findUnique({ where: { envelopeId } });
  if (policy?.required) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Required internal approval must be sent through the protected native execution endpoint.',
    });
  }
};
