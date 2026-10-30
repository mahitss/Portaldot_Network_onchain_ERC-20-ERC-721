import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNativeId } from '../lib/validation.cjs';

test('validateNativeId accepts valid uint32 ids', () => {
  assert.equal(validateNativeId(0), 0);
  assert.equal(validateNativeId(1), 1);
  assert.equal(validateNativeId('1'), 1);
  assert.equal(validateNativeId(4294967295), 4294967295);
  assert.equal(validateNativeId(4294967295n), 4294967295);
  assert.equal(validateNativeId('0007'), 7);
  assert.equal(validateNativeId('4294967295'), 4294967295);
});

test('validateNativeId rejects values outside the uint32 boundary', () => {
  assert.throws(() => validateNativeId(-1), /invalid native ID/);
  assert.throws(() => validateNativeId(-1n), /invalid native ID/);
  assert.throws(() => validateNativeId(4294967296), /invalid native ID/);
  assert.throws(() => validateNativeId(4294967296n), /invalid native ID/);
  assert.throws(() => validateNativeId('4294967296'), /invalid native ID/);
  assert.throws(() => validateNativeId(2 ** 53), /invalid native ID/);
});

test('validateNativeId rejects malformed ids instead of coercing them', () => {
  // '' must not become 0 through Number('')
  assert.throws(() => validateNativeId(''), /invalid native ID/);
  assert.throws(() => validateNativeId('  '), /invalid native ID/);
  assert.throws(() => validateNativeId('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'), /invalid native ID/);
  assert.throws(() => validateNativeId('1e6'), /invalid native ID/);
  assert.throws(() => validateNativeId('1.0'), /invalid native ID/);
  assert.throws(() => validateNativeId(1.5), /invalid native ID/);
  assert.throws(() => validateNativeId('+1'), /invalid native ID/);
  assert.throws(() => validateNativeId('-1'), /invalid native ID/);
  assert.throws(() => validateNativeId('0x10'), /invalid native ID/);
  assert.throws(() => validateNativeId(' 1'), /invalid native ID/);
  assert.throws(() => validateNativeId('1 '), /invalid native ID/);
  assert.throws(() => validateNativeId(null), /invalid native ID/);
  assert.throws(() => validateNativeId(undefined), /invalid native ID/);
  assert.throws(() => validateNativeId(true), /invalid native ID/);
  assert.throws(() => validateNativeId({}), /invalid native ID/);
});

test('validateNativeId keeps the caller-supplied name in the message', () => {
  assert.throws(() => validateNativeId('abc', 'POT_NATIVE_ASSET_ID'), /invalid POT_NATIVE_ASSET_ID/);
  assert.throws(() => validateNativeId('abc', 'POT_NATIVE_NFT_ID'), /invalid POT_NATIVE_NFT_ID/);
});
