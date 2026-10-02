import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Execute the actual send orchestration with isolated dependency doubles. This
// focused check requires no database, storage, mailer, credentials or providers.
const source = await readFile(new URL('./send-document.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(
  source.replace(/import[\s\S]*?from '[^']+';/g, '').replace(/export /g, ''),
);

const fixture = ({ authRequired = false, missingFields = false } = {}) => {
  const effects = [];
  const envelope = {
    id: 'envelope-test', secondaryId: 'test', title: 'Draft', status: 'DRAFT',
    internalVersion: 1, formValues: { name: 'Synthetic' }, authOptions: null,
    recipients: [{ id: 1, email: '', role: 'SIGNER', signingStatus: 'NOT_SIGNED', sendStatus: 'NOT_SENT' }],
    fields: [], documentMeta: { signingOrder: 'PARALLEL' },
    envelopeItems: [{ id: 'item-test', documentData: { id: 'data-test' } }],
    team: { organisation: { organisationClaim: { recipientCount: 0 } } },
  };
  const context = {
    console, Buffer,
    AppError: class extends Error { constructor(code, options) { super(options.message); this.code = code; } },
    AppErrorCode: { INVALID_REQUEST: 'INVALID_REQUEST', MISSING_SIGNATURE_FIELD: 'MISSING_SIGNATURE_FIELD' },
    DocumentStatus: { DRAFT: 'DRAFT', PENDING: 'PENDING' },
    EnvelopeType: { DOCUMENT: 'DOCUMENT' },
    RecipientRole: { CC: 'CC' },
    DocumentSigningOrder: { PARALLEL: 'PARALLEL', SEQUENTIAL: 'SEQUENTIAL' },
    SigningStatus: { NOT_SIGNED: 'NOT_SIGNED', SIGNED: 'SIGNED' },
    SendStatus: { SENT: 'SENT' },
    assertUserNotDisabledById: async () => {},
    getEnvelopeWhereInput: async () => ({ envelopeWhereInput: {} }),
    prisma: {
      envelope: { findFirst: async () => envelope },
      envelopeItem: { update: async () => { effects.push('item-update'); } },
      $transaction: async () => { effects.push('transaction'); throw new Error('validated-boundary'); },
    },
    isDocumentCompleted: () => false,
    mapSecondaryIdToDocumentId: () => 1,
    isTspEnvelope: () => false,
    extractDocumentAuthMethods: () => ({ recipientAccessAuthRequired: authRequired, recipientActionAuthRequired: false }),
    isRecipientEmailValidForSending: () => false,
    getRecipientsWithMissingFields: () => missingFields ? envelope.recipients : [],
    getFileServerSide: async () => { effects.push('file-read'); return Buffer.from('synthetic'); },
    insertFormValuesInPdf: async () => { effects.push('pdf-render'); return Buffer.from('prefilled'); },
    putNormalizedPdfFileServerSide: async () => { effects.push('file-write'); return { id: 'replacement' }; },
    jobs: { triggerJob: async () => { effects.push('job'); } },
  };
  vm.createContext(context);
  vm.runInContext(executable + '\nglobalThis.invokeSend = sendDocument;', context);
  return { effects, send: () => context.invokeSend({ id: {}, userId: 1, teamId: 1 }) };
};

test('auth-required recipient denial does not render or persist a prefilled draft', async () => {
  const { send, effects } = fixture({ authRequired: true });
  await assert.rejects(send(), { code: 'INVALID_REQUEST' });
  assert.deepEqual(effects, []);
});

test('missing signature field denial does not render or persist a prefilled draft', async () => {
  const { send, effects } = fixture({ missingFields: true });
  await assert.rejects(send(), { code: 'MISSING_SIGNATURE_FIELD' });
  assert.deepEqual(effects, []);
});

test('valid recipients still materialize prefilled PDFs before the send transaction', async () => {
  const { send, effects } = fixture();
  await assert.rejects(send(), { message: 'validated-boundary' });
  assert.deepEqual(effects, ['file-read', 'pdf-render', 'file-write', 'item-update', 'transaction']);
});
