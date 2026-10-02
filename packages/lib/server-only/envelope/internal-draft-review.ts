import { createHash } from 'node:crypto';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, type InternalDraftReviewStatus, Prisma, TeamMemberRole } from '@prisma/client';
import { z } from 'zod';
import { TEAM_DOCUMENT_VISIBILITY_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { getFileServerSide } from '../../universal/upload/get-file.server';
import { buildTeamWhereQuery, getHighestTeamRoleInGroup } from '../../utils/teams';
import { prepareInternalDraftReviewArtifacts } from './internal-draft-review-preparation';
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

export const currentInternalDraftRole = async (tx: Prisma.TransactionClient, userId: number, teamId: number) => {
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

export const readCurrentInternalDraft = async (
  tx: Prisma.TransactionClient,
  actor: ReviewActor,
  allowDistributed = false,
) => {
  const role = await currentInternalDraftRole(tx, actor.userId, actor.teamId);
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

  if (!allowDistributed && envelope.status !== DocumentStatus.DRAFT) {
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
  withdrawnAt?: Date | null;
  revokedAt?: Date | null;
  preparedHash?: string | null;
  preparedArtifacts?: unknown;
}) => {
  if (!Number.isSafeInteger(review.policyVersion) || review.policyVersion < 1) {
    deny('Unsupported internal draft review policy version.');
  }
  return {
    id: review.id,
    status: review.status,
    snapshotHash: review.snapshotHash,
    policyVersion: review.policyVersion,
    expiresAt: review.expiresAt,
    createdAt: review.createdAt,
    decidedAt: review.decidedAt,
    withdrawnAt: review.withdrawnAt ?? null,
    revokedAt: review.revokedAt ?? null,
    preparedHash: review.preparedHash ?? null,
    preparedItems:
      preparedDraftArtifactsSchema
        .safeParse(review.preparedArtifacts)
        .data?.map(({ envelopeItemId, sha256 }) => ({ envelopeItemId, sha256 })) ?? [],
    canAuthorizeSend: false as const,
    sendEnforcement: 'NATIVE_TRANSACTIONAL_SEND' as const,
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
      const { envelope, role } = await readCurrentInternalDraft(tx, options);
      if (options.userId !== envelope.userId && role === TeamMemberRole.MEMBER) {
        deny('The draft owner or a current team manager must request review.');
      }
      if (options.reviewerUserId === options.userId || options.reviewerUserId === envelope.userId) {
        deny('An independent reviewer is required.');
      }
      const reviewerRole = await currentInternalDraftRole(tx, options.reviewerUserId, options.teamId);
      if (
        reviewerRole === TeamMemberRole.MEMBER ||
        !TEAM_DOCUMENT_VISIBILITY_MAP[reviewerRole].some((visibility) => visibility === envelope.visibility)
      ) {
        deny('The reviewer must be a current team manager with envelope visibility.');
      }

      const material = await createInternalDraftSnapshot(envelope);
      const policy = await tx.internalDraftApprovalPolicy.upsert({
        where: { envelopeId: envelope.id },
        create: { envelopeId: envelope.id, configuredByUserId: options.userId },
        update: {},
      });
      await tx.internalDraftApprovalPolicyRevision.upsert({
        where: { envelopeId_version: { envelopeId: envelope.id, version: policy.version } },
        create: {
          envelopeId: envelope.id,
          version: policy.version,
          required: policy.required,
          configuredByUserId: policy.configuredByUserId,
          configuredAt: policy.configuredAt,
        },
        update: {},
      });
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
          existing.policyVersion !== policy.version ||
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
      const prepared = await prepareInternalDraftReviewArtifacts(tx, envelope, material.snapshot);
      const review = await tx.internalDraftReview.create({
        data: {
          envelopeId: envelope.id,
          operationKey: options.operationKey,
          requesterUserId: options.userId,
          reviewerUserId: options.reviewerUserId,
          expiresAt: options.expiresAt,
          policyVersion: policy.version,
          ...material,
          ...prepared,
        },
      });
      await tx.internalDraftApprovalPolicy.update({
        where: { envelopeId: envelope.id },
        data: { selectedReviewId: review.id },
      });
      return publicRecord(review);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );
};

export const readInternalDraftReview = async (options: ReviewActor & { reviewId?: string; operationKey?: string }) => {
  assertEnabled();
  if (Boolean(options.reviewId) === Boolean(options.operationKey)) {
    deny('Provide exactly one review locator.');
  }
  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentInternalDraft(tx, options);
      const review = await tx.internalDraftReview.findFirst({
        where: {
          envelopeId: envelope.id,
          ...(options.reviewId
            ? { id: options.reviewId }
            : { operationKey: options.operationKey, requesterUserId: options.userId }),
        },
      });
      if (
        !review ||
        (role === TeamMemberRole.MEMBER &&
          ![envelope.userId, review.requesterUserId, review.reviewerUserId].includes(options.userId))
      ) {
        deny('Draft review record not found for this actor.');
      }
      const material = await createInternalDraftSnapshot(envelope);
      const materialMatches = material.snapshotHash === review.snapshotHash;
      const expired = review.expiresAt.getTime() <= Date.now();
      const policy = await tx.internalDraftApprovalPolicy.findUnique({ where: { envelopeId: envelope.id } });
      return {
        ...publicRecord(review),
        materialMatches,
        expired,
        canWithdrawReview:
          review.status === 'PENDING' && !review.withdrawnAt && options.userId === review.requesterUserId,
        canRevokeReview:
          !review.revokedAt &&
          (role === TeamMemberRole.ADMIN ||
            (role === TeamMemberRole.MANAGER && options.userId === review.reviewerUserId)),
        canRecordDecision:
          review.status === 'PENDING' &&
          !expired &&
          !review.withdrawnAt &&
          !review.revokedAt &&
          policy?.selectedReviewId === review.id &&
          policy.version === review.policyVersion &&
          materialMatches &&
          review.reviewerUserId === options.userId &&
          review.requesterUserId !== options.userId &&
          envelope.userId !== options.userId &&
          role !== TeamMemberRole.MEMBER,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
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
      const { envelope, role } = await readCurrentInternalDraft(tx, options);
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
      if (!Number.isSafeInteger(review.policyVersion) || review.policyVersion < 1) {
        deny('Unsupported internal draft review policy version.');
      }
      const policy = await tx.internalDraftApprovalPolicy.findUnique({ where: { envelopeId: envelope.id } });
      if (
        review.withdrawnAt ||
        review.revokedAt ||
        policy?.selectedReviewId !== review.id ||
        policy.version !== review.policyVersion
      ) {
        deny('This review was withdrawn, revoked or superseded. Request a new review.');
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
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );
};

export const changeInternalDraftReviewLifecycle = async (
  options: ReviewActor & {
    reviewId: string;
    action: 'WITHDRAW' | 'REVOKE';
    reason: string;
  },
) => {
  assertEnabled();
  if (
    !['WITHDRAW', 'REVOKE'].includes(options.action) ||
    typeof options.reason !== 'string' ||
    options.reason.trim().length < 1 ||
    options.reason.length > 1000
  ) {
    deny('A bounded lifecycle reason is required.');
  }
  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentInternalDraft(tx, options);
      const review = await tx.internalDraftReview.findFirst({
        where: { id: options.reviewId, envelopeId: envelope.id },
      });
      if (!review) {
        deny('Review record not found.');
      }
      const withdrawing = options.action === 'WITHDRAW';
      if (
        withdrawing
          ? review.requesterUserId !== options.userId
          : !(
              role === TeamMemberRole.ADMIN ||
              (review.reviewerUserId === options.userId && role === TeamMemberRole.MANAGER)
            )
      ) {
        deny('Current native authority does not allow this lifecycle change.');
      }
      if (withdrawing ? review.withdrawnAt : review.revokedAt) {
        return publicRecord(review);
      }
      if (withdrawing && review.status !== 'PENDING') {
        deny('A decided review requires revocation; its decision cannot be overwritten.');
      }
      const changed = await tx.internalDraftReview.update({
        where: { id: review.id },
        data: withdrawing
          ? { withdrawnAt: new Date(), withdrawnUserId: options.userId, withdrawalReason: options.reason.trim() }
          : { revokedAt: new Date(), revokedUserId: options.userId, revocationReason: options.reason.trim() },
      });
      return publicRecord(changed);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );
};

export const configureInternalDraftApprovalPolicy = async (
  options: ReviewActor & { required: boolean; expectedVersion: number },
) => {
  assertEnabled();
  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentInternalDraft(tx, options);
      if (
        role !== TeamMemberRole.ADMIN ||
        typeof options.required !== 'boolean' ||
        !Number.isSafeInteger(options.expectedVersion) ||
        options.expectedVersion < 0
      ) {
        deny('A current native administrator must configure the approval policy.');
      }
      const current = await tx.internalDraftApprovalPolicy.findUnique({ where: { envelopeId: envelope.id } });
      if ((current?.version ?? 0) !== options.expectedVersion) {
        deny('The approval policy changed. Reload its current version.');
      }
      const data = {
        required: options.required,
        version: (current?.version ?? 0) + 1,
        selectedReviewId: null,
        configuredByUserId: options.userId,
        configuredAt: new Date(),
      };
      await tx.internalDraftApprovalPolicyRevision.create({
        data: {
          envelopeId: envelope.id,
          version: data.version,
          required: data.required,
          configuredByUserId: data.configuredByUserId,
          configuredAt: data.configuredAt,
        },
      });
      return await tx.internalDraftApprovalPolicy.upsert({
        where: { envelopeId: envelope.id },
        create: { envelopeId: envelope.id, ...data },
        update: data,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );
};

export const readInternalDraftApprovalPolicy = async (options: ReviewActor) => {
  assertEnabled();
  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentInternalDraft(tx, options);
      const policy = await tx.internalDraftApprovalPolicy.findUnique({ where: { envelopeId: envelope.id } });
      return {
        envelopeId: envelope.id,
        version: policy?.version ?? 0,
        required: policy?.required ?? false,
        selectedReviewId: policy?.selectedReviewId ?? null,
        canConfigure: role === TeamMemberRole.ADMIN,
        canRequest: options.userId === envelope.userId || role !== TeamMemberRole.MEMBER,
        canAuthorizeSend: false as const,
        sendEnforcement: 'NATIVE_TRANSACTIONAL_SEND' as const,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );
};

export const preparedDraftArtifactsSchema = z.array(
  z.object({
    envelopeItemId: z.string(),
    originalDocumentDataId: z.string(),
    stagedDocumentDataId: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);

export const readInternalDraftPreparedArtifact = async (
  options: ReviewActor & { reviewId: string; envelopeItemId: string },
) => {
  assertEnabled();
  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentInternalDraft(tx, options);
      const review = await tx.internalDraftReview.findFirst({
        where: { id: options.reviewId, envelopeId: envelope.id },
      });
      if (
        !review ||
        (role === TeamMemberRole.MEMBER &&
          ![envelope.userId, review.requesterUserId, review.reviewerUserId].includes(options.userId))
      ) {
        deny('Review artifact not found.');
      }
      const parsed = preparedDraftArtifactsSchema.safeParse(review.preparedArtifacts);
      if (!parsed.success) {
        deny('Prepared review artifact is unavailable. Request a new review.');
      }
      const artifact = parsed.data.find((item) => item.envelopeItemId === options.envelopeItemId);
      if (!artifact) {
        deny('Prepared review artifact not found.');
      }
      const data = await tx.documentData.findUnique({ where: { id: artifact.stagedDocumentDataId } });
      if (!data) {
        deny('Prepared review artifact is unavailable.');
      }
      const bytes = Buffer.from(await getFileServerSide(data));
      if (bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
        deny('Prepared review artifact integrity check failed.');
      }
      return {
        envelopeItemId: artifact.envelopeItemId,
        sha256: artifact.sha256,
        contentBase64: bytes.toString('base64'),
        contentType: 'application/pdf' as const,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60000 },
  );
};

// Explicit native administrator housekeeping; no worker or provider starts.
// Retain evidence/hashes and retire only private staging after 30 days terminal.
export const retireInternalDraftPreparedArtifacts = async (options: ReviewActor & { reviewId: string }) => {
  assertEnabled();
  return await prisma.$transaction(
    async (tx) => {
      const { envelope, role } = await readCurrentInternalDraft(tx, options, true);
      if (role !== TeamMemberRole.ADMIN) {
        deny('A current native administrator must retire private staging.');
      }
      const review = await tx.internalDraftReview.findFirst({
        where: { id: options.reviewId, envelopeId: envelope.id },
      });
      if (!review) {
        deny('Review record not found.');
      }
      if (review.preparedRetiredAt) {
        return { retired: true, retiredAt: review.preparedRetiredAt };
      }
      const terminalAt =
        review.revokedAt ?? review.withdrawnAt ?? (review.status === 'REJECTED' ? review.decidedAt : review.expiresAt);
      if (!terminalAt || terminalAt.getTime() > Date.now() - 30 * 86400000) {
        deny('Private staging is still within its review retention period.');
      }
      const artifacts = preparedDraftArtifactsSchema.parse(review.preparedArtifacts);
      for (const artifact of artifacts) {
        // Never delete any current native document reference. Staging is forced
        // BYTES_64, so deleting a detached row performs no external blob delete.
        await tx.documentData.deleteMany({
          where: { id: artifact.stagedDocumentDataId, type: 'BYTES_64', envelopeItem: null },
        });
      }
      const retiredAt = new Date();
      await tx.internalDraftReview.update({ where: { id: review.id }, data: { preparedRetiredAt: retiredAt } });
      return { retired: true, retiredAt };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
};
