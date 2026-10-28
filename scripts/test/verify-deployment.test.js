import assert from 'node:assert/strict';
import test from 'node:test';
import { validateChainId, validateReceipt } from '../verify-deployment.js';

test('validateChainId accepts correct chain ID', () => {
  assert.doesNotThrow(() => validateChainId(420420777, 420420777));
});

test('validateChainId rejects wrong chain ID', () => {
  assert.throws(() => validateChainId(1, 420420777), /wrong chain ID/);
  assert.throws(() => validateChainId(0, 420420777), /wrong chain ID/);
});

test('validateReceipt accepts valid receipt', () => {
  const txHash = '0xabc123';
  const receipt = {
    transactionHash: txHash,
    status: 1,
    blockNumber: 12345,
  };
  const result = validateReceipt(txHash, receipt);
  assert.equal(result, receipt);
});

test('validateReceipt rejects null receipt', () => {
  assert.throws(() => validateReceipt('0xabc123', null), /receipt not found/);
});

test('validateReceipt rejects failed receipt', () => {
  assert.throws(() => validateReceipt('0xabc123', { transactionHash: '0xabc123', status: 0 }), /failed/);
});

test('validateReceipt rejects hash mismatch', () => {
  assert.throws(
    () => validateReceipt('0xabc123', { transactionHash: '0xdef456', status: 1 }),
    /transaction hash mismatch/
  );
});
