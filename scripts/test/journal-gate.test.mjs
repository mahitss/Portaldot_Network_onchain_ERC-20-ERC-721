import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
  return path.join(dir, 'test.json');
}

test('journal-gate: no journal → gate open', async () => {
  const { checkJournalGate } = await import('../lib/journal-gate.cjs');
  const { readJsonRecord, writeJsonAtomic } = await import('../lib/persistence.cjs');
  const file = tempFile();
  const result = checkJournalGate(file, { read: readJsonRecord, write: writeJsonAtomic, archive: () => null });
  assert.equal(result.blocked, false);
});

test('journal-gate: malformed journal → blocked', async () => {
  const { checkJournalGate } = await import('../lib/journal-gate.cjs');
  const { readJsonRecord } = await import('../lib/persistence.cjs');
  const file = tempFile();
  fs.writeFileSync(file + '.journal', '{ bad json }');
  const result = checkJournalGate(file, { read: readJsonRecord, write: () => {}, archive: () => null });
  assert.equal(result.blocked, true);
});

test('journal-gate: orphaned journal (no record) blocked', async () => {
  const { checkJournalGate } = await import('../lib/journal-gate.cjs');
  const { readJsonRecord } = await import('../lib/persistence.cjs');
  const file = tempFile();
  const journal = {
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
    params: { artifact: 'PotERC20' },
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  };
  fs.writeFileSync(file + '.journal', JSON.stringify(journal));
  const result = checkJournalGate(file, { read: readJsonRecord, write: () => {}, archive: () => null });
  assert.equal(result.blocked, true);
  assert.ok(result.reason.includes('no deployment record was found'));
});

test('journal-gate: journal with matching pending entry not blocked', async () => {
  const { checkJournalGate } = await import('../lib/journal-gate.cjs');
  const { readJsonRecord } = await import('../lib/persistence.cjs');
  const file = tempFile();
  const txHash = '0x' + 'aa'.repeat(32);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    operation: 'deploy',
    contract: 'PotERC20',
    txHash,
    signed: '0x' + 'bb'.repeat(64),
    expectedSender: '0x' + '11'.repeat(20),
    chainId: 420420777,
    nonce: 0,
    expectedTo: null,
    expectedValue: '0',
    expectedData: '0x6080604052',
    params: { artifact: 'PotERC20' },
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  };
  fs.writeFileSync(file + '.journal', JSON.stringify(journal));
  const record = {
    network: 'portaldotTestnet',
    chainId: 420420777,
    deployer: '0x' + '11'.repeat(20),
    contracts: {
      PotERC20: { txHash, status: 'pending' },
    },
  };
  const recordIo = { read: () => ({ status: 'ok', data: record, error: null }), write: () => {}, archive: () => null };
  const result = checkJournalGate(file, recordIo);
  assert.equal(result.blocked, false);
});
