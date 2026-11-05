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
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet2.address, '0x6080604052', 0), /does not match/);
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
  assert.throws(() => validateBindingTransaction(signed, journal, wallet.address, wrongRegistry, calldata, 0), /destination must be|does not match/);
});

// --- Deployment intent reconstruction tests ---

test('transaction-journal: validateDeploymentTransaction passes with independently reconstructed initcode', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  const encodedArgs = iface.encodeDeploy(['Portaldot Pot Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + encodedArgs.slice(2);
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: expectedInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 5,
    expectedTo: null,
    expectedValue: '0',
    expectedData: expectedInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Portaldot Pot Token', 'POT', deployer] },
  };
  const parsed = validateDeploymentTransaction(signed, journal, wallet.address, expectedInitcode, 5);
  assert.equal(parsed.from.toLowerCase(), wallet.address.toLowerCase());
});

test('transaction-journal: validateDeploymentTransaction rejects mismatched initcode', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  const encodedArgs = iface.encodeDeploy(['Portaldot Pot Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + encodedArgs.slice(2);
  const wallet = ethers.Wallet.createRandom();
  // Signed tx has wrong initcode (different constructor args)
  const wrongEncoded = iface.encodeDeploy(['Tampered Token', 'POT', deployer]);
  const wrongInitcode = artifact.bytecode + wrongEncoded.slice(2);
  const tx = { data: wrongInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 5,
    expectedTo: null,
    expectedValue: '0',
    expectedData: wrongInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Tampered Token', 'POT', deployer] },
  };
  // Pass correct expectedInitcode - signed tx data won't match
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet.address, expectedInitcode, 5), /data/);
});

test('transaction-journal: validateDeploymentTransaction rejects wrong artifact bytecode', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  const encodedArgs = iface.encodeDeploy(['Portaldot Pot Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + encodedArgs.slice(2);
  // Wrong artifact: use PotRegistry bytecode instead
  const registryArtifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), 'utf8'));
  const wrongInitcode = registryArtifact.bytecode + '00';
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: wrongInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 5,
    expectedTo: null,
    expectedValue: '0',
    expectedData: wrongInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Portaldot Pot Token', 'POT', deployer] },
  };
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet.address, expectedInitcode, 5), /data/);
});

test('transaction-journal: validateDeploymentTransaction rejects constructor argument mismatch', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  // Correct expected initcode with different name
  const correctEncoded = iface.encodeDeploy(['Correct Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + correctEncoded.slice(2);
  // Signed tx has different name in initcode
  const wrongEncoded = iface.encodeDeploy(['Wrong Token', 'POT', deployer]);
  const wrongInitcode = artifact.bytecode + wrongEncoded.slice(2);
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: wrongInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 5,
    expectedTo: null,
    expectedValue: '0',
    expectedData: wrongInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Wrong Token', 'POT', deployer] },
  };
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet.address, expectedInitcode, 5), /data/);
});

test('transaction-journal: validateDeploymentTransaction rejects wrong signer', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  const encodedArgs = iface.encodeDeploy(['Portaldot Pot Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + encodedArgs.slice(2);
  const wallet1 = ethers.Wallet.createRandom();
  const wallet2 = ethers.Wallet.createRandom();
  const tx = { data: expectedInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet1.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet1.address,
    chainId: 420420777,
    nonce: 5,
    expectedTo: null,
    expectedValue: '0',
    expectedData: expectedInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Portaldot Pot Token', 'POT', deployer] },
  };
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet2.address, expectedInitcode, 5), /does not match/);
});

test('transaction-journal: validateDeploymentTransaction rejects wrong nonce', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  const encodedArgs = iface.encodeDeploy(['Portaldot Pot Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + encodedArgs.slice(2);
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: expectedInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 5,
    expectedTo: null,
    expectedValue: '0',
    expectedData: expectedInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Portaldot Pot Token', 'POT', deployer] },
  };
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet.address, expectedInitcode, 999), /nonce/);
});

test('transaction-journal: validateDeploymentTransaction rejects missing nonce', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  const encodedArgs = iface.encodeDeploy(['Portaldot Pot Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + encodedArgs.slice(2);
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: expectedInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    expectedTo: null,
    expectedValue: '0',
    expectedData: expectedInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Portaldot Pot Token', 'POT', deployer] },
  };
  // Journal missing nonce field
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet.address, expectedInitcode, undefined), /requires an explicit expected nonce/);
});

// --- Binding intent reconstruction tests ---

test('transaction-journal: validateBindingTransaction passes with independently reconstructed intent', async () => {
  const { validateBindingTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const wallet = ethers.Wallet.createRandom();
  const token = '0x' + '22'.repeat(20);
  const registry = '0x' + '33'.repeat(20);
  const nativeAccountHash = '0x' + 'ff'.repeat(32);
  const calldata = iface.encodeFunctionData('bind', [
    token,
    0, // KIND_ERC20
    1, // NATIVE_ASSETS
    1, // nativeId
    14, // nativeDecimals
    18, // evmDecimals
    nativeAccountHash,
  ]);
  const tx = { to: registry, data: calldata, gasLimit: 1000000n, chainId: 420420777, nonce: 3, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 3,
    expectedTo: registry,
    expectedValue: '0',
    expectedData: calldata,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'bind',
    params: { token, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, nativeAccountHash },
  };
  const parsed = validateBindingTransaction(signed, journal, wallet.address, registry, calldata, 3);
  assert.equal(parsed.from.toLowerCase(), wallet.address.toLowerCase());
  assert.equal(parsed.to.toLowerCase(), registry.toLowerCase());
});

test('transaction-journal: validateBindingTransaction rejects tampered expectedSender', async () => {
  const { validateBindingTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const wallet = ethers.Wallet.createRandom();
  const wrongWallet = ethers.Wallet.createRandom();
  const token = '0x' + '22'.repeat(20);
  const registry = '0x' + '33'.repeat(20);
  const nativeAccountHash = '0x' + 'ff'.repeat(32);
  const calldata = iface.encodeFunctionData('bind', [
    token, 0, 1, 1, 14, 18, nativeAccountHash,
  ]);
  const tx = { to: registry, data: calldata, gasLimit: 1000000n, chainId: 420420777, nonce: 3, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 3,
    expectedTo: registry,
    expectedValue: '0',
    expectedData: calldata,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'bind',
    params: { token, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, nativeAccountHash },
  };
  assert.throws(() => validateBindingTransaction(signed, journal, wrongWallet.address, registry, calldata, 3), /does not match/);
});

test('transaction-journal: validateBindingTransaction rejects tampered expectedTo (registry)', async () => {
  const { validateBindingTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const wallet = ethers.Wallet.createRandom();
  const token = '0x' + '22'.repeat(20);
  const registry = '0x' + '33'.repeat(20);
  const wrongRegistry = '0x' + '44'.repeat(20);
  const nativeAccountHash = '0x' + 'ff'.repeat(32);
  const calldata = iface.encodeFunctionData('bind', [
    token, 0, 1, 1, 14, 18, nativeAccountHash,
  ]);
  const tx = { to: registry, data: calldata, gasLimit: 1000000n, chainId: 420420777, nonce: 3, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 3,
    expectedTo: registry,
    expectedValue: '0',
    expectedData: calldata,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'bind',
    params: { token, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, nativeAccountHash },
  };
  assert.throws(() => validateBindingTransaction(signed, journal, wallet.address, wrongRegistry, calldata, 3), /does not match/);
});

test('transaction-journal: validateBindingTransaction rejects tampered expectedData (calldata)', async () => {
  const { validateBindingTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const wallet = ethers.Wallet.createRandom();
  const token = '0x' + '22'.repeat(20);
  const registry = '0x' + '33'.repeat(20);
  const nativeAccountHash = '0x' + 'ff'.repeat(32);
  const calldata = iface.encodeFunctionData('bind', [
    token, 0, 1, 1, 14, 18, nativeAccountHash,
  ]);
  const wrongCalldata = '0x' + 'aa'.repeat(40);
  const tx = { to: registry, data: wrongCalldata, gasLimit: 1000000n, chainId: 420420777, nonce: 3, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 3,
    expectedTo: registry,
    expectedValue: '0',
    expectedData: calldata,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'bind',
    params: { token, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, nativeAccountHash },
  };
  assert.throws(() => validateBindingTransaction(signed, journal, wallet.address, registry, calldata, 3), /data/);
});

test('transaction-journal: validateBindingTransaction rejects wrong nonce', async () => {
  const { validateBindingTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const wallet = ethers.Wallet.createRandom();
  const token = '0x' + '22'.repeat(20);
  const registry = '0x' + '33'.repeat(20);
  const nativeAccountHash = '0x' + 'ff'.repeat(32);
  const calldata = iface.encodeFunctionData('bind', [
    token, 0, 1, 1, 14, 18, nativeAccountHash,
  ]);
  const tx = { to: registry, data: calldata, gasLimit: 1000000n, chainId: 420420777, nonce: 3, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 3,
    expectedTo: registry,
    expectedValue: '0',
    expectedData: calldata,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'bind',
    params: { token, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, nativeAccountHash },
  };
  assert.throws(() => validateBindingTransaction(signed, journal, wallet.address, registry, calldata, 999), /nonce/);
});

test('transaction-journal: validateBindingTransaction rejects missing nonce', async () => {
  const { validateBindingTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const wallet = ethers.Wallet.createRandom();
  const token = '0x' + '22'.repeat(20);
  const registry = '0x' + '33'.repeat(20);
  const nativeAccountHash = '0x' + 'ff'.repeat(32);
  const calldata = iface.encodeFunctionData('bind', [
    token, 0, 1, 1, 14, 18, nativeAccountHash,
  ]);
  const tx = { to: registry, data: calldata, gasLimit: 1000000n, chainId: 420420777, nonce: 3, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    expectedTo: registry,
    expectedValue: '0',
    expectedData: calldata,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'bind',
    params: { token, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, nativeAccountHash },
  };
  // Journal missing nonce field
  assert.throws(() => validateBindingTransaction(signed, journal, wallet.address, registry, calldata, undefined), /requires an explicit expected nonce/);
});

test('transaction-journal: validateDeploymentTransaction rejects malformed nonce', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  const encodedArgs = iface.encodeDeploy(['Portaldot Pot Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + encodedArgs.slice(2);
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: expectedInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 5,
    expectedTo: null,
    expectedValue: '0',
    expectedData: expectedInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Portaldot Pot Token', 'POT', deployer] },
  };
  // Malformed nonce (fractional)
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet.address, expectedInitcode, 3.5), /nonce/);
});

test('transaction-journal: validateDeploymentTransaction rejects negative nonce', async () => {
  const { validateDeploymentTransaction } = await import('../lib/transaction-journal.cjs');
  const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), 'utf8'));
  const iface = new (await import('ethers')).Interface(artifact.abi);
  const deployer = '0x' + '11'.repeat(20);
  const encodedArgs = iface.encodeDeploy(['Portaldot Pot Token', 'POT', deployer]);
  const expectedInitcode = artifact.bytecode + encodedArgs.slice(2);
  const wallet = ethers.Wallet.createRandom();
  const tx = { data: expectedInitcode, gasLimit: 1000000n, chainId: 420420777, nonce: 5, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n, to: null, value: 0 };
  const signed = await wallet.signTransaction(tx);
  const journal = {
    schemaVersion: 1,
    operationId: 'op-1',
    txHash: ethers.Transaction.from(signed).hash,
    expectedSender: wallet.address,
    chainId: 420420777,
    nonce: 5,
    expectedTo: null,
    expectedValue: '0',
    expectedData: expectedInitcode,
    createdAt: new Date().toISOString(),
    status: 'pending',
    operation: 'deploy',
    params: { artifact: 'PotERC20', gasLimit: '1000000', args: ['Portaldot Pot Token', 'POT', deployer] },
  };
  // Negative nonce
  assert.throws(() => validateDeploymentTransaction(signed, journal, wallet.address, expectedInitcode, -1), /nonce/);
});

// --- Persistence / descriptor lifecycle tests ---

test('transaction-journal: successful publication writes exactly once, fsyncs, closes, and links atomically', async () => {
  const { persistPendingEntry, readPendingJournal } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = {
    schemaVersion: 1,
    operationId: 'op-success-1',
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
  const journalPath = persistPendingEntry(file, entry);
  assert.ok(fs.existsSync(journalPath), 'journal must exist after publication');
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok');
  assert.equal(result.entry.operationId, 'op-success-1');
  // No temp file must be left behind.
  const dir = path.dirname(file);
  const tmpFiles = fs.readdirSync(dir).filter((f) => f.includes('.tmp-') || f.includes('.fail-'));
  assert.deepEqual(tmpFiles, [], 'temporary files must be cleaned up after successful publication');
});

test('transaction-journal: write failure throws, closes descriptor, removes temp file, leaves no journal', async () => {
  const { persistPendingEntry } = await import('../lib/transaction-journal.cjs');
  // Place the target directory under an existing file: mkdirSync cannot create a
  // directory inside a file (ENOTDIR), forcing the write path to fail after the
  // temp file has been opened. Works on both POSIX and Windows.
  const blocker = path.join(os.tmpdir(), 'journal-blocker-' + process.pid);
  fs.writeFileSync(blocker, 'x');
  const readOnlyFile = path.join(blocker, 'deployments', 'test.json');
  const entry = {
    schemaVersion: 1,
    operationId: 'op-write-fail',
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
  let threw = false;
  try {
    persistPendingEntry(readOnlyFile, entry);
  } catch (error) {
    threw = true;
    assert.ok(error.message.includes('cannot write journal') || error.message.includes('ENOTDIR'),
      'expected a publication/write error, got: ' + error.message);
  }
  assert.ok(threw, 'expected persistPendingEntry to throw on write failure');
  assert.equal(fs.existsSync(readOnlyFile + '.journal'), false, 'no journal may be published on write failure');
  fs.rmSync(blocker, { recursive: true, force: true });
});

test('transaction-journal: existing journal is never overwritten by a second persist', async () => {
  const { persistPendingEntry, readPendingJournal } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry1 = {
    schemaVersion: 1,
    operationId: 'op-exists-1',
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
  persistPendingEntry(file, entry1);
  const entry2 = { ...entry1, operationId: 'op-exists-2', txHash: '0x' + 'cc'.repeat(32) };
  assert.throws(() => persistPendingEntry(file, entry2), /already exists/);
  // Original journal must be untouched.
  const result = readPendingJournal(file);
  assert.equal(result.entry.txHash, '0x' + 'aa'.repeat(32));
  assert.equal(result.entry.operationId, 'op-exists-1');
});

// --- Terminal failure schema tests ---

test('transaction-journal: terminal failure round trip canonicalizes statuses 0, "0", false and 0n', async () => {
  const { persistTerminalFailure, readPendingJournal, persistPendingEntry } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = {
    schemaVersion: 1,
    operationId: 'op-term-1',
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
  for (const status of [0, '0', false]) {
    persistTerminalFailure(file, { receipt: { transactionHash: entry.txHash, status, blockNumber: 5 }, failure: {} });
    const result = readPendingJournal(file);
    assert.equal(result.status, 'terminal_failure', `status ${String(status)} must normalize to terminal_failure`);
    assert.equal(result.entry.receipt.status, 0, 'canonicalized status must be number 0');
  }
});

test('transaction-journal: repeated terminal failure handling is idempotent', async () => {
  const { persistTerminalFailure, readPendingJournal, persistPendingEntry } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = {
    schemaVersion: 1,
    operationId: 'op-term-idem',
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
  persistTerminalFailure(file, { receipt: { transactionHash: entry.txHash, status: 0, blockNumber: 5 } });
  const first = readPendingJournal(file);
  assert.equal(first.status, 'terminal_failure');
  // Second call must return without erroring and keep the same journal.
  persistTerminalFailure(file, { receipt: { transactionHash: entry.txHash, status: 0, blockNumber: 9 } });
  const second = readPendingJournal(file);
  assert.equal(second.status, 'terminal_failure');
  assert.equal(second.entry.failedAt, first.entry.failedAt);
});

test('transaction-journal: invalid receipt hash does not overwrite a valid pending journal', async () => {
  const { persistPendingEntry, persistTerminalFailure, readPendingJournal } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = {
    schemaVersion: 1,
    operationId: 'op-term-bad-hash',
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
  assert.throws(() => persistTerminalFailure(file, {
    receipt: { transactionHash: '0x' + 'ff'.repeat(32), status: 0, blockNumber: 5 },
  }), /does not match the journal hash/);
  // Pending journal must remain intact.
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok');
});

test('transaction-journal: missing block number in terminal receipt is rejected', async () => {
  const { persistPendingEntry, persistTerminalFailure, readPendingJournal } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = {
    schemaVersion: 1,
    operationId: 'op-term-no-block',
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
  assert.throws(() => persistTerminalFailure(file, {
    receipt: { transactionHash: entry.txHash, status: 0 },
  }), /invalid block number/);
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok');
});

test('transaction-journal: invalid status values are not terminal evidence', async () => {
  const { persistPendingEntry, persistTerminalFailure, readPendingJournal } = await import('../lib/transaction-journal.cjs');
  const file = tempFile();
  const entry = {
    schemaVersion: 1,
    operationId: 'op-term-bad-status',
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
  for (const bad of [1, '1', true, undefined, null]) {
    assert.throws(() => persistTerminalFailure(file, {
      receipt: { transactionHash: entry.txHash, status: bad, blockNumber: 5 },
    }), /definite failure|not a definite failure/);
  }
  const result = readPendingJournal(file);
  assert.equal(result.status, 'ok');
});

// --- Directory synchronization tests ---

test('transaction-journal: directory fsync reports unsupported without swallowing real errors', async () => {
  const { fsyncDirectory } = await import('../lib/transaction-journal.cjs');
  const dir = path.dirname(tempFile());
  fs.mkdirSync(dir, { recursive: true });
  const result = fsyncDirectory(dir);
  assert.ok(result.status === 'synced' || result.status === 'unsupported',
    `expected synced or unsupported, got ${JSON.stringify(result)}`);
  if (process.platform === 'win32') {
    // On Windows directory fsync is not supported; report explicitly.
    assert.equal(result.status, 'unsupported', 'Windows must report directory fsync as unsupported');
  }
});

test('transaction-journal: fsyncDirectory propagates a missing directory as a real failure', async () => {
  const { fsyncDirectory } = await import('../lib/transaction-journal.cjs');
  const missing = path.join(os.tmpdir(), 'no-such-directory-' + process.pid);
  try {
    await fsyncDirectory(missing);
    assert.fail('expected fsyncDirectory on a missing directory to throw');
  } catch (error) {
    assert.ok(error.message.includes('cannot open directory for synchronization'));
  }
});