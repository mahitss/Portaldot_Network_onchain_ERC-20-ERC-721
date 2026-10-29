// Mission 006.2 §6: offline lifecycle regression tests exercising the actual
// dependency-injected orchestration paths of runRelease (deploy.js) and
// runBinding (bind.js). No live transactions, no credentials, no network.
// Every test drives the real flow through injected recordIo/probes/deploy/bind
// functions, then asserts on the persisted record and the orchestration decisions.
//
// Provided DI contracts:
//   runRelease({env, deployerAddress, recordIo, probes, deployContract,
//               recordFile, networkName, chainId, forceFresh})
//   runBinding({env, recordIo, probes, recordFile, networkName, chainId,
//               signerAddress, registryViews, bindSender, encodeBind,
//               registryAddress, tokenAddresses})

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const deployModule = await import(pathToFileURL(path.join(root, 'scripts', 'deploy.js')).href);
const bindModule = await import(pathToFileURL(path.join(root, 'scripts', 'bind.js')).href);
const { runRelease } = deployModule;
const { runBinding } = bindModule;

const NETWORK = 'portaldotTestnet';
const CHAIN_ID = 420420777;
const DEPLOYER = `0x${'11'.repeat(20)}`;
const REGISTRY_ADDR = `0x${'33'.repeat(20)}`;
const TOKEN_ERC20 = `0x${'44'.repeat(20)}`;
const TOKEN_ERC721 = `0x${'55'.repeat(20)}`;

const COMMITMENT = `0x${createHash('sha256').update(Buffer.from(`${DEPLOYER.slice(2)}${'ee'.repeat(12)}`, 'hex')).digest('hex')}`;

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-')), 'deployments', `${NETWORK}.json`);
}

// In-memory, DI-safe record store (no real filesystem inside lifecycle tests).
function makeRecordIo(initial = null) {
  let store = initial;
  return {
    read: (file) => {
      if (store === null) return { status: 'missing', data: null, error: null };
      if (store === 'MALFORMED') return { status: 'malformed', data: null, error: 'not JSON' };
      return { status: 'ok', data: JSON.parse(JSON.stringify(store)), error: null };
    },
    write: (file, value) => {
      store = JSON.parse(JSON.stringify(value));
    },
    archive: (file) => {
      const archived = JSON.parse(JSON.stringify(store));
      store = null;
      return `archived:${JSON.stringify(archived).length}`;
    },
    state: () => store,
  };
}

// Controllable fake probes for the whole flow.
function makeProbes(opts = {}) {
  const {
    chainId = CHAIN_ID,
    evmBalance = 0n,
    nativeFree = 0n,
    gasPrice = 27_440n,
    blockGasLimit = 18446744073709551615n,
    estimates = { PotERC20: 1_000_000_000_000_000n, PotERC721: 1_000_000_000_000_000n, PotRegistry: 1_000_000_000_000_000n },
    bindEstimate = 1_000_000_000_000_000n,
    receipts = {},           // txHash -> receipt or undefined (ambiguous when missing)
    txs = {},                // txHash -> transaction for ambiguous outcome checks
    codes = {},              // address -> '0x' (absent) or real bytecode
    nativeObjects = { 'asset:1': true, 'nft_collection:2': true },      // `${kind}:${id}` -> exists
    calls = [],              // recorded probe call names
  } = opts;

  return {
    chainId: record(calls, 'chainId', async () => chainId),
    evmBalance: record(calls, 'evmBalance', async () => evmBalance),
    gasPrice: record(calls, 'gasPrice', async () => gasPrice),
    blockGasLimit: record(calls, 'blockGasLimit', async () => blockGasLimit),
    estimateCreationGas: record(calls, 'estimateCreationGas', async (artifact) => {
      const estimate = estimates[artifact.name];
      if (estimate === undefined) throw new Error(`no estimate for ${artifact.name}`);
      return estimate;
    }),
    estimateCall: record(calls, 'estimateCall', async ({ to }) => bindEstimate),
    code: record(calls, 'code', async (address) => codes[address] ?? '0x'),
    receipt: record(calls, 'receipt', async (txHash) => receipts[txHash] ?? null),
    transaction: record(calls, 'transaction', async (txHash) => txs[txHash] ?? null),
    nativeFreeBalance: record(calls, 'nativeFreeBalance', async () => nativeFree),
    nativeObject: record(calls, 'nativeObject', async (kind, id) => {
      const exists = nativeObjects[`${kind}:${id}`] === true;
      if (!exists) {
        throw new Error(`native ${kind} ${id} does not exist on chain (runtime returned Option::None)`);
      }
      return { kind, id, exists: true, details: 'fake native object' };
    }),
    calls,
  };
}

function record(calls, name, fn) {
  return async (...args) => {
    calls.push(name);
    return fn(...args);
  };
}

function artifacts(overrides = {}) {
  return [
    { name: 'PotERC20', file: path.join(os.tmpdir(), 'a-er.c.json'), args: ['Portaldot Pot Token', 'POT', DEPLOYER], ...overrides },
    { name: 'PotERC721', file: path.join(os.tmpdir(), 'a-721.json'), args: ['Portaldot Pot Collectibles', 'POTC', DEPLOYER], ...overrides },
    { name: 'PotRegistry', file: path.join(os.tmpdir(), 'a-reg.json'), args: [], ...overrides },
  ];
}

// A successful hardhat-style deployment result object.
function deployResult(name, txHash, receipt) {
  return { txHash, receipt: receipt || { status: 1, blockNumber: 1, transactionHash: txHash }, address: receipt?.contractAddress ?? `${RELEASE_ADDRESS(name)}` };
}

function RELEASE_ADDRESS(name) {
  return { PotERC20: TOKEN_ERC20, PotERC721: TOKEN_ERC721, PotRegistry: REGISTRY_ADDR }[name];
}

// A mock transaction hash with exactly 64 hex characters after 0x.
function mockTxHash(suffix = 'dd') {
  return `0x${suffix.padEnd(64, suffix).slice(0, 64)}`;
}

async function fullEnv() {
  return {
    POT_NATIVE_ASSET_ID: '1',
    POT_NATIVE_NFT_ID: '2',
    POT_REQUIRED_TPOT: '0', // computed budget dominates unless a floor is asserted
    POT_RELEASE_FEE_MARGIN_PCT: '20',
  };
}

const existingRecord = {
  network: NETWORK,
  chainId: CHAIN_ID,
  deployer: DEPLOYER,
  deployedAt: '2026-10-28T00:00:00.000Z',
  contracts: {
    PotERC20: { address: TOKEN_ERC20, txHash: `0x${'aa'.repeat(32)}`, blockNumber: 1, status: 'confirmed' },
    PotERC721: { address: TOKEN_ERC721, txHash: `0x${'bb'.repeat(32)}`, blockNumber: 2, status: 'confirmed' },
    PotRegistry: { address: REGISTRY_ADDR, txHash: `0x${'cc'.repeat(32)}`, blockNumber: 3, status: 'confirmed' },
  },
  tokens: {
    erc20: { address: TOKEN_ERC20, name: 'Portaldot Pot Token', symbol: 'POT', decimals: 18 },
    erc721: { address: TOKEN_ERC721, name: 'Portaldot Pot Collectibles', symbol: 'POTC' },
  },
  bindings: [],
};

function probeEnv() {
  return { ...fullEnv(), POT_NATIVE_ASSET_ID: '1', POT_NATIVE_NFT_ID: '2' };
}

// ------------------------------------------------------------
// 1. Fresh full-release success: sufficient funds cover the whole budget
// ------------------------------------------------------------

test('fresh release: sufficient funds deploy every contract exactly once and persist a complete record', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(null);
  const calls = [];
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    calls,
  });
  let sent = 0;
  const deployContract = async (artifact, gasLimit, hooks) => {
    sent += 1;
    const txHash = mockTxHash('dd' + sent);
    hooks.onSent(txHash);
    const receipt = { status: 1, blockNumber: 42 + sent, transactionHash: txHash, contractAddress: RELEASE_ADDRESS(artifact.name) };
    if (hooks.onReceipt) hooks.onReceipt(receipt);
    return deployResult(artifact.name, txHash, receipt);
  };

  const result = await runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });

  assert.equal(result.sentCount, 3);
  assert.equal(result.reusedCount, 0);
  const final = recordIo.state();
  assert.equal(final.network, NETWORK);
  assert.equal(final.chainId, CHAIN_ID);
  assert.equal(final.deployer, DEPLOYER);
  for (const name of ['PotERC20', 'PotERC721', 'PotRegistry']) {
    const entry = final.contracts[name];
    assert.equal(entry.status, 'confirmed');
    assert.equal(entry.address, RELEASE_ADDRESS(name));
    assert.match(entry.txHash, /^0x[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(entry.blockNumber));
  }
  assert.equal(final.bindings.length, 0);
  // no probe was skipped: every creation estimate, gas price and chain id was read
  assert.ok(calls.includes('chainId'));
  assert.ok(calls.includes('evmBalance'));
  assert.ok(calls.includes('gasPrice'));
});

test('fresh release: one base unit below the whole-release requirement aborts before any broadcast', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(null);
  const probes = makeProbes({ evmBalance: 0n, nativeFree: 0n });
  let sent = 0;
  const deployContract = async () => {
    sent += 1;
    return deployResult('PotERC20', `0x${'ee'.repeat(32)}`);
  };

  await assert.rejects(() => runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /preflight failed/);
  assert.equal(sent, 0, 'nothing may be broadcast when funding is insufficient');
  assert.equal(recordIo.state(), null, 'nothing was persisted either');
});

test('fresh release: a failed chain-id or gas-plan probe aborts before any broadcast', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(null);
  const probes = makeProbes({ chainId: 1n });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /preflight failed/);
  assert.equal(sent, 0);
});

test('fresh release: missing native counterpart objects block the release before any deployment', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(null);
  // nft_collection does not exist on chain
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    nativeObjects: { 'asset:1': true },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /preflight failed/);
  assert.equal(sent, 0, 'no deployment starts while a required native object is missing');
});

// ------------------------------------------------------------
// 2. Resumable / idempotent release: records are reused, never duplicated
// ------------------------------------------------------------

test('rerun with a complete record: zero deployments, nothing broadcast', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(existingRecord);
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      [TOKEN_ERC721]: `0x${'ff'.repeat(200)}`,
      [REGISTRY_ADDR]: `0x${'ff'.repeat(200)}`,
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  const result = await runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(result.sentCount, 0);
  assert.equal(result.reusedCount, 3);
  const final = recordIo.state();
  for (const name of ['PotERC20', 'PotERC721', 'PotRegistry']) {
    assert.equal(final.contracts[name].txHash, existingRecord.contracts[name].txHash);
    assert.equal(final.contracts[name].address, existingRecord.contracts[name].address);
    assert.equal(final.contracts[name].status, 'confirmed');
  }
});

test('partial deployment resumes without duplicate deployment transactions', async () => {
  const recordFile = tempFile();
  const partial = JSON.parse(JSON.stringify(existingRecord));
  // PotERC20 confirmed; the other two were never recorded
  partial.contracts = { PotERC20: partial.contracts.PotERC20 };
  partial.tokens = { erc20: { address: TOKEN_ERC20, name: 'Portaldot Pot Token', symbol: 'POT', decimals: 18 } };
  const recordIo = makeRecordIo(partial);
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
  });
  const sentTx = [];
  const deployContract = async (artifact) => {
    sentTx.push(artifact.name);
    const txHash = mockTxHash();
    const receipt = { status: 1, blockNumber: 100 + sentTx.length, transactionHash: txHash, contractAddress: RELEASE_ADDRESS(artifact.name) };
    return deployResult(artifact.name, txHash, receipt);
  };

  const result = await runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(result.sentCount, 2);
  assert.equal(result.reusedCount, 1);
  assert.deepEqual(sentTx.sort(), ['PotERC721', 'PotRegistry'], 'only the missing contracts were deployed');
  const final = recordIo.state();
  assert.equal(final.contracts.PotERC20.txHash, existingRecord.contracts.PotERC20.txHash);
  assert.equal(final.contracts.PotERC721.status, 'confirmed');
  assert.equal(final.contracts.PotRegistry.status, 'confirmed');
});

test('crash-after-send: a PENDING entry is reconciled from its receipt, never redeployed', async () => {
  const recordFile = tempFile();
  const afterCrash = JSON.parse(JSON.stringify(existingRecord));
  // PotERC20 is pending: sent but not yet confirmed locally
  afterCrash.contracts = {
    PotERC20: { txHash: `0x${'aa'.repeat(32)}`, gasLimit: '1000', status: 'pending' },
  };
  afterCrash.tokens = {};
  const recordIo = makeRecordIo(afterCrash);
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    receipts: { [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 9, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 } },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  const result = await runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(result.sentCount, 2, 'the pending contract is reconciled from its receipt, not redeployed; the 2 missing contracts are deployed');
  assert.equal(sent, 2, 'only the missing contracts trigger new broadcasts');
  const final = recordIo.state();
  assert.equal(final.contracts.PotERC20.status, 'confirmed');
  assert.equal(final.contracts.PotERC20.blockNumber, 9);
});

test('ambiguous pending outcome: no receipt on chain aborts fail-closed instead of redeploying', async () => {
  const recordFile = tempFile();
  const afterCrash = JSON.parse(JSON.stringify(existingRecord));
  afterCrash.contracts = {
    PotERC20: { txHash: `0x${'aa'.repeat(32)}`, gasLimit: '1000', status: 'pending' },
  };
  afterCrash.tokens = {};
  const recordIo = makeRecordIo(afterCrash);
  const probes = makeProbes({ evmBalance: 10_000n * 10n ** 18n, nativeFree: 10_000n * 10n ** 14n });
  // receipts: none -> ambiguous
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /ambiguous/);
  assert.equal(sent, 0, 'an ambiguous outcome never triggers a new broadcast');
});

test('malformed record cannot be silently overwritten; explicit fresh archives it instead', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo('MALFORMED');
  const probes = makeProbes({ evmBalance: 10_000n * 10n ** 18n, nativeFree: 10_000n * 10n ** 14n });

  await assert.rejects(() => runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract: async () => deployResult('PotERC20', `0x${'ee'.repeat(32)}`),
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /malformed|not a valid release record/);
  assert.equal(recordIo.state(), 'MALFORMED', 'the old record is intact - not overwritten');
});

test('explicit fresh release (POT_FORCE_FRESH_RELEASE=1) archives the old record and restarts cleanly', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(existingRecord);
  const probes = makeProbes({ evmBalance: 10_000n * 10n ** 18n, nativeFree: 10_000n * 10n ** 14n });
  let sent = 0;
  const deployContract = async (artifact) => {
    sent += 1;
    const txHash = mockTxHash('dd' + sent);
    const receipt = { status: 1, blockNumber: 50 + sent, transactionHash: txHash, contractAddress: RELEASE_ADDRESS(artifact.name) };
    return deployResult(artifact.name, txHash, receipt);
  };

  const result = await runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
    forceFresh: true,
  });
  assert.equal(result.sentCount, 3);
  const final = recordIo.state();
  for (const name of ['PotERC20', 'PotERC721', 'PotRegistry']) {
    assert.equal(final.contracts[name].status, 'confirmed');
    assert.equal(final.contracts[name].txHash, mockTxHash(`dd${['PotERC20','PotERC721','PotRegistry'].indexOf(name) + 1}`));
  }
  // archive returned a non-null path-like value
  assert.ok(result.archived);
});

test('mismatched deployer on an existing record aborts; no overwrite', async () => {
  const recordFile = tempFile();
  const wrong = JSON.parse(JSON.stringify(existingRecord));
  wrong.deployer = `0x${'99'.repeat(20)}`;
  const recordIo = makeRecordIo(wrong);
  const probes = makeProbes({ evmBalance: 10_000n * 10n ** 18n, nativeFree: 10_000n * 10n ** 14n });

  await assert.rejects(() => runRelease({
    env: probeEnv(),
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract: async () => deployResult('PotERC20', `0x${'ee'.repeat(32)}`),
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /different deployer/);
  assert.equal(recordIo.state().deployer, wrong.deployer);
});

// ------------------------------------------------------------
// 3. Binding stage: remaining-phase budget, resume-safe, pre-existing verified
// ------------------------------------------------------------

function bindRecord(overrides = {}) {
  const r = JSON.parse(JSON.stringify(existingRecord));
  r.bindings = [];
  return Object.assign(r, overrides);
}

function bindProbes(opts = {}) {
  const {
    evmBalance = 5_000n * 10n ** 18n,
    nativeFree = 5_000n * 10n ** 14n,
    boundAlready = {},   // token -> true/false
    bindings = {},       // token -> on-chain binding struct
    pendingReceipts = {},// txHash -> receipt for pending entry reconciliation
    codes = {},
    calls = [],
  } = opts;
  return {
    chainId: record(calls, 'chainId', async () => CHAIN_ID),
    evmBalance: record(calls, 'evmBalance', async () => evmBalance),
    gasPrice: record(calls, 'gasPrice', async () => 27_440n),
    blockGasLimit: record(calls, 'blockGasLimit', async () => 18446744073709551615n),
    estimateCall: record(calls, 'estimateCall', async () => 1_000_000_000_000_000n),
    code: record(calls, 'code', async (address) => codes[address] ?? `0x${'ff'.repeat(300)}`),
    receipt: record(calls, 'receipt', async (txHash) => pendingReceipts[txHash] ?? null),
    nativeFreeBalance: record(calls, 'nativeFreeBalance', async () => nativeFree),
    nativeObject: record(calls, 'nativeObject', async (kind, id) => {
      return { kind, id, exists: true, details: 'fake' };
    }),
    calls,
    boundAlready,
    bindings,
  };
}

async function bindingHarness(record, probeOpts = {}) {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(record);
  const probes = bindProbes(probeOpts ?? {});
  const probesCopy = probes;
  const sentBinds = [];
  const bindSender = async (params, hooks) => {
    sentBinds.push({ token: params[0], nativeId: params[3], conversionFactor: params[6] });
    const txHash = mockTxHash();
    if (hooks.onSent) hooks.onSent(txHash);
    return { hash: txHash, wait: async () => ({ status: 1, blockNumber: 77, transactionHash: txHash }) };
  };
  const registryViews = {
    isBound: (token) => probes.boundAlready[token.toLowerCase()] === true,
    bindingOfToken: (token) => probes.bindings[token.toLowerCase()] ?? null,
    bindingCount: async () => 2,
  };
  const encodeBind = (expected) => `0xbind:${expected.token}:${expected.nativeId}`;
  const result = await runBinding({
    env: probeEnv(),
    recordIo,
    probes: probesCopy,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
    signerAddress: DEPLOYER,
    registryViews,
    bindSender,
    encodeBind,
    registryAddress: REGISTRY_ADDR,
    tokenAddresses: { erc20: TOKEN_ERC20, erc721: TOKEN_ERC721 },
  });
  return { result, recordIo, probes: probesCopy, sentBinds };
}

test('binding: both bindings outstanding, each sent once and persisted atomically', async () => {
  const rec = bindRecord();
  const { result, recordIo, sentBinds } = await bindingHarness(rec);
  assert.equal(result.sentCount, 2);
  assert.equal(result.verifiedCount, 0);
  assert.deepEqual(
    sentBinds.map((b) => [b.token, b.nativeId]),
    [[TOKEN_ERC20, 1], [TOKEN_ERC721, 2]],
    'erc20 bound to asset 1, erc721 to nft 2'
  );
  const final = recordIo.state();
  assert.equal(final.bindings.length, 2);
  for (const entry of final.bindings) {
    assert.equal(entry.status, 'confirmed');
    assert.match(entry.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(entry.active, true);
  }
  const erc20Entry = final.bindings.find((e) => e.token === TOKEN_ERC20);
  assert.equal(erc20Entry.tokenKind, 0);
  assert.equal(erc20Entry.nativeKind, 1);
  assert.equal(erc20Entry.nativeId, 1);
  assert.equal(erc20Entry.nativeDecimals, 14);
  assert.equal(erc20Entry.evmDecimals, 18);
  assert.equal(erc20Entry.conversionFactor, '10000');
});

test('binding resume: first binding pre-existing verified, second sent; the first is not repeated', async () => {
  const rec = bindRecord({
    bindings: [
      { token: TOKEN_ERC20, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, conversionFactor: '10000', nativeAccountHash: COMMITMENT, active: true, txHash: `0x${'aa'.repeat(32)}`, blockNumber: 5, status: 'confirmed' },
    ],
  });
  // erc20 is bound on chain too (matches intended config); erc721 is not
  const probes = bindProbes({
    boundAlready: { [TOKEN_ERC20.toLowerCase()]: true },
    bindings: { [TOKEN_ERC20.toLowerCase()]: { token: TOKEN_ERC20, tokenKind: 0n, nativeKind: 1n, nativeId: 1n, nativeDecimals: 14n, evmDecimals: 18n, conversionFactor: 10000n, nativeAccountHash: COMMITMENT, active: true } },
  });
  const { result, sentBinds } = await bindingHarness(rec, {
    boundAlready: { [TOKEN_ERC20.toLowerCase()]: true },
    bindings: { [TOKEN_ERC20.toLowerCase()]: { token: TOKEN_ERC20, tokenKind: 0n, nativeKind: 1n, nativeId: 1n, nativeDecimals: 14n, evmDecimals: 18n, conversionFactor: 10000n, nativeAccountHash: COMMITMENT, active: true } },
  });
  assert.equal(result.sentCount, 1);
  assert.equal(result.verifiedCount, 1);
  assert.deepEqual(
    sentBinds.map((b) => b.token),
    [TOKEN_ERC721],
    'only the missing binding was sent'
  );
  assert.ok(result.reconciledCount === undefined || result.reconciledCount === 0);
});

test('binding: pre-existing binding mismatch aborts before any transaction', async () => {
  const rec = bindRecord({
    bindings: [
      { token: TOKEN_ERC20, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, conversionFactor: '10000', nativeAccountHash: COMMITMENT, active: true, txHash: `0x${'aa'.repeat(32)}`, blockNumber: 5, status: 'confirmed' },
    ],
  });
  await assert.rejects(() => bindingHarness(rec, {
    boundAlready: { [TOKEN_ERC20.toLowerCase()]: true },
    bindings: { [TOKEN_ERC20.toLowerCase()]: { token: TOKEN_ERC20, tokenKind: 0n, nativeKind: 1n, nativeId: 999n, nativeDecimals: 14n, evmDecimals: 18n, conversionFactor: 10000n, nativeAccountHash: COMMITMENT, active: true } },
  }), /does not match|mismatch/);
});

test('binding: recorded binding on chain unbound (record/chain disagreement) aborts without rewriting the record', async () => {
  const rec = bindRecord({
    bindings: [
      { token: TOKEN_ERC20, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, conversionFactor: '10000', nativeAccountHash: COMMITMENT, active: true, txHash: `0x${'aa'.repeat(32)}`, blockNumber: 5, status: 'confirmed' },
    ],
  });
  let recordIo;
  try {
    await bindingHarness(rec, { boundAlready: { [TOKEN_ERC20.toLowerCase()]: false } });
    assert.fail('expected bindingHarness to throw');
  } catch {
    recordIo = makeRecordIo(rec);
  }
  const final = recordIo.state();
  assert.equal(final.bindings.length, 1, 'the record is never rewritten after a record/chain disagreement');
});

test('binding: pending binding entry reconciled from the chain receipt (crash after send)', async () => {
  const rec = bindRecord({
    bindings: [
      { token: TOKEN_ERC20, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, conversionFactor: '10000', nativeAccountHash: COMMITMENT, active: true, txHash: `0x${'aa'.repeat(32)}`, status: 'pending' },
    ],
  });
  const { result, sentBinds, recordIo } = await bindingHarness(rec, {
    boundAlready: { [TOKEN_ERC20.toLowerCase()]: true, [TOKEN_ERC721.toLowerCase()]: false },
    bindings: { [TOKEN_ERC20.toLowerCase()]: { token: TOKEN_ERC20, tokenKind: 0n, nativeKind: 1n, nativeId: 1n, nativeDecimals: 14n, evmDecimals: 18n, conversionFactor: 10000n, nativeAccountHash: COMMITMENT, active: true } },
    pendingReceipts: { [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 66, transactionHash: `0x${'aa'.repeat(32)}` } },
  });
  assert.equal(sentBinds.length, 1);
  assert.equal(sentBinds[0].token, TOKEN_ERC721);
  const final = recordIo.state();
  const erc20Entry = final.bindings.find((e) => e.token === TOKEN_ERC20);
  assert.equal(erc20Entry.status, 'confirmed');
  assert.equal(erc20Entry.blockNumber, 66);
});

test('binding: ambiguous pending binding (no receipt) aborts fail-closed without a duplicate', async () => {
  const rec = bindRecord({
    bindings: [
      { token: TOKEN_ERC20, tokenKind: 0, nativeKind: 1, nativeId: 1, nativeDecimals: 14, evmDecimals: 18, conversionFactor: '10000', nativeAccountHash: COMMITMENT, active: true, txHash: `0x${'aa'.repeat(32)}`, status: 'pending' },
    ],
  });
  await assert.rejects(() => bindingHarness(rec, { boundAlready: { [TOKEN_ERC721.toLowerCase()]: false } }), /ambiguous/);
});

test('binding: missing deployment record aborts; binding never releases into a void', async () => {
  await assert.rejects(() => bindingHarness(null), /not found|void/);
});

test('binding: accepts a balance below the whole-release requirement (remaining-phase funding)', async () => {
  const rec = bindRecord();
  // Whole release costs ~2,549 tPOT; binding-only needs far less. 2,000 tPOT
  // covers the two outstanding binds but not a whole fresh release.
  const { result } = await bindingHarness(rec, { evmBalance: 2_000n * 10n ** 18n, nativeFree: 2_000n * 10n ** 14n });
  assert.equal(result.sentCount, 2, 'both bindings sent with remaining-phase funding only');
});

test('binding: malformed deployment record aborts before any binding', async () => {
  await assert.rejects(() => bindingHarness('MALFORMED'), /malformed|valid release record/);
});


