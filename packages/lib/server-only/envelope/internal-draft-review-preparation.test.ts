import { createHash } from 'node:crypto';
import { renderTspAnchors } from '@documenso/ee/server-only/signing/csc/materialize-anchors';
import { PDF } from '@libpdf/core';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { prepareInternalDraftReviewArtifacts } from './internal-draft-review-preparation';
import type { ReviewEnvelope } from './internal-draft-review-snapshot';

vi.mock('../../universal/upload/server-actions', () => ({ getPresignGetUrl: vi.fn() }));
vi.mock('@documenso/prisma', () => ({ prisma: {} }));
vi.mock('../../universal/upload/get-file.server', () => ({
  getFileServerSide: async ({ data }: { data: string }) => Buffer.from(data, 'base64'),
}));
vi.mock('../../universal/upload/put-file.server', () => ({
  putPdfFileServerSide: vi.fn(),
  putFileServerSide: async (file: { arrayBuffer: () => Promise<ArrayBuffer> }) => ({
    type: 'BYTES_64',
    data: Buffer.from(await file.arrayBuffer()).toString('base64'),
  }),
}));
const bytes = async () => {
  const pdf = PDF.create();
  pdf.addPage();
  return Buffer.from(await pdf.save());
};
describe('native review artifact preparation', () => {
  it('reuses native TSP anchor and stamp mechanics idempotently without signing', async () => {
    const source = await bytes();
    const envelope = {
      signatureLevel: 'AES',
      recipients: [{ id: 7 }],
      fields: [{ recipientId: 7, envelopeItemId: 'item-1', page: 1 }],
    };
    const prepared = await renderTspAnchors({ envelope, envelopeItemId: 'item-1', bytes: source });
    expect(prepared.equals(source)).toBe(false);
    const parsed = await PDF.load(prepared);
    expect(parsed.getForm()?.getSignatureFields()).toHaveLength(1);
    expect(parsed.getPages()[0].getStampAnnotations()).toHaveLength(1);
    expect((await renderTspAnchors({ envelope, envelopeItemId: 'item-1', bytes: prepared })).equals(prepared)).toBe(
      true,
    );
  });
  it('reads staged BYTES_64 through the actual native file decoder without object storage', async () => {
    const native = await vi.importActual<typeof import('../../universal/upload/get-file.server')>(
      '../../universal/upload/get-file.server',
    );
    const source = await bytes();
    expect(
      Buffer.from(await native.getFileServerSide({ type: 'BYTES_64', data: source.toString('base64') })).equals(source),
    ).toBe(true);
  });
  it('stages separate data and preserves current native item and PDF references', async () => {
    const source = await bytes();
    const item = {
      id: 'item-1',
      documentDataId: 'current',
      documentData: {
        id: 'current',
        type: 'BYTES_64',
        data: source.toString('base64'),
        initialData: source.toString('base64'),
      },
    };
    const envelope = {
      title: 'Draft',
      signatureLevel: 'SES',
      formValues: null,
      recipients: [{ id: 7, role: 'SIGNER', signingStatus: 'NOT_SIGNED' }],
      fields: [],
      envelopeItems: [item],
    } as unknown as ReviewEnvelope;
    const create = vi.fn(async ({ data }) => ({ id: 'staged', ...data }));
    const tx = { documentData: { create } } as unknown as Prisma.TransactionClient;
    const result = await prepareInternalDraftReviewArtifacts(tx, envelope, {
      items: [{ id: item.id, sha256: createHash('sha256').update(source).digest('hex') }],
    });
    expect(result.preparedArtifacts[0].stagedDocumentDataId).toBe('staged');
    expect(item.documentDataId).toBe('current');
    expect(item.documentData.data).toBe(source.toString('base64'));
    await expect(
      prepareInternalDraftReviewArtifacts(tx, envelope, { items: [{ id: item.id, sha256: 'bad' }] }),
    ).rejects.toThrow('Source PDF changed');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
