import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatchInternalDraftSendOperation, executeInternalDraftApprovedSend } from './internal-draft-approved-send';

const doubles = vi.hoisted(() => ({
  tx: {} as any,
  db: {} as any,
  envelope: {} as any,
  role: 'ADMIN',
  reviewerRole: 'MANAGER',
  snapshotHash: 'a'.repeat(64),
  send: vi.fn(),
  job: vi.fn(),
  webhook: vi.fn(),
}));
vi.mock('@documenso/prisma', () => ({ prisma: new Proxy({}, { get: (_target, key) => doubles.db[key] }) }));
vi.mock('./internal-draft-review', () => ({
  readCurrentInternalDraft: async () => ({ envelope: doubles.envelope, role: doubles.role }),
  currentInternalDraftRole: async () => doubles.reviewerRole,
  preparedDraftArtifactsSchema: z.array(
    z.object({
      envelopeItemId: z.string(),
      originalDocumentDataId: z.string(),
      stagedDocumentDataId: z.string(),
      sha256: z.string(),
    }),
  ),
}));
vi.mock('./internal-draft-review-snapshot', () => ({
  createInternalDraftSnapshot: async () => ({ snapshotHash: doubles.snapshotHash }),
}));
vi.mock('../document/send-document', () => ({
  sendDocumentWithContext: (...args: unknown[]) => doubles.send(...args),
}));
vi.mock('../../universal/upload/get-file.server', () => ({
  getFileServerSide: async ({ data }: { data: string }) => Buffer.from(data),
}));
vi.mock('../../jobs/client', () => ({ jobs: { triggerJob: (...args: unknown[]) => doubles.job(...args) } }));
vi.mock('../webhooks/trigger/trigger-webhook', () => ({
  triggerWebhook: (...args: unknown[]) => doubles.webhook(...args),
}));
let review: any, policy: any, operation: any, current: string;
const preparedBytes = 'prepared PDF bytes';
const artifacts = [
  {
    envelopeItemId: 'item',
    originalDocumentDataId: 'current',
    stagedDocumentDataId: 'staged',
    sha256: createHash('sha256').update(preparedBytes).digest('hex'),
  },
];
const preparedHash = createHash('sha256').update(JSON.stringify(artifacts)).digest('hex');
const input = () => ({
  envelopeId: 'env',
  userId: 1,
  teamId: 4,
  reviewId: 'review',
  operationKey: 'send_operation_123',
  preparedHash,
  requestMetadata: undefined,
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PRIVATE_INTERNAL_DRAFT_REVIEW_ENABLED = 'true';
  current = 'draft bytes';
  operation = null;
  doubles.role = 'ADMIN';
  doubles.reviewerRole = 'MANAGER';
  doubles.snapshotHash = 'a'.repeat(64);
  doubles.envelope = {
    id: 'env',
    userId: 1,
    visibility: 'EVERYONE',
    status: 'DRAFT',
    envelopeItems: [{ id: 'item', documentDataId: 'current' }],
  };
  policy = { required: true, version: 2, selectedReviewId: 'review' };
  review = {
    id: 'review',
    status: 'APPROVED',
    policyVersion: 2,
    reviewerUserId: 3,
    requesterUserId: 1,
    decisionUserId: 3,
    snapshotHash: doubles.snapshotHash,
    preparedHash,
    preparedArtifacts: artifacts,
    expiresAt: new Date(Date.now() + 60000),
  };
  doubles.tx = {
    internalDraftApprovalPolicy: { findUnique: async () => policy },
    internalDraftReview: { findFirst: async () => review },
    documentData: {
      findUnique: async () => ({ id: 'staged', type: 'BYTES', data: preparedBytes }),
      update: vi.fn(async ({ data }) => {
        current = data.data;
      }),
    },
    internalDraftSendOperation: {
      findUnique: async () => operation,
      create: vi.fn(async ({ data }) => (operation = { id: 'op', dispatchState: 'PENDING', nextIntent: 0, ...data })),
      updateMany: async ({ data }) => {
        operation = { ...operation, ...data };
        return { count: 1 };
      },
      update: async ({ data }) => (operation = { ...operation, ...data }),
    },
  };
  doubles.db = {
    ...doubles.tx,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const before = { current, envelope: structuredClone(doubles.envelope), operation: structuredClone(operation) };
      try {
        return await callback(doubles.tx);
      } catch (error) {
        current = before.current;
        doubles.envelope = before.envelope;
        operation = before.operation;
        throw error;
      }
    },
  };
  doubles.send.mockImplementation(async (_options, context) => {
    expect(context.prepared).toBe(true);
    expect(context.approved).toBe(true);
    expect(current).toBe(preparedBytes);
    doubles.envelope.status = 'PENDING';
    await context.enqueue({ kind: 'JOB', options: { name: 'synthetic', payload: {} } });
  });
});
describe('native approved execution source orchestration', () => {
  it('commits bound bytes/native transition/intent together and replays without resending', async () => {
    const result = await executeInternalDraftApprovedSend(input());
    expect(result.dispatchState).toBe('PENDING');
    expect(result.outboundIntents).toHaveLength(1);
    expect(doubles.job).not.toHaveBeenCalled();
    expect((await executeInternalDraftApprovedSend(input())).id).toBe(result.id);
    expect(doubles.send).toHaveBeenCalledTimes(1);
  });
  it.each(['revokedAt', 'withdrawnAt'])('rejects current %s without publishing prepared bytes', async (field) => {
    review[field] = new Date();
    await expect(executeInternalDraftApprovedSend(input())).rejects.toThrow('approved review');
    expect(current).toBe('draft bytes');
    expect(doubles.send).not.toHaveBeenCalled();
  });
  it('rejects current role loss, policy supersession and changed authoring material', async () => {
    doubles.reviewerRole = 'MEMBER';
    await expect(executeInternalDraftApprovedSend(input())).rejects.toThrow('reviewer authority');
    doubles.reviewerRole = 'MANAGER';
    policy.version = 3;
    await expect(executeInternalDraftApprovedSend(input())).rejects.toThrow('approved review');
    policy.version = 2;
    doubles.snapshotHash = 'c'.repeat(64);
    await expect(executeInternalDraftApprovedSend(input())).rejects.toThrow('draft changed');
    expect(current).toBe('draft bytes');
  });
  it('rolls back published prepared bytes when native transition fails', async () => {
    doubles.send.mockRejectedValueOnce(new Error('native validation denied'));
    await expect(executeInternalDraftApprovedSend(input())).rejects.toThrow('native validation');
    expect(current).toBe('draft bytes');
    expect(operation).toBeNull();
    expect(doubles.job).not.toHaveBeenCalled();
  });
  it('records unknown outbound submission without automatic retry', async () => {
    await executeInternalDraftApprovedSend(input());
    doubles.job.mockRejectedValueOnce(new Error('queue timeout'));
    expect((await dispatchInternalDraftSendOperation(input())).dispatchState).toBe('UNKNOWN');
    await dispatchInternalDraftSendOperation(input());
    expect(doubles.job).toHaveBeenCalledTimes(1);
  });
  it('labels accepted native submission queued and keeps delivery unconfirmed', async () => {
    await executeInternalDraftApprovedSend(input());
    const receipt = await dispatchInternalDraftSendOperation(input());
    expect(receipt.dispatchState).toBe('QUEUED');
    expect(receipt.deliveryConfirmed).toBe(false);
    expect(receipt.nextIntent).toBe(1);
  });
});
