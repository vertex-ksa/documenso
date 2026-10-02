import { prisma } from '@documenso/prisma';
import type { DocumentDataType, Prisma } from '@prisma/client';

export type CreateDocumentDataOptions = {
  type: DocumentDataType;
  data: string;

  /**
   * The initial data that was used to create the document data.
   *
   * If not provided, the current data will be used.
   */
  initialData?: string;
};

export const createDocumentData = async (
  { type, data, initialData }: CreateDocumentDataOptions,
  db: Pick<Prisma.TransactionClient, 'documentData'> = prisma,
) => {
  return await db.documentData.create({
    data: {
      type,
      data,
      initialData: initialData || data,
    },
  });
};
