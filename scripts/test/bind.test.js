import assert from 'node:assert/strict';
import test from 'node:test';
import { validateNativeId } from '../bind.js';

test('validateNativeId accepts valid IDs', () => {
  assert.equal(validateNativeId(0), 0);
  assert.equal(validateNativeId(1), 1);
  assert.equal(validateNativeId(4294967295), 4294967295);
});

test('validateNativeId rejects invalid IDs', () => {
  assert.throws(() => validateNativeId(-1), /invalid POT_NATIVE_ASSET_ID/);
  assert.throws(() => validateNativeId(4294967296), /invalid POT_NATIVE_ASSET_ID/);
  assert.throws(() => validateNativeId(1.5), /invalid POT_NATIVE_ASSET_ID/);
  assert.throws(() => validateNativeId('abc'), /invalid POT_NATIVE_ASSET_ID/);
  assert.throws(() => validateNativeId(''), /invalid POT_NATIVE_ASSET_ID/);
});
