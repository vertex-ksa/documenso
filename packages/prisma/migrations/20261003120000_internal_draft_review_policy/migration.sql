-- AlterTable
ALTER TABLE "InternalDraftReview" ADD COLUMN     "preparedArtifacts" JSONB,
ADD COLUMN     "preparedHash" TEXT,
ADD COLUMN     "preparedRetiredAt" TIMESTAMP(3),
ADD COLUMN     "revocationReason" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedUserId" INTEGER,
ADD COLUMN     "withdrawalReason" TEXT,
ADD COLUMN     "withdrawnAt" TIMESTAMP(3),
ADD COLUMN     "withdrawnUserId" INTEGER;

-- CreateTable
CREATE TABLE "InternalDraftApprovalPolicy" (
    "envelopeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "selectedReviewId" TEXT,
    "configuredByUserId" INTEGER NOT NULL,
    "configuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalDraftApprovalPolicy_pkey" PRIMARY KEY ("envelopeId")
);

-- CreateTable
CREATE TABLE "InternalDraftSendOperation" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "preparedHash" TEXT NOT NULL,
    "outboundIntents" JSONB NOT NULL,
    "dispatchState" TEXT NOT NULL DEFAULT 'PENDING',
    "nextIntent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "InternalDraftSendOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalDraftApprovalPolicyRevision" (
    "envelopeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL,
    "configuredByUserId" INTEGER NOT NULL,
    "configuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalDraftApprovalPolicyRevision_pkey" PRIMARY KEY ("envelopeId","version")
);

-- CreateIndex
CREATE UNIQUE INDEX "InternalDraftSendOperation_reviewId_key" ON "InternalDraftSendOperation"("reviewId");

-- CreateIndex
CREATE UNIQUE INDEX "InternalDraftSendOperation_envelopeId_userId_operationKey_key" ON "InternalDraftSendOperation"("envelopeId", "userId", "operationKey");

-- AddForeignKey
ALTER TABLE "InternalDraftApprovalPolicy" ADD CONSTRAINT "InternalDraftApprovalPolicy_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalDraftSendOperation" ADD CONSTRAINT "InternalDraftSendOperation_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalDraftApprovalPolicyRevision" ADD CONSTRAINT "InternalDraftApprovalPolicyRevision_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
