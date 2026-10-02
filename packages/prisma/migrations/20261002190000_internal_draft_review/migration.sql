CREATE TYPE "InternalDraftReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "InternalDraftReview" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "requesterUserId" INTEGER NOT NULL,
    "reviewerUserId" INTEGER NOT NULL,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "snapshotHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" "InternalDraftReviewStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decisionUserId" INTEGER,
    CONSTRAINT "InternalDraftReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InternalDraftReview_envelopeId_requesterUserId_operationKey_key"
ON "InternalDraftReview"("envelopeId", "requesterUserId", "operationKey");
CREATE INDEX "InternalDraftReview_envelopeId_createdAt_idx"
ON "InternalDraftReview"("envelopeId", "createdAt");
ALTER TABLE "InternalDraftReview" ADD CONSTRAINT "InternalDraftReview_envelopeId_fkey"
FOREIGN KEY ("envelopeId") REFERENCES "Envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
