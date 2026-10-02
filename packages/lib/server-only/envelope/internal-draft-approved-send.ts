import { createHash } from 'node:crypto';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, Prisma, TeamMemberRole } from '@prisma/client';
import { z } from 'zod';
import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { jobs } from '../../jobs/client';
import { getFileServerSide } from '../../universal/upload/get-file.server';
import { type SendDocumentOptions, sendDocumentWithContext } from '../document/send-document';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';
import {
  currentInternalDraftRole,
  preparedDraftArtifactsSchema,
  readCurrentInternalDraft,
} from './internal-draft-review';
import { createInternalDraftSnapshot } from './internal-draft-review-snapshot';

const deny: (message: string) => never = (message) => {
  throw new AppError(AppErrorCode.INVALID_REQUEST, { message });
};

export const executeInternalDraftApprovedSend = async (
  options: Omit<SendDocumentOptions, 'id'> & {
    envelopeId: string;
    reviewId: string;
    operationKey: string;
    preparedHash: string;
  },
) => {
  if (process.env.NEXT_PRIVATE_INTERNAL_DRAFT_REVIEW_ENABLED !== 'true') {
    deny('Internal draft review is not enabled.');
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.operationKey)) {
    deny('A bounded operation key is required.');
  }
  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentInternalDraft(tx, options, true);
      if (options.userId !== envelope.userId && role === TeamMemberRole.MEMBER) {
        deny('Current native send authority is required.');
      }
      const previous = await tx.internalDraftSendOperation.findUnique({
        where: {
          envelopeId_userId_operationKey: {
            envelopeId: envelope.id,
            userId: options.userId,
            operationKey: options.operationKey,
          },
        },
      });
      if (previous) {
        if (previous.reviewId !== options.reviewId || previous.preparedHash !== options.preparedHash) {
          deny('Operation key already binds another send.');
        }
        return previous;
      }
      if (envelope.status !== DocumentStatus.DRAFT) {
        deny('Only draft envelopes can execute an approved send.');
      }
      const policy = await tx.internalDraftApprovalPolicy.findUnique({ where: { envelopeId: envelope.id } });
      const review = await tx.internalDraftReview.findFirst({
        where: { id: options.reviewId, envelopeId: envelope.id },
      });
      if (
        !policy?.required ||
        !review ||
        policy.selectedReviewId !== review.id ||
        policy.version !== review.policyVersion ||
        review.status !== 'APPROVED' ||
        review.withdrawnAt ||
        review.revokedAt ||
        review.expiresAt.getTime() <= Date.now() ||
        review.preparedHash !== options.preparedHash ||
        review.decisionUserId !== review.reviewerUserId ||
        review.reviewerUserId === review.requesterUserId ||
        review.reviewerUserId === envelope.userId
      ) {
        deny('Current independent approved review is required.');
      }
      const reviewerRole = await currentInternalDraftRole(tx, review.reviewerUserId, options.teamId);
      if (
        reviewerRole === TeamMemberRole.MEMBER ||
        !TEAM_DOCUMENT_VISIBILITY_MAP[reviewerRole].some((visibility) => visibility === envelope.visibility)
      ) {
        deny('Current independent reviewer authority is required.');
      }
      if ((await createInternalDraftSnapshot(envelope)).snapshotHash !== review.snapshotHash) {
        deny('The approved draft changed.');
      }
      const artifacts = preparedDraftArtifactsSchema.parse(review.preparedArtifacts);
      if (
        artifacts.length !== envelope.envelopeItems.length ||
        createHash('sha256').update(JSON.stringify(artifacts)).digest('hex') !== review.preparedHash
      ) {
        deny('Prepared artifact binding failed.');
      }
      for (const item of envelope.envelopeItems) {
        const artifact = artifacts.find((candidate) => candidate.envelopeItemId === item.id);
        if (!artifact || artifact.originalDocumentDataId !== item.documentDataId) {
          deny('Prepared item binding failed.');
        }
        const staged = await tx.documentData.findUnique({ where: { id: artifact.stagedDocumentDataId } });
        if (
          !staged ||
          createHash('sha256')
            .update(await getFileServerSide(staged))
            .digest('hex') !== artifact.sha256
        ) {
          deny('Prepared artifact integrity failed.');
        }
        await tx.documentData.update({
          where: { id: item.documentDataId },
          data: { type: staged.type, data: staged.data, initialData: staged.initialData },
        });
      }
      const outboundIntents: Prisma.InputJsonObject[] = [];
      await sendDocumentWithContext(
        { ...options, id: { type: 'envelopeId', id: envelope.id } },
        {
          tx,
          prepared: true,
          approved: true,
          enqueue: async (intent) => {
            outboundIntents.push(JSON.parse(JSON.stringify(intent)));
          },
        },
      );
      return await tx.internalDraftSendOperation.create({
        data: {
          envelopeId: envelope.id,
          operationKey: options.operationKey,
          userId: options.userId,
          reviewId: review.id,
          policyVersion: policy.version,
          preparedHash: options.preparedHash,
          outboundIntents,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );
};

const operationLocator = (options: { envelopeId: string; userId: number; operationKey: string }) => ({
  envelopeId_userId_operationKey: {
    envelopeId: options.envelopeId,
    userId: options.userId,
    operationKey: options.operationKey,
  },
});

export const readInternalDraftSendOperation = async (options: {
  envelopeId: string;
  userId: number;
  teamId: number;
  operationKey: string;
}) =>
  prisma.$transaction(
    async (tx) => {
      await readCurrentInternalDraft(tx, options, true);
      const operation = await tx.internalDraftSendOperation.findUnique({ where: operationLocator(options) });
      if (!operation) {
        deny('Send operation not found for the current native actor.');
      }
      return {
        id: operation.id,
        reviewId: operation.reviewId,
        dispatchState: operation.dispatchState,
        nextIntent: operation.nextIntent,
        createdAt: operation.createdAt,
        deliveryConfirmed: false as const,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );

// Explicit after-commit submission. PENDING may be claimed once. DISPATCHING or
// UNKNOWN cannot be replayed: a timeout may already have reached a native queue.
// QUEUED means native submission acknowledged, never recipient delivery proof.
export const dispatchInternalDraftSendOperation = async (options: {
  envelopeId: string;
  userId: number;
  teamId: number;
  operationKey: string;
}) => {
  if (process.env.NEXT_PRIVATE_INTERNAL_DRAFT_REVIEW_ENABLED !== 'true') {
    deny('Internal draft review is not enabled.');
  }
  const operation = await prisma.$transaction(
    async (tx) => {
      await readCurrentInternalDraft(tx, options, true);
      const operation = await tx.internalDraftSendOperation.findUnique({ where: operationLocator(options) });
      if (!operation) {
        deny('Send operation not found for the current native actor.');
      }
      if (operation.dispatchState !== 'PENDING') {
        return null;
      }
      const claim = await tx.internalDraftSendOperation.updateMany({
        where: { id: operation.id, dispatchState: 'PENDING' },
        data: { dispatchState: 'DISPATCHING' },
      });
      return claim.count === 1 ? operation : null;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );
  if (!operation) {
    return readInternalDraftSendOperation(options);
  }
  try {
    const intents = z
      .array(z.object({ kind: z.enum(['JOB', 'WEBHOOK']), options: z.record(z.unknown()) }))
      .parse(operation.outboundIntents);
    for (let index = operation.nextIntent; index < intents.length; index++) {
      const intent = intents[index];
      if (intent.kind === 'JOB') {
        await jobs.triggerJob(intent.options as Parameters<typeof jobs.triggerJob>[0]);
      } else {
        await triggerWebhook(intent.options as Parameters<typeof triggerWebhook>[0]);
      }
      await prisma.internalDraftSendOperation.update({ where: { id: operation.id }, data: { nextIntent: index + 1 } });
    }
    await prisma.internalDraftSendOperation.update({
      where: { id: operation.id },
      data: { dispatchState: 'QUEUED', dispatchedAt: new Date() },
    });
  } catch {
    await prisma.internalDraftSendOperation.update({ where: { id: operation.id }, data: { dispatchState: 'UNKNOWN' } });
  }
  return readInternalDraftSendOperation(options);
};
