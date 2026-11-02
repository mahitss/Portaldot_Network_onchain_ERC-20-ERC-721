import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
  return path.join(dir, 'test.json');
}

test('transaction-journal: valid signed deployment transaction', async () => {
  const { parseAndValidateSignedTx } = await import('../lib/transaction-journal.cjs');
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: '0x6080604052', gasLimit: 100000n, chainId: 420420777, nonce: 0, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };
  const signed = await wallet.signTransaction(tx);
  const parsed = parseAndValidateSignedTx(signed, 420420777);
  assert.equal(parsed.from.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(Number(parsed.chainId), 420420777);
});

test('transaction-journal: wrong chain rejected', async () => {
  const { parseAndValidateSignedTx } = await import('../lib/transaction-journal.cjs');
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: '0x6080604052', gasLimit: 100000n, chainId: 1, nonce: 0, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };
  const signed = await wallet.signTransaction(tx);
  assert.throws(() => parseAndValidateSignedTx(signed, 420420777), /chainId/);
});

test('transaction-journal: missing chain ID rejected', async () => {
  const { parseAndValidateSignedTx } = await import('../lib/transaction-journal.cjs');
  // Create a transaction without chainId by using a raw signed tx
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: '0x6080604052', gasLimit: 100000n, nonce: 0, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };
  const signed = await wallet.signTransaction(tx);
  assert.throws(() => parseAndValidateSignedTx(signed, 420420777), /chainId/);
});

test('transaction-journal: persist and read round-trip', async () => {
  const { persistPendingEntry, readPendingJournal } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = {
    schemaVersion: 1,
    operationId: 'test-op-1',
    operation: 'deploy',
    contract: 'PotERC20',
    txHash: '0x' + 'aa'.repeat(32),
    signed: '0x' + 'bb'.repeat(64),
    expectedSender: '0x' + '11'.repeat(20),
    chainId: 420420777,
    nonce: 0,
    expectedTo: null,
    expectedValue: '0',
    expectedData: '0x6080604052',
    params: { artifact: 'PotERC20', gasLimit: '100000', args: [] },
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  };
  persistPendingEntry(file, entry);
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok');
  assert.equal(result.entry.operationId, 'test-op-1');
  assert.equal(result.entry.txHash, entry.txHash);
});

test('transaction-journal: no-overwrite on second persist', async () => {
  const { persistPendingEntry } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry1 = {
    schemaVersion: 1,
    operationId: 'op-1',
    operation: 'deploy',
    contract: 'PotERC20',
    txHash: '0x' + 'aa'.repeat(32),
    signed: '0x' + 'bb'.repeat(64),
    expectedSender: '0x' + '11'.repeat(20),
    chainId: 420420777,
    nonce: 0,
    expectedTo: null,
    expectedValue: '0',
    expectedData: '0x6080604052',
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  };
  persistPendingEntry(file, entry1);
  const entry2 = { ...entry1, operationId: 'op-2', txHash: '0x' + 'cc'.repeat(32) };
  assert.throws(() => persistPendingEntry(file, entry2), /already exists/);
});

test('transaction-journal: clear requires operation ID and txHash', async () => {
  const { persistPendingEntry, clearPendingJournal } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = {
    schemaVersion: 1,
    operationId: 'op-1',
    operation: 'deploy',
    contract: 'PotERC20',
    txHash: '0x' + 'aa'.repeat(32),
    signed: '0x' + 'bb'.repeat(64),
    expectedSender: '0x' + '11'.repeat(20),
    chainId: 420420777,
    nonce: 0,
    expectedTo: null,
    expectedValue: '0',
    expectedData: '0x6080604052',
    params: { artifact: 'PotERC20', gasLimit: '100000', args: [] },
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  };
  persistPendingEntry(file, entry);
  assert.throws(() => clearPendingJournal(file), /requires an operation ID/);
  assert.throws(() => clearPendingJournal(file, 'op-1'), /requires a transaction hash/);
  assert.throws(() => clearPendingJournal(file, 'wrong-op', '0x' + 'aa'.repeat(32)), /operation ID mismatch/);
  assert.throws(() => clearPendingJournal(file, 'op-1', '0x' + 'cc'.repeat(32)), /txHash mismatch/);
  // Correct call succeeds.
  clearPendingJournal(file, 'op-1', '0x' + 'aa'.repeat(32));
  const { readPendingJournal } = await import('../lib/transaction-journal.cjs');
  assert.equal(readPendingJournal(file).status, 'missing');
});

test('transaction-journal: malformed journal rejected', async () => {
  const { readPendingJournal } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const fs = (await import('node:fs')).default;
  fs.writeFileSync(file + '.journal', '{ "operation": "deploy" }');
  const result = readPendingJournal(file);
  assert.equal(result.status, 'malformed');
});

test('transaction-journal: validateDeploymentTransaction rejects wrong signer', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const wallet1 = ethers.Wallet.createRandom();
  const wallet2 = ethers.Wallet.createRandom();
  const tx = { data: '0x6080604052', gasLimit: 100000n, chainId: 420420777, nonce: 0, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet1.signTransaction(tx);
  const journal = { schemaVersion: 1, operationId: 'op-1', txHash: ethers.Transaction.from(signed).hash, expectedSender: wallet1.address, chainId: 420420777, nonce: 0, expectedTo: null, expectedValue: '0', expectedData: '0x6080604052', createdAt: new Date().toISOString(), status: 'pending', operation: 'deploy', params: { artifact: 'PotERC20' } };
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet2.address, '0x6080604052'), /does not match/);
});

test('transaction-journal: validateBindingTransaction rejects wrong registry', async () => {
  const { validateBindingTransaction } = await import('../lib/transaction-journal.cjs');
  const wallet = ethers.Wallet.createRandom();
  const registry = '0x' + '11'.repeat(20);
  const wrongRegistry = '0x' + '22'.repeat(20);
  const calldata = '0x12345678';
  const tx = { to: registry, data: calldata, gasLimit: 100000n, chainId: 420420777, nonce: 0, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = { schemaVersion: 1, operationId: 'op-1', txHash: ethers.Transaction.from(signed).hash, expectedSender: wallet.address, chainId: 420420777, nonce: 0, expectedTo: registry, expectedValue: '0', expectedData: calldata, createdAt: new Date().toISOString(), status: 'pending', operation: 'bind', params: { token: '0x' + '44'.repeat(20), nativeAccountHash: '0x' + 'ff'.repeat(32) } };
  assert.throws(() => validateBindingTransaction(signed, journal, wallet.address, wrongRegistry, calldata), /destination must be|does not match/);
});