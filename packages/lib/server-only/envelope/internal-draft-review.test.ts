import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideInternalDraftReview,
  readInternalDraftReview,
  requestInternalDraftReview,
} from './internal-draft-review';
import type { ReviewEnvelope } from './internal-draft-review-snapshot';
import { createInternalDraftSnapshot } from './internal-draft-review-snapshot';

const doubles = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    user: { findFirst: vi.fn() },
    team: { findFirst: vi.fn() },
    envelope: { findFirst: vi.fn() },
    internalDraftReview: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
  transaction: vi.fn(),
}));
vi.mock('@documenso/prisma', () => ({ prisma: { $transaction: doubles.transaction } }));
vi.mock('../../universal/upload/get-file.server', () => ({
  getFileServerSide: async ({ data }: { data: string }) => Buffer.from(data),
}));

const draft = () =>
  ({
    id: 'env-review',
    teamId: 4,
    userId: 1,
    title: 'Synthetic agreement',
    status: 'DRAFT',
    type: 'DOCUMENT',
    signatureLevel: 'SES',
    internalVersion: 2,
    useLegacyFieldInsertion: false,
    visibility: 'EVERYONE',
    authOptions: null,
    formValues: null,
    documentMeta: { id: 'meta-1', signingOrder: 'SEQUENTIAL', subject: 'Review', message: '', language: 'en' },
    documentMetaId: 'meta-1',
    envelopeItems: [
      { id: 'item-1', title: 'Agreement', order: 0, documentData: { type: 'BYTES', data: 'draft bytes' } },
    ],
    recipients: [
      {
        id: 11,
        name: 'Synthetic signer',
        email: 'signer@example.test',
        role: 'SIGNER',
        signingOrder: 1,
        authOptions: null,
        token: 'PRIVATE-TOKEN',
      },
    ],
    fields: [],
    envelopeAttachments: [],
  }) as unknown as ReviewEnvelope;

let envelope: ReviewEnvelope;
let roles: Map<number, string>;
let disabled: Set<number>;
let stored: Record<string, unknown> | null;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const request = () => ({
  userId: 1,
  teamId: 4,
  envelopeId: 'env-review',
  reviewerUserId: 2,
  operationKey: 'review-operation-0001',
  expiresAt: new Date('2026-10-03T12:00:00Z'),
});
const decide = (snapshotHash: string, decision: 'APPROVED' | 'REJECTED' = 'APPROVED') => ({
  userId: 2,
  teamId: 4,
  envelopeId: 'env-review',
  reviewId: 'review-1',
  snapshotHash,
  decision,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  vi.stubEnv('NEXT_PRIVATE_INTERNAL_DRAFT_REVIEW_ENABLED', 'true');
  envelope = draft();
  roles = new Map([
    [1, 'MEMBER'],
    [2, 'MANAGER'],
    [3, 'MANAGER'],
  ]);
  disabled = new Set();
  stored = null;
  doubles.transaction.mockImplementation(async (callback) => callback(doubles.tx));
  doubles.tx.$queryRaw.mockImplementation((strings, ...values) => {
    const sql = strings.join('');
    if (sql.includes('JOIN "TeamGroup"')) {
      const [userId, teamId] = values;
      return teamId === 4 && roles.has(userId) && !disabled.has(userId) ? [{ id: 'native-membership' }] : [];
    }
    return [{ id: 'native-material' }];
  });
  doubles.tx.user.findFirst.mockImplementation(async ({ where }) => (disabled.has(where.id) ? null : { id: where.id }));
  doubles.tx.team.findFirst.mockImplementation(({ where }) => {
    const userId = where.teamGroups.some.organisationGroup.organisationGroupMembers.some.organisationMember.userId;
    return where.id === 4 && roles.has(userId) ? { id: 4, teamGroups: [{ teamRole: roles.get(userId) }] } : null;
  });
  doubles.tx.envelope.findFirst.mockImplementation(({ where }) => {
    if (where.id !== envelope.id || where.teamId !== envelope.teamId) {
      return null;
    }
    return where.OR[0].userId === envelope.userId || where.OR[1].visibility.in.includes(envelope.visibility)
      ? envelope
      : null;
  });
  doubles.tx.internalDraftReview.findUnique.mockImplementation(async () => stored);
  doubles.tx.internalDraftReview.findFirst.mockImplementation(async ({ where }) =>
    stored?.id === where.id && stored?.envelopeId === where.envelopeId ? stored : null,
  );
  doubles.tx.internalDraftReview.create.mockImplementation(({ data }) => {
    stored = { ...data, id: 'review-1', status: 'PENDING', policyVersion: 1, createdAt: new Date(), decidedAt: null };
    return stored;
  });
  doubles.tx.internalDraftReview.updateMany.mockImplementation(({ where, data }) => {
    if (stored?.status !== where.status || stored?.snapshotHash !== where.snapshotHash) {
      return { count: 0 };
    }
    stored = { ...stored, ...data };
    return { count: 1 };
  });
  doubles.tx.internalDraftReview.findUniqueOrThrow.mockImplementation(async () => stored);
});

describe('native internal draft review record service (isolated Prisma doubles)', () => {
  it('defaults to disabled before querying native data', async () => {
    vi.stubEnv('NEXT_PRIVATE_INTERNAL_DRAFT_REVIEW_ENABLED', 'false');
    await expect(requestInternalDraftReview(request())).rejects.toThrow('not enabled');
    expect(doubles.transaction).not.toHaveBeenCalled();
  });

  it('stores a material snapshot without signer tokens and never authorizes send', async () => {
    const result = await requestInternalDraftReview(request());
    expect(result).toMatchObject({ status: 'PENDING', canAuthorizeSend: false, sendEnforcement: 'NOT_INTEGRATED' });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE-TOKEN');
    expect(doubles.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('replays the same operation without a second review; changed content conflicts', async () => {
    const first = await requestInternalDraftReview(request());
    expect(await requestInternalDraftReview(request())).toEqual(first);
    expect(doubles.tx.internalDraftReview.create).toHaveBeenCalledTimes(1);
    envelope.title = 'Revised';
    await expect(requestInternalDraftReview(request())).rejects.toThrow('different draft review');
  });

  it('rejects self-review and owner-review when requested by a manager', async () => {
    await expect(requestInternalDraftReview({ ...request(), reviewerUserId: 1 })).rejects.toThrow('independent');
    await expect(requestInternalDraftReview({ ...request(), userId: 3, reviewerUserId: 1 })).rejects.toThrow(
      'independent',
    );
    expect(stored).toBeNull();
  });

  it('rejects foreign team, disabled actor and unprivileged reviewer', async () => {
    await expect(requestInternalDraftReview({ ...request(), teamId: 99 })).rejects.toThrow('membership');
    disabled.add(1);
    await expect(requestInternalDraftReview(request())).rejects.toThrow('membership');
    disabled.clear();
    roles.set(2, 'MEMBER');
    await expect(requestInternalDraftReview(request())).rejects.toThrow('team manager');
    expect(stored).toBeNull();
  });

  it('records one independent decision and preserves it on retry', async () => {
    const pending = await requestInternalDraftReview(request());
    const approved = await decideInternalDraftReview(decide(pending.snapshotHash));
    expect(approved).toMatchObject({ status: 'APPROVED', canAuthorizeSend: false });
    expect(await decideInternalDraftReview(decide(pending.snapshotHash))).toEqual(approved);
    expect(doubles.tx.internalDraftReview.updateMany).toHaveBeenCalledTimes(1);
    await expect(decideInternalDraftReview(decide(pending.snapshotHash, 'REJECTED'))).rejects.toThrow(
      'cannot be replaced',
    );
  });

  it('reads fresh record authority without revealing snapshot contents; stale draft disables decision', async () => {
    await requestInternalDraftReview(request());
    const options = { userId: 2, teamId: 4, envelopeId: 'env-review', reviewId: 'review-1' };
    const record = await readInternalDraftReview(options);
    expect(record).toMatchObject({ materialMatches: true, canRecordDecision: true, canAuthorizeSend: false });
    expect(record).not.toHaveProperty('snapshot');
    envelope.title = 'New draft';
    expect(await readInternalDraftReview(options)).toMatchObject({ materialMatches: false, canRecordDecision: false });
    await expect(readInternalDraftReview({ ...options, userId: 3 })).rejects.toThrow('not found for this actor');
  });

  it('rechecks designated reviewer role and active account at decision time', async () => {
    const pending = await requestInternalDraftReview(request());
    roles.set(2, 'MEMBER');
    await expect(decideInternalDraftReview(decide(pending.snapshotHash))).rejects.toThrow('designated');
    roles.set(2, 'MANAGER');
    disabled.add(2);
    await expect(decideInternalDraftReview(decide(pending.snapshotHash))).rejects.toThrow('membership');
    expect(doubles.tx.internalDraftReview.updateMany).not.toHaveBeenCalled();
  });

  it('rejects another manager, wrong review binding and expired review', async () => {
    const pending = await requestInternalDraftReview(request());
    await expect(decideInternalDraftReview({ ...decide(pending.snapshotHash), userId: 3 })).rejects.toThrow(
      'designated',
    );
    await expect(decideInternalDraftReview(decide('a'.repeat(64)))).rejects.toThrow('draft changed');
    vi.setSystemTime(request().expiresAt);
    await expect(decideInternalDraftReview(decide(pending.snapshotHash))).rejects.toThrow('expired');
  });

  it('detects PDF byte and recipient changes before a decision', async () => {
    const pending = await requestInternalDraftReview(request());
    envelope.envelopeItems[0].documentData.data = 'different bytes';
    await expect(decideInternalDraftReview(decide(pending.snapshotHash))).rejects.toThrow('draft changed');
    envelope = draft();
    envelope.recipients[0].email = 'other@example.test';
    await expect(decideInternalDraftReview(decide(pending.snapshotHash))).rejects.toThrow('draft changed');
    expect(doubles.tx.internalDraftReview.updateMany).not.toHaveBeenCalled();
  });

  it('rejects stale CAS outcome and non-draft state without persisting a decision', async () => {
    const pending = await requestInternalDraftReview(request());
    doubles.tx.internalDraftReview.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(decideInternalDraftReview(decide(pending.snapshotHash))).rejects.toThrow('Reload');
    envelope.status = 'PENDING';
    await expect(decideInternalDraftReview(decide(pending.snapshotHash))).rejects.toThrow('Only draft');
  });

  it('hashes ordered native authoring inputs independently of object key order and storage identity', async () => {
    const first = await createInternalDraftSnapshot(envelope);
    envelope.authOptions = { globalAccessAuth: [], globalActionAuth: [] };
    const changed = await createInternalDraftSnapshot(envelope);
    expect(changed.snapshotHash).not.toBe(first.snapshotHash);
    envelope.authOptions = { globalActionAuth: [], globalAccessAuth: [] };
    expect((await createInternalDraftSnapshot(envelope)).snapshotHash).toBe(changed.snapshotHash);
  });

  it('fails closed on lock/serialization failure and an unsupported policy without recording a decision', async () => {
    doubles.tx.$queryRaw.mockRejectedValueOnce(new Error('serialization conflict'));
    await expect(requestInternalDraftReview(request())).rejects.toThrow('serialization conflict');
    expect(doubles.tx.internalDraftReview.create).not.toHaveBeenCalled();
    const pending = await requestInternalDraftReview(request());
    if (!stored) {
      throw new Error('Missing test review');
    }
    stored.policyVersion = 2;
    await expect(decideInternalDraftReview(decide(pending.snapshotHash))).rejects.toThrow('Unsupported');
    expect(doubles.tx.internalDraftReview.updateMany).not.toHaveBeenCalled();
  });
});
