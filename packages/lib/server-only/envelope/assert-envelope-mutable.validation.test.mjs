import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('./assert-envelope-mutable.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(source.replace(/import[\s\S]*?from '[^']+';/g, '').replace(/export /g, ''));
function fixture() {
  const context = {
    DocumentStatus: {
      DRAFT: 'DRAFT',
      PENDING: 'PENDING',
      COMPLETED: 'COMPLETED',
      REJECTED: 'REJECTED',
      CANCELLED: 'CANCELLED',
    },
    AppErrorCode: {
      ENVELOPE_TSP_LOCKED: 'LOCKED',
      ENVELOPE_COMPLETED: 'COMPLETED',
      ENVELOPE_REJECTED: 'REJECTED',
      ENVELOPE_CANCELLED: 'CANCELLED',
      INVALID_REQUEST: 'INVALID',
    },
    AppError: class extends Error {
      constructor(code, options) {
        super(options.message);
        this.code = code;
      }
    },
    isTspEnvelope: (e) => ['AES', 'QES'].includes(e.signatureLevel),
    match: (value) => {
      let selected;
      const builder = {
        with: (expected, get) => {
          if (expected === value) selected = get();
          return builder;
        },
        otherwise: (get) => selected ?? get(),
      };
      return builder;
    },
  };
  vm.createContext(context);
  vm.runInContext(executable + '\nglobalThis.check=assertEnvelopeMutable;', context);
  return context.check;
}
test('snapshot TSP denial throws synchronously before an unawaited caller can prepare effects', () => {
  const check = fixture();
  for (const signatureLevel of ['AES', 'QES'])
    for (const [status, code] of [
      ['PENDING', 'LOCKED'],
      ['COMPLETED', 'COMPLETED'],
      ['REJECTED', 'REJECTED'],
      ['CANCELLED', 'CANCELLED'],
    ])
      assert.throws(
        () => check({ signatureLevel, status }),
        (e) => e.code === code,
      );
});
test('draft TSP and SES snapshot overload return void without touching a database', () => {
  const check = fixture();
  assert.equal(check({ signatureLevel: 'AES', status: 'DRAFT' }), undefined);
  assert.equal(check({ signatureLevel: 'SES', status: 'PENDING' }), undefined);
});
test('transaction overload still asynchronously rereads current native state and propagates native read failures', async () => {
  const check = fixture();
  let reads = 0;
  const tx = {
    envelope: {
      findFirstOrThrow: async (options) => {
        reads++;
        assert.equal(options.where.id, 'envelope1');
        return { signatureLevel: 'QES', status: 'PENDING' };
      },
    },
  };
  await assert.rejects(check({ id: 'envelope1' }, tx), (e) => e.code === 'LOCKED');
  assert.equal(reads, 1);
  const failure = Error('native read failed');
  await assert.rejects(
    check(
      { id: 'envelope1' },
      {
        envelope: {
          findFirstOrThrow: async () => {
            throw failure;
          },
        },
      },
    ),
    (e) => e === failure,
  );
});
