import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, type InternalDraftReviewStatus, Prisma, TeamMemberRole } from '@prisma/client';

import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery, getHighestTeamRoleInGroup } from '../../utils/teams';
import { createInternalDraftSnapshot, draftReviewInclude } from './internal-draft-review-snapshot';

type ReviewActor = { userId: number; teamId: number; envelopeId: string };

const deny: (message: string) => never = (message) => {
  throw new AppError(AppErrorCode.INVALID_REQUEST, { message });
};

const assertEnabled = () => {
  if (process.env.NEXT_PRIVATE_INTERNAL_DRAFT_REVIEW_ENABLED !== 'true') {
    deny('Internal draft review is not enabled.');
  }
};

const currentRole = async (tx: Prisma.TransactionClient, userId: number, teamId: number) => {
  // Hold actual role-bearing memberships and disabled-account rows until the
  // record transaction commits. Concurrent changes fail closed or wait.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT tg."id" FROM "User" u
    JOIN "OrganisationMember" om ON om."userId" = u."id"
    JOIN "OrganisationGroupMember" gm ON gm."organisationMemberId" = om."id"
    JOIN "TeamGroup" tg ON tg."organisationGroupId" = gm."groupId"
    WHERE u."id" = ${userId} AND u."disabled" = false AND tg."teamId" = ${teamId}
    ORDER BY tg."id", gm."id"
    FOR SHARE OF u, om, gm, tg
  `;
  if (locked.length === 0) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Current native team membership is required.' });
  }
  const user = await tx.user.findFirst({ where: { id: userId, disabled: false }, select: { id: true } });
  const team = await tx.team.findFirst({
    where: buildTeamWhereQuery({ teamId, userId }),
    include: {
      teamGroups: {
        where: { organisationGroup: { organisationGroupMembers: { some: { organisationMember: { userId } } } } },
      },
    },
  });

  if (!user || !team) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: 'Current native team membership is required.' });
  }

  return getHighestTeamRoleInGroup(team.teamGroups);
};

const readCurrentDraft = async (tx: Prisma.TransactionClient, actor: ReviewActor) => {
  const role = await currentRole(tx, actor.userId, actor.teamId);
  const envelope = await tx.envelope.findFirst({
    where: {
      id: actor.envelopeId,
      teamId: actor.teamId,
      type: EnvelopeType.DOCUMENT,
      deletedAt: null,
      OR: [{ userId: actor.userId }, { visibility: { in: TEAM_DOCUMENT_VISIBILITY_MAP[role] } }],
    },
    include: draftReviewInclude,
  });

  if (!envelope) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Draft envelope not found.' });
  }

  if (envelope.status !== DocumentStatus.DRAFT) {
    deny('Only draft envelopes can be internally reviewed.');
  }

  // Lock after native visibility authorization. The parent FOR UPDATE lock
  // conflicts with FK key-share for child inserts. Share-lock existing data.
  await tx.$queryRaw`SELECT "id" FROM "Envelope" WHERE "id" = ${envelope.id} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "EnvelopeItem" WHERE "envelopeId" = ${envelope.id} ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`
    SELECT d."id" FROM "DocumentData" d
    JOIN "EnvelopeItem" i ON i."documentDataId" = d."id"
    WHERE i."envelopeId" = ${envelope.id} ORDER BY d."id" FOR SHARE OF d
  `;
  await tx.$queryRaw`SELECT "id" FROM "DocumentMeta" WHERE "id" = ${envelope.documentMetaId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "Recipient" WHERE "envelopeId" = ${envelope.id} ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "Field" WHERE "envelopeId" = ${envelope.id} ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "EnvelopeAttachment" WHERE "envelopeId" = ${envelope.id} ORDER BY "id" FOR SHARE`;
  return { envelope, role };
};

const publicRecord = (review: {
  id: string;
  status: InternalDraftReviewStatus;
  snapshotHash: string;
  policyVersion: number;
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
}) => {
  if (review.policyVersion !== 1) {
    deny('Unsupported internal draft review policy version.');
  }
  return {
    id: review.id,
    status: review.status,
    snapshotHash: review.snapshotHash,
    policyVersion: 1 as const,
    expiresAt: review.expiresAt,
    createdAt: review.createdAt,
    decidedAt: review.decidedAt,
    canAuthorizeSend: false as const,
    sendEnforcement: 'NOT_INTEGRATED' as const,
  };
};

export const requestInternalDraftReview = async (
  options: ReviewActor & {
    operationKey: string;
    reviewerUserId: number;
    expiresAt: Date;
  },
) => {
  assertEnabled();

  if (
    !/^[A-Za-z0-9_-]{16,128}$/.test(options.operationKey) ||
    !Number.isInteger(options.reviewerUserId) ||
    options.reviewerUserId < 1 ||
    !Number.isFinite(options.expiresAt.getTime())
  ) {
    deny('Invalid draft review request.');
  }

  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentDraft(tx, options);
      if (options.userId !== envelope.userId && role === TeamMemberRole.MEMBER) {
        deny('The draft owner or a current team manager must request review.');
      }
      if (options.reviewerUserId === options.userId || options.reviewerUserId === envelope.userId) {
        deny('An independent reviewer is required.');
      }
      const reviewerRole = await currentRole(tx, options.reviewerUserId, options.teamId);
      if (
        reviewerRole === TeamMemberRole.MEMBER ||
        !TEAM_DOCUMENT_VISIBILITY_MAP[reviewerRole].some((visibility) => visibility === envelope.visibility)
      ) {
        deny('The reviewer must be a current team manager with envelope visibility.');
      }

      const material = await createInternalDraftSnapshot(envelope);
      const existing = await tx.internalDraftReview.findUnique({
        where: {
          envelopeId_requesterUserId_operationKey: {
            envelopeId: options.envelopeId,
            requesterUserId: options.userId,
            operationKey: options.operationKey,
          },
        },
      });
      if (existing) {
        if (
          existing.reviewerUserId !== options.reviewerUserId ||
          existing.snapshotHash !== material.snapshotHash ||
          existing.expiresAt.getTime() !== options.expiresAt.getTime()
        ) {
          deny('This operation key is already bound to a different draft review.');
        }
        return publicRecord(existing);
      }

      const now = Date.now();
      if (options.expiresAt.getTime() <= now || options.expiresAt.getTime() > now + 30 * 86400000) {
        deny('Review expiry must be within the next 30 days.');
      }
      const review = await tx.internalDraftReview.create({
        data: {
          envelopeId: envelope.id,
          operationKey: options.operationKey,
          requesterUserId: options.userId,
          reviewerUserId: options.reviewerUserId,
          expiresAt: options.expiresAt,
          ...material,
        },
      });
      return publicRecord(review);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

export const readInternalDraftReview = async (options: ReviewActor & { reviewId: string }) => {
  assertEnabled();
  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentDraft(tx, options);
      const review = await tx.internalDraftReview.findFirst({
        where: { id: options.reviewId, envelopeId: envelope.id },
      });
      if (!review || ![envelope.userId, review.requesterUserId, review.reviewerUserId].includes(options.userId)) {
        deny('Draft review record not found for this actor.');
      }
      const material = await createInternalDraftSnapshot(envelope);
      const materialMatches = material.snapshotHash === review.snapshotHash;
      const expired = review.expiresAt.getTime() <= Date.now();
      return {
        ...publicRecord(review),
        materialMatches,
        expired,
        canRecordDecision:
          review.status === 'PENDING' &&
          !expired &&
          materialMatches &&
          review.reviewerUserId === options.userId &&
          review.requesterUserId !== options.userId &&
          envelope.userId !== options.userId &&
          role !== TeamMemberRole.MEMBER,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};

export const decideInternalDraftReview = async (
  options: ReviewActor & {
    reviewId: string;
    snapshotHash: string;
    decision: 'APPROVED' | 'REJECTED';
  },
) => {
  assertEnabled();
  if (!/^[a-f0-9]{64}$/.test(options.snapshotHash) || !['APPROVED', 'REJECTED'].includes(options.decision)) {
    deny('Invalid draft review decision.');
  }

  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentDraft(tx, options);
      const review = await tx.internalDraftReview.findFirst({
        where: { id: options.reviewId, envelopeId: envelope.id },
      });
      if (
        !review ||
        review.reviewerUserId !== options.userId ||
        review.requesterUserId === options.userId ||
        envelope.userId === options.userId ||
        role === TeamMemberRole.MEMBER
      ) {
        deny('Only the designated independent current team manager can decide.');
      }
      if (review.policyVersion !== 1) {
        deny('Unsupported internal draft review policy version.');
      }
      const material = await createInternalDraftSnapshot(envelope);
      if (review.snapshotHash !== options.snapshotHash || review.snapshotHash !== material.snapshotHash) {
        deny('The draft changed. Request a new review.');
      }
      if (review.status !== 'PENDING') {
        if (review.status === options.decision && review.decisionUserId === options.userId) {
          return publicRecord(review);
        }
        deny('The recorded decision cannot be replaced.');
      }
      if (review.expiresAt.getTime() <= Date.now()) {
        deny('The draft review expired.');
      }
      const changed = await tx.internalDraftReview.updateMany({
        where: { id: review.id, status: 'PENDING', snapshotHash: options.snapshotHash },
        data: { status: options.decision, decidedAt: new Date(), decisionUserId: options.userId },
      });
      if (changed.count !== 1) {
        deny('The draft review changed. Reload before deciding.');
      }
      return publicRecord(await tx.internalDraftReview.findUniqueOrThrow({ where: { id: review.id } }));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};
