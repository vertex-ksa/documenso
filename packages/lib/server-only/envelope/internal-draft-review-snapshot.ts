import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { getFileServerSide } from '../../universal/upload/get-file.server';

export const draftReviewInclude = {
  documentMeta: true,
  envelopeItems: { include: { documentData: true }, orderBy: [{ order: 'asc' }, { id: 'asc' }] },
  envelopeAttachments: { orderBy: { id: 'asc' } },
  recipients: { orderBy: { id: 'asc' } },
  fields: { orderBy: { id: 'asc' } },
} satisfies Prisma.EnvelopeInclude;

export type ReviewEnvelope = Prisma.EnvelopeGetPayload<{ include: typeof draftReviewInclude }>;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === null ? 'null' : canonicalJson(item))).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }

  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('Undefined draft snapshot property');
  }
  return encoded;
};

// Bind the native draft bytes and authoring inputs. This is not a rendered
// signature digest, certificate, legal determination or send authorization.
export const createInternalDraftSnapshot = async (envelope: ReviewEnvelope) => {
  const items = await Promise.all(
    envelope.envelopeItems.map(async (item) => ({
      id: item.id,
      title: item.title,
      order: item.order,
      sha256: createHash('sha256')
        .update(await getFileServerSide(item.documentData))
        .digest('hex'),
    })),
  );

  const snapshot: Prisma.InputJsonObject = {
    schemaVersion: 1,
    envelopeId: envelope.id,
    teamId: envelope.teamId,
    ownerUserId: envelope.userId,
    title: envelope.title,
    signatureLevel: envelope.signatureLevel,
    internalVersion: envelope.internalVersion,
    useLegacyFieldInsertion: envelope.useLegacyFieldInsertion,
    visibility: envelope.visibility,
    authOptions: envelope.authOptions,
    formValues: envelope.formValues,
    attachments: envelope.envelopeAttachments.map((attachment) => ({
      id: attachment.id,
      type: attachment.type,
      label: attachment.label,
      data: attachment.data,
    })),
    meta: Object.fromEntries(Object.entries(envelope.documentMeta).filter(([key]) => key !== 'id')),
    items,
    recipients: envelope.recipients.map((recipient) => ({
      id: recipient.id,
      name: recipient.name,
      email: recipient.email,
      role: recipient.role,
      signingOrder: recipient.signingOrder,
      authOptions: recipient.authOptions,
    })),
    fields: envelope.fields.map((field) => ({
      id: field.id,
      envelopeItemId: field.envelopeItemId,
      recipientId: field.recipientId,
      type: field.type,
      page: field.page,
      positionX: field.positionX.toString(),
      positionY: field.positionY.toString(),
      width: field.width.toString(),
      height: field.height.toString(),
      customText: field.customText,
      inserted: field.inserted,
      fieldMeta: field.fieldMeta,
    })),
  };

  return { snapshot, snapshotHash: createHash('sha256').update(canonicalJson(snapshot)).digest('hex') };
};
