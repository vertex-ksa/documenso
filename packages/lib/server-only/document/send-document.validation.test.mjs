import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

// Execute the actual send orchestration with isolated dependency doubles. This
// focused check requires no database, storage, mailer, credentials or providers.
const source = await readFile(new URL('./send-document.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source.replace(/import[\s\S]*?from '[^']+';/g, '').replace(/export /g, ''));

const fixture = ({
  authRequired = false,
  missingFields = false,
  invalidField = false,
  tsp = false,
  ccOnly = false,
  fullCommit = false,
} = {}) => {
  const effects = [];
  const envelope = {
    id: 'envelope-test',
    secondaryId: 'test',
    title: 'Draft',
    status: 'DRAFT',
    signatureLevel: tsp ? 'AES' : 'SES',
    internalVersion: invalidField ? 2 : 1,
    formValues: { name: 'Synthetic' },
    authOptions: null,
    recipients: [
      { id: 1, email: '', role: ccOnly ? 'CC' : 'SIGNER', signingStatus: 'NOT_SIGNED', sendStatus: 'NOT_SENT' },
    ],
    fields: invalidField ? [{ id: 1, recipientId: 1, type: 'TEXT', fieldMeta: {} }] : [],
    documentMeta: { signingOrder: 'PARALLEL' },
    envelopeItems: [{ id: 'item-test', documentData: { id: 'data-test' } }],
    team: { organisation: { organisationClaim: { recipientCount: 0 } } },
  };
  const context = {
    assertInternalDraftSendPolicy: async () => {},
    createDocumentAuditLogData: (value) => value,
    resolveExpiresAt: () => null,
    extractDerivedDocumentEmailSettings: () => ({ recipientSigningRequest: true }),
    WebhookTriggerEvents: { DOCUMENT_SENT: 'DOCUMENT_SENT' },
    mapEnvelopeToWebhookDocumentPayload: (value) => value,
    ZWebhookDocumentSchema: { parse: (value) => value },
    triggerWebhook: async () => { effects.push('webhook'); },
    DOCUMENT_AUDIT_LOG_TYPE: { DOCUMENT_SENT: 'DOCUMENT_SENT' },
    testEffects: effects,
    console,
    Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    Buffer,
    AppError: class extends Error {
      constructor(code, options) {
        super(options.message);
        this.code = code;
      }
    },
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
      envelope: { findFirst: async () => envelope, findFirstOrThrow: async () => envelope, update: async () => { effects.push('pending'); return {...envelope,status:'PENDING'}; } },
      documentMeta: {
        update: async () => {
          effects.push('meta-update');
        },
      },
      envelopeItem: {
        update: async () => {
          effects.push('item-update');
        },
      },
      $queryRaw: async () => [],
      documentAuditLog: { create: async () => { effects.push('transaction'); if (!fullCommit) throw new Error('validated-boundary'); return {};  } },
      $transaction: async (callback) => callback(context.prisma),
    },
    isDocumentCompleted: () => false,
    mapSecondaryIdToDocumentId: () => 1,
    isTspEnvelope: () => tsp,
    materializeTspAnchorsForEnvelope: async () => {
      effects.push('anchors');
    },
    ZFieldAndMetaSchema: { safeParse: () => ({ error: { message: 'invalid synthetic field metadata' } }) },
    extractDocumentAuthMethods: () => ({
      recipientAccessAuthRequired: authRequired,
      recipientActionAuthRequired: false,
    }),
    isRecipientEmailValidForSending: () => false,
    getRecipientsWithMissingFields: () => (missingFields ? envelope.recipients : []),
    getFileServerSide: async () => {
      effects.push('file-read');
      return Buffer.from('synthetic');
    },
    insertFormValuesInPdf: async () => {
      effects.push('pdf-render');
      return Buffer.from('prefilled');
    },
    putNormalizedPdfFileServerSide: async () => {
      effects.push('file-write');
      return { id: 'replacement' };
    },
    jobs: {
      triggerJob: async () => {
        effects.push('job');
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(executable + '\nglobalThis.invokeSend = sendDocument; globalThis.invokeApproved = (options) => sendDocumentWithContext(options, {tx: prisma, prepared: true, approved: true, enqueue: async (effect) => { testEffects.push("queued-"+effect.kind); }});', context);
  return { effects, send: () => context.invokeSend({ id: {}, userId: 1, teamId: 1 }), approved: () => context.invokeApproved({id:{},userId:1,teamId:1}) };
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

test('valid recipients still materialize prefilled PDFs within the native send transaction', async () => {
  const { send, effects } = fixture();
  await assert.rejects(send(), { message: 'validated-boundary' });
  assert.deepEqual(effects, ['file-read', 'pdf-render', 'file-write', 'item-update', 'transaction']);
});

test('advanced field metadata denial occurs before PDF or database preparation effects', async () => {
  const { send, effects } = fixture({ invalidField: true });
  await assert.rejects(send(), { code: 'INVALID_REQUEST' });
  assert.deepEqual(effects, []);
});
test('TSP recipient denial does not persist signing-order coercion', async () => {
  const { send, effects } = fixture({ tsp: true, authRequired: true });
  await assert.rejects(send(), { code: 'INVALID_REQUEST' });
  assert.deepEqual(effects, []);
});
test('valid TSP still persists sequential coercion and anchors before send transaction', async () => {
  const { send, effects } = fixture({ tsp: true });
  await assert.rejects(send(), { message: 'validated-boundary' });
  assert.deepEqual(effects, [
    'meta-update',
    'file-read',
    'pdf-render',
    'file-write',
    'item-update',
    'anchors',
    'transaction',
  ]);
});
test('CC-only path still prefills and requests sealing after preparation commits', async () => {
  const { send, effects } = fixture({ ccOnly: true });
  await send();
  assert.deepEqual(effects, ['file-read', 'pdf-render', 'file-write', 'item-update', 'job']);
});

test('actual native approved send context reuses staged bytes and records native transition with queued effects', async () => {
  const {approved,effects}=fixture({fullCommit:true,tsp:true});
  const result=await approved();
  assert.equal(result.status,'PENDING');
  assert.deepEqual(effects,['meta-update','transaction','pending','queued-JOB','queued-WEBHOOK']);
});
