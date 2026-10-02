import { createHash } from 'node:crypto';

import { PDF } from '@libpdf/core';
import { renderTspAnchors } from '@documenso/ee/server-only/signing/csc/materialize-anchors';
import { DocumentDataType, type Prisma, RecipientRole, SigningStatus } from '@prisma/client';
import { z } from 'zod';
import { AppError, AppErrorCode } from '../../errors/app-error';

import { getFileServerSide } from '../../universal/upload/get-file.server';
import { insertFormValuesInPdf } from '../pdf/insert-form-values-in-pdf';
import { normalizePdf } from '../pdf/normalize-pdf';
import type { ReviewEnvelope } from './internal-draft-review-snapshot';

// Stage native distribution bytes without changing any current EnvelopeItem or
// DocumentData. Private native BYTES_64 staging and immutable review references
// commit together; rollback creates no external object-storage orphan.
export const prepareInternalDraftReviewArtifacts = async (
  tx: Prisma.TransactionClient,
  envelope: ReviewEnvelope,
  expectedSnapshot: Prisma.InputJsonObject,
) => {
  const expectedItems = z.array(z.object({ id: z.string(), sha256: z.string() })).parse(expectedSnapshot.items);
  if (envelope.envelopeItems.length < 1 || envelope.envelopeItems.length > 100) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Private review staging supports 1 to 100 PDF items.',
    });
  }
  let totalBytes = 0;
  const artifacts = [];
  for (const item of envelope.envelopeItems) {
    let bytes = Buffer.from(await getFileServerSide(item.documentData));
    if (
      createHash('sha256').update(bytes).digest('hex') !==
      expectedItems.find((expected) => expected.id === item.id)?.sha256
    ) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Source PDF changed during review preparation.' });
    }
    if (bytes.length > 32 * 1024 * 1024) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Source review PDF exceeds the private staging limit.',
      });
    }
    if (envelope.formValues) {
      bytes = await normalizePdf(
        Buffer.from(
          await insertFormValuesInPdf({
            pdf: bytes,
            formValues: envelope.formValues as Record<string, string | number | boolean>,
          }),
        ),
      );
    }
    if (
      !envelope.recipients.every(
        (recipient) => recipient.role === RecipientRole.CC || recipient.signingStatus === SigningStatus.SIGNED,
      )
    ) {
      bytes = await renderTspAnchors({ envelope, envelopeItemId: item.id, bytes });
    }
    if (bytes.length > 32 * 1024 * 1024) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Prepared review PDF exceeds the private staging limit.',
      });
    }
    const pdf = await PDF.load(bytes).catch(() => { throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Prepared review PDF is invalid.' }); });
    if (pdf.isEncrypted || pdf.getPageCount() < 1) throw new AppError(AppErrorCode.INVALID_REQUEST, { message: 'Prepared review PDF must be readable and contain pages.' });
    const initialBytes = await getFileServerSide({
      ...item.documentData,
      data: item.documentData.initialData ?? item.documentData.data,
    });
    totalBytes += bytes.length + initialBytes.length;
    if (totalBytes > 32 * 1024 * 1024) {
      throw new AppError(AppErrorCode.INVALID_REQUEST, {
        message: 'Private review staging exceeds the 32 MiB total PDF and initial byte limit.',
      });
    }
    const staged = await tx.documentData.create({
      data: {
        type: DocumentDataType.BYTES_64,
        data: bytes.toString('base64'),
        initialData: Buffer.from(initialBytes).toString('base64'),
      },
    });
    artifacts.push({
      envelopeItemId: item.id,
      originalDocumentDataId: item.documentDataId,
      stagedDocumentDataId: staged.id,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return {
    preparedArtifacts: artifacts,
    preparedHash: createHash('sha256').update(JSON.stringify(artifacts)).digest('hex'),
  };
};
