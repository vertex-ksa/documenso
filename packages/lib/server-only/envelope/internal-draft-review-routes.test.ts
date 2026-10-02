import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrpcContext } from '../../../trpc/server/context';
import { decideInternalDraftReviewRoute } from '../../../trpc/server/envelope-router/decide-internal-draft-review';
import { executeInternalDraftApprovedSendRoute } from '../../../trpc/server/envelope-router/execute-internal-draft-approved-send';
import { getInternalDraftReviewRoute } from '../../../trpc/server/envelope-router/get-internal-draft-review';
import { dispatchInternalDraftSendOperationRoute } from '../../../trpc/server/envelope-router/internal-draft-send-operation';
import { requestInternalDraftReviewRoute } from '../../../trpc/server/envelope-router/request-internal-draft-review';
import { router } from '../../../trpc/server/trpc';

const service = vi.hoisted(() => ({
  request: vi.fn(),
  decide: vi.fn(),
  read: vi.fn(),
  execute: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('./internal-draft-review', () => ({
  requestInternalDraftReview: service.request,
  decideInternalDraftReview: service.decide,
  readInternalDraftReview: service.read,
}));
vi.mock('./internal-draft-approved-send', () => ({
  executeInternalDraftApprovedSend: service.execute,
  dispatchInternalDraftSendOperation: service.dispatch,
  readInternalDraftSendOperation: vi.fn(),
}));
vi.mock('../public-api/get-api-token-by-token', () => ({ getApiTokenByToken: vi.fn() }));

const routes = router({
  request: requestInternalDraftReviewRoute,
  decide: decideInternalDraftReviewRoute,
  get: getInternalDraftReviewRoute,
  execute: executeInternalDraftApprovedSendRoute,
  dispatch: dispatchInternalDraftSendOperationRoute,
});
const context = (): TrpcContext => ({
  user: {
    id: 1,
    email: 'actor@example.test',
    name: 'Synthetic actor',
    disabled: false,
    signature: null,
    roles: ['USER'],
    avatarImageId: null,
    emailVerified: null,
    twoFactorEnabled: false,
  },
  session: {
    id: 'synthetic',
    sessionToken: 'synthetic',
    userId: 1,
    ipAddress: null,
    userAgent: null,
    expiresAt: new Date('2026-11-01T00:00:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  teamId: 4,
  req: new Request('http://localhost/trpc'),
  res: new Response(),
  metadata: { source: 'app', auth: null, requestMetadata: {} },
  logger: pino({ enabled: false }),
});
const result = () => ({
  id: 'review-1',
  status: 'PENDING',
  snapshotHash: 'a'.repeat(64),
  policyVersion: 1,
  createdAt: new Date(),
  expiresAt: new Date('2026-10-03T12:00:00Z'),
  decidedAt: null,
  canAuthorizeSend: false,
  sendEnforcement: 'NATIVE_TRANSACTIONAL_SEND',
});

beforeEach(() => {
  vi.clearAllMocks();
  service.execute.mockResolvedValue({
    id: 'op',
    reviewId: 'review-1',
    dispatchState: 'PENDING',
    createdAt: new Date(),
  });
  service.dispatch.mockResolvedValue({ id: 'op', dispatchState: 'UNKNOWN', deliveryConfirmed: false });
  service.request.mockResolvedValue(result());
  service.decide.mockResolvedValue({ ...result(), status: 'APPROVED' });
  service.read.mockResolvedValue({ ...result(), materialMatches: true, expired: false, canRecordDecision: true });
});

describe('native internal draft review route boundary (synthetic native context)', () => {
  it('binds protected send and dispatch to the authenticated native actor/team', async () => {
    await routes.createCaller(context()).execute({
      envelopeId: 'env-1',
      reviewId: 'review-1',
      preparedHash: 'b'.repeat(64),
      operationKey: 'send_operation_123',
      userId: 99,
      teamId: 999,
    } as never);
    expect(service.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        teamId: 4,
        requestMetadata: expect.objectContaining({ auth: 'session', auditUser: expect.objectContaining({ id: 1 }) }),
      }),
    );
    await routes
      .createCaller(context())
      .dispatch({ envelopeId: 'env-1', operationKey: 'send_operation_123', userId: 99, teamId: 999 } as never);
    expect(service.dispatch).toHaveBeenCalledWith({
      envelopeId: 'env-1',
      operationKey: 'send_operation_123',
      userId: 1,
      teamId: 4,
    });
  });
  it('uses native session actor/team and omits spoofed payload identities', async () => {
    const input = {
      envelopeId: 'env-1',
      reviewerUserId: 2,
      operationKey: 'review-operation-1',
      expiresAt: new Date('2026-10-03T12:00:00Z'),
      userId: 99,
      teamId: 999,
    };
    const response = await routes.createCaller(context()).request(input);
    expect(service.request).toHaveBeenCalledWith({
      envelopeId: 'env-1',
      reviewerUserId: 2,
      operationKey: 'review-operation-1',
      expiresAt: new Date(input.expiresAt),
      userId: 1,
      teamId: 4,
    });
    expect(response.canAuthorizeSend).toBe(false);
  });

  it('requires authenticated active native context before reaching service', async () => {
    const ctx = context();
    const anonymous: TrpcContext = { ...ctx, user: null, session: null };
    const input = {
      envelopeId: 'env-1',
      reviewId: 'review-1',
      snapshotHash: 'a'.repeat(64),
      decision: 'APPROVED' as const,
    };
    await expect(routes.createCaller(anonymous).decide(input)).rejects.toThrow('Invalid session');
    if (!ctx.user) {
      throw new Error('Invalid test context');
    }
    ctx.user.disabled = true;
    await expect(routes.createCaller(ctx).decide(input)).rejects.toThrow();
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('validates decision hash and forwards only native bound read identity', async () => {
    const caller = routes.createCaller(context());
    await expect(
      caller.decide({ envelopeId: 'env-1', reviewId: 'review-1', snapshotHash: 'invalid', decision: 'APPROVED' }),
    ).rejects.toThrow();
    expect(service.decide).not.toHaveBeenCalled();
    await caller.get({ envelopeId: 'env-1', reviewId: 'review-1' });
    expect(service.read).toHaveBeenCalledWith({ envelopeId: 'env-1', reviewId: 'review-1', userId: 1, teamId: 4 });
  });
});
