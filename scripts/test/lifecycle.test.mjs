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

// Mirrors scripts/deploy.js RELEASE_PLAN_VERSION (not exported, kept in sync).
const RELEASE_PLAN_VERSION = 1;

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
  const hexSuffix = suffix.replace(/[^0-9a-f]/g, 'd');
  return `0x${hexSuffix.padEnd(64, hexSuffix).slice(0, 64)}`;
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
  releasePlan: {
    version: 1,
    network: NETWORK,
    chainId: CHAIN_ID,
    deployer: DEPLOYER,
    tokenConfig: {
      erc20Name: 'Portaldot Pot Token',
      erc20Symbol: 'POT',
      erc721Name: 'Portaldot Pot Collectibles',
      erc721Symbol: 'POTC',
    },
    nativeObjects: [
      { kind: 'asset', id: 1 },
      { kind: 'nft_collection', id: 2 },
    ],
    nativeAccountHash: COMMITMENT,
    commitmentSource: 'derived',
  },
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
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
      [`0x${'bb'.repeat(32)}`]: { status: 1, blockNumber: 2, transactionHash: `0x${'bb'.repeat(32)}`, contractAddress: TOKEN_ERC721 },
      [`0x${'cc'.repeat(32)}`]: { status: 1, blockNumber: 3, transactionHash: `0x${'cc'.repeat(32)}`, contractAddress: REGISTRY_ADDR },
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
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
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

// ------------------------------------------------------------
// 4. Objective A: Frozen release plan (immutable configuration)
// ------------------------------------------------------------

function recordWithPlan(tokenConfigOverrides = {}, nativeObjectsOverrides = []) {
  const r = JSON.parse(JSON.stringify(existingRecord));
  r.releasePlan = {
    version: RELEASE_PLAN_VERSION,
    network: NETWORK,
    chainId: CHAIN_ID,
    deployer: DEPLOYER,
    tokenConfig: {
      erc20Name: tokenConfigOverrides.erc20Name ?? 'Custom Token',
      erc20Symbol: tokenConfigOverrides.erc20Symbol ?? 'CUSTOM',
      erc721Name: tokenConfigOverrides.erc721Name ?? 'Custom Collectibles',
      erc721Symbol: tokenConfigOverrides.erc721Symbol ?? 'CUSTC',
    },
    nativeObjects: nativeObjectsOverrides.length > 0
      ? nativeObjectsOverrides
      : [
          { kind: 'asset', id: 1 },
          { kind: 'nft_collection', id: 2 },
        ],
    nativeAccountHash: COMMITMENT,
    commitmentSource: 'derived',
  };
  return r;
}

// Partial record that only has PotERC20 confirmed (for resume tests)
function partialRecordWithPlan(tokenConfigOverrides = {}) {
  const r = recordWithPlan(tokenConfigOverrides);
  r.contracts = { PotERC20: existingRecord.contracts.PotERC20 };
  r.tokens = { erc20: { address: TOKEN_ERC20, name: r.releasePlan.tokenConfig.erc20Name, symbol: r.releasePlan.tokenConfig.erc20Symbol, decimals: 18 } };
  return r;
}

test('Objective A: completed release cannot have names/symbols changed by different env vars', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(recordWithPlan());
  // Only PotERC20 needs a receipt/code since it's confirmed; the others are outstanding
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
  });
  // Env has DIFFERENT names than the frozen plan → must abort
  const driftingEnv = {
    ...probeEnv(),
    POT_ERC20_NAME: 'Different Token',
  };

  await assert.rejects(() => runRelease({
    env: driftingEnv,
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract: async () => deployResult('PotERC20', `0x${'ee'.repeat(32)}`),
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /release plan.*erc20Name.*conflicts|drift/);

  // Original record is preserved unchanged
  assert.equal(recordIo.state().releasePlan.tokenConfig.erc20Name, 'Custom Token');
});

test('Objective A: partial release cannot resume with conflicting constructor settings', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(partialRecordWithPlan());
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
  });
  // Env has a different symbol than the frozen plan → must abort before deploying anything
  const driftingEnv = {
    ...probeEnv(),
    POT_ERC20_SYMBOL: 'DIFFERENT',
  };
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC721', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: driftingEnv,
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /release plan.*erc20Symbol.*conflicts|drift/);
  assert.equal(sent, 0, 'no deployment may proceed when constructor settings conflict with the frozen plan');
});

test('Objective A: normal retry with unchanged settings reuses existing deployments without duplicates', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(recordWithPlan());
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      [TOKEN_ERC721]: `0x${'ff'.repeat(200)}`,
      [REGISTRY_ADDR]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
      [`0x${'bb'.repeat(32)}`]: { status: 1, blockNumber: 2, transactionHash: `0x${'bb'.repeat(32)}`, contractAddress: TOKEN_ERC721 },
      [`0x${'cc'.repeat(32)}`]: { status: 1, blockNumber: 3, transactionHash: `0x${'cc'.repeat(32)}`, contractAddress: REGISTRY_ADDR },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  const result = await runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(result.sentCount, 0, 'no deployments on retry with unchanged settings');
  assert.equal(result.reusedCount, 3);
  assert.equal(sent, 0);
  // Plan is untouched
  assert.equal(recordIo.state().releasePlan.tokenConfig.erc20Name, 'Custom Token');
});

test('Objective A: explicit fresh release archives the previous record before beginning a new plan', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(recordWithPlan());
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
  assert.ok(result.archived, 'previous record must be archived before starting a new plan');
});

// ------------------------------------------------------------
// 5. Objective C: Recorded deployment verification before reuse
// ------------------------------------------------------------

function verifiedRecordWithEntry(entry) {
  const r = JSON.parse(JSON.stringify(existingRecord));
  r.contracts = { PotERC20: entry };
  r.tokens = { erc20: { address: entry.address, name: 'Custom Token', symbol: 'CUSTOM', decimals: 18 } };
  r.releasePlan = {
    version: RELEASE_PLAN_VERSION,
    network: NETWORK,
    chainId: CHAIN_ID,
    deployer: DEPLOYER,
    tokenConfig: { erc20Name: 'Custom Token', erc20Symbol: 'CUSTOM', erc721Name: 'Custom Collectibles', erc721Symbol: 'CUSTC' },
    nativeObjects: [{ kind: 'asset', id: 1 }, { kind: 'nft_collection', id: 2 }],
    nativeAccountHash: COMMITMENT,
    commitmentSource: 'derived',
  };
  return r;
}

test('Objective C: confirmed entry with no receipt on chain aborts before reuse', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    // No receipts → ambiguous
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /no receipt on chain|cannot be proven/);
  assert.equal(sent, 0, 'no new broadcast when receipt is unavailable');
});

test('Objective C: confirmed entry with mismatched contract address aborts before reuse', async () => {
  const recordFile = tempFile();
  const wrongAddress = `0x${'99'.repeat(20)}`;
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: wrongAddress,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /does not match the recorded address/);
  assert.equal(sent, 0);
});

test('Objective C: confirmed entry with failed receipt status aborts before reuse', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 0, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /failed with status/);
  assert.equal(sent, 0);
});

test('Objective C: confirmed entry with missing bytecode aborts before reuse', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    // No codes → returns '0x' (no bytecode)
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /no bytecode/);
  assert.equal(sent, 0);
});

test('Objective C: confirmed entry with inconsistent block number aborts before reuse', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 999,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /block number/);
  assert.equal(sent, 0);
});

test('Objective C: verified confirmed entries are reused without duplicate deployment', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      [TOKEN_ERC721]: `0x${'ff'.repeat(200)}`,
      [REGISTRY_ADDR]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
      [`0x${'bb'.repeat(32)}`]: { status: 1, blockNumber: 2, transactionHash: `0x${'bb'.repeat(32)}`, contractAddress: TOKEN_ERC721 },
      [`0x${'cc'.repeat(32)}`]: { status: 1, blockNumber: 3, transactionHash: `0x${'cc'.repeat(32)}`, contractAddress: REGISTRY_ADDR },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };

  const result = await runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(result.sentCount, 2, 'only outstanding contracts deployed');
  assert.equal(result.reusedCount, 1, 'verified contract reused');
  assert.equal(sent, 2, 'deployContract called only for outstanding contracts');
});

// ------------------------------------------------------------
// 6. Objective B: Pre-broadcast journaling fault injection
// ------------------------------------------------------------

// deployContract that simulates pre-broadcast journaling:
// 1. derive txHash, 2. call onSent (persist pending), 3. broadcast (or fail)
function journalingDeployContract(opts = {}) {
  const {
    shouldThrowAfterOnSent = false,
    shouldThrowAfterBroadcast = false,
    receipts = {},
    codes = {},
    broadcastHashes = {},
    calls = [],
  } = opts;
  let seq = 0;
  return async (artifact, gasLimit, hooks) => {
    seq += 1;
    const index = seq - 1;
    const txHash = mockTxHash('jj' + seq);
    const receipt = receipts[txHash] || { status: 1, blockNumber: 10 + seq, transactionHash: txHash, contractAddress: RELEASE_ADDRESS(artifact.name) };
    // Step 1: derive hash, persist pending (onSent) BEFORE broadcast
    if (hooks.onSent) hooks.onSent(txHash);
    // Simulate crash between journaling and broadcast
    if (shouldThrowAfterOnSent) {
      throw new Error('crash after journaling, before broadcast');
    }
    // Step 2: broadcast (simulated by returning a tx object)
    const broadcastTx = { hash: txHash, wait: async () => receipt };
    // Simulate crash/write failure after broadcast
    if (shouldThrowAfterBroadcast) {
      throw new Error('crash after broadcast, before persistence complete');
    }
    if (hooks.onReceipt) hooks.onReceipt(receipt);
    return { txHash, receipt, address: receipt.contractAddress };
  };
}

test('Objective B: crash before broadcast - journaled pending entry reconciled on retry, no duplicate', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(null);
  const txHash = mockTxHash('jj1');
  // First run: journal pending then crash before broadcast
  const crashingDeploy = journalingDeployContract({ shouldThrowAfterOnSent: true });
  let sent1 = 0;
  const deploy1 = async (artifact, gasLimit, hooks) => {
    sent1 += 1;
    return crashingDeploy(artifact, gasLimit, hooks);
  };

  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
  });
  // env with custom names matching plan
  const planEnv = {
    ...probeEnv(),
    POT_ERC20_NAME: 'Custom Token',
    POT_ERC20_SYMBOL: 'CUSTOM',
    POT_ERC721_NAME: 'Custom Collectibles',
    POT_ERC721_SYMBOL: 'CUSTC',
  };

  // First run crashes after journaling PotERC20
  await assert.rejects(() => runRelease({
    env: planEnv,
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract: deploy1,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /crash after journaling/);
  assert.equal(sent1, 1, 'one deployment attempted before crash');
  const afterCrash = recordIo.state();
  assert.equal(afterCrash.contracts.PotERC20.status, 'pending', 'pending entry journaled before broadcast');
  assert.equal(afterCrash.contracts.PotERC20.txHash, txHash, 'journaled txHash recorded');

  // Second run: receipt now available on chain → reconcile, no redeploy
  const probes2 = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      [TOKEN_ERC721]: `0x${'ff'.repeat(200)}`,
      [REGISTRY_ADDR]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [txHash]: { status: 1, blockNumber: 42, transactionHash: txHash, contractAddress: TOKEN_ERC20 },
    },
  });
  let sent2 = 0;
  const deploy2 = async (artifact, gasLimit, hooks) => {
    sent2 += 1;
    const h = mockTxHash('jj2' + sent2);
    const r = { status: 1, blockNumber: 50 + sent2, transactionHash: h, contractAddress: RELEASE_ADDRESS(artifact.name) };
    if (hooks.onSent) hooks.onSent(h);
    if (hooks.onReceipt) hooks.onReceipt(r);
    return { txHash: h, receipt: r, address: r.contractAddress };
  };

  const result = await runRelease({
    env: planEnv,
    deployerAddress: DEPLOYER,
    recordIo,
    probes: probes2,
    deployContract: deploy2,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(sent2, 2, 'only PotERC721 and PotRegistry deployed (PotERC20 reconciled)');
  const final = recordIo.state();
  assert.equal(final.contracts.PotERC20.status, 'confirmed');
  assert.equal(final.contracts.PotERC20.txHash, txHash, 'reconciled from journaled txHash, not redeployed');
  assert.equal(final.contracts.PotERC20.blockNumber, 42);
});

test('Objective B: crash after broadcast - pending entry persists, retry reconciles without duplicate broadcast', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(null);
  const txHash = mockTxHash('jj1');
  // deployContract: journal pending (onSent), then throw after broadcast
  const crashingDeploy = journalingDeployContract({ shouldThrowAfterBroadcast: true });
  let sent = 0;
  const deployContract = async (artifact, gasLimit, hooks) => {
    sent += 1;
    return crashingDeploy(artifact, gasLimit, hooks);
  };

  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
  });
  const planEnv = {
    ...probeEnv(),
    POT_ERC20_NAME: 'Custom Token',
    POT_ERC20_SYMBOL: 'CUSTOM',
    POT_ERC721_NAME: 'Custom Collectibles',
    POT_ERC721_SYMBOL: 'CUSTC',
  };

  await assert.rejects(() => runRelease({
    env: planEnv,
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /crash after broadcast/);
  assert.equal(sent, 1, 'broadcast was attempted once before crash');
  const afterCrash = recordIo.state();
  assert.equal(afterCrash.contracts.PotERC20.status, 'pending', 'pending entry persists after broadcast crash');
  assert.equal(afterCrash.contracts.PotERC20.txHash, txHash);

  // Retry: receipt available → reconcile, no duplicate
  const probes2 = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      [TOKEN_ERC721]: `0x${'ff'.repeat(200)}`,
      [REGISTRY_ADDR]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [txHash]: { status: 1, blockNumber: 43, transactionHash: txHash, contractAddress: TOKEN_ERC20 },
    },
  });
  let sent2 = 0;
  const deploy2 = async () => { sent2 += 1; return deployResult('PotERC721', `0x${'ee'.repeat(32)}`); };

  const result = await runRelease({
    env: planEnv,
    deployerAddress: DEPLOYER,
    recordIo,
    probes: probes2,
    deployContract: deploy2,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(sent2, 2, 'no duplicate broadcast for journaled transaction');
  const final = recordIo.state();
  assert.equal(final.contracts.PotERC20.status, 'confirmed');
  assert.equal(final.contracts.PotERC20.txHash, txHash, 'same txHash reused, not a new broadcast');
});

test('Objective B: no receipt and genuinely ambiguous state aborts fail-closed', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(null);
  const txHash = mockTxHash('jj1');
  const crashingDeploy = journalingDeployContract({ shouldThrowAfterBroadcast: true });
  let sent = 0;
  const deployContract = async (artifact, gasLimit, hooks) => {
    sent += 1;
    return crashingDeploy(artifact, gasLimit, hooks);
  };

  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
  });
  const planEnv = {
    ...probeEnv(),
    POT_ERC20_NAME: 'Custom Token',
    POT_ERC20_SYMBOL: 'CUSTOM',
    POT_ERC721_NAME: 'Custom Collectibles',
    POT_ERC721_SYMBOL: 'CUSTC',
  };

  await assert.rejects(() => runRelease({
    env: planEnv,
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /crash after broadcast/);

  // Retry with NO receipt → genuinely ambiguous, abort fail-closed
  const probes2 = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    // no receipts → ambiguous
  });
  let sent2 = 0;
  const deploy2 = async () => { sent2 += 1; return deployResult('PotERC721', `0x${'ee'.repeat(32)}`); };

  await assert.rejects(() => runRelease({
    env: planEnv,
    deployerAddress: DEPLOYER,
    recordIo,
    probes: probes2,
    deployContract: deploy2,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /has no receipt yet|cannot be proven/);
  assert.equal(sent2, 0, 'no new broadcast for ambiguous transaction');
  const final = recordIo.state();
  assert.equal(final.contracts.PotERC20.status, 'pending', 'pending entry preserved, not overwritten');
});

test('Objective B: receipt success followed by persistence failure aborts without losing evidence', async () => {
  const recordFile = tempFile();
  let store = null;
  let writeCount = 0;
  const faultyRecordIo = {
    read: (file) => {
      if (store === null) return { status: 'missing', data: null, error: null };
      return { status: 'ok', data: JSON.parse(JSON.stringify(store)), error: null };
    },
    write: (file, value) => {
      writeCount += 1;
      // Fail on the confirmed-entry write (write #3: #1 budget at step 5,
      // #2 pending via onSent, #3 confirmed after deployContract returns)
      if (writeCount === 3) {
        throw new Error('disk write failure after receipt');
      }
      store = JSON.parse(JSON.stringify(value));
    },
    archive: (file) => null,
    state: () => store,
  };
  const txHash = mockTxHash('dd1');
  const receipt = { status: 1, blockNumber: 44, transactionHash: txHash, contractAddress: TOKEN_ERC20 };
  let sent = 0;
  const deployContract = async (artifact, gasLimit, hooks) => {
    sent += 1;
    if (hooks.onSent) hooks.onSent(txHash);
    if (hooks.onReceipt) hooks.onReceipt(receipt);
    return { txHash, receipt, address: TOKEN_ERC20 };
  };

  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
  });
  const planEnv = {
    ...probeEnv(),
    POT_ERC20_NAME: 'Custom Token',
    POT_ERC20_SYMBOL: 'CUSTOM',
    POT_ERC721_NAME: 'Custom Collectibles',
    POT_ERC721_SYMBOL: 'CUSTC',
  };

  await assert.rejects(() => runRelease({
    env: planEnv,
    deployerAddress: DEPLOYER,
    recordIo: faultyRecordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /disk write failure/);
  assert.equal(sent, 1, 'broadcast and receipt succeeded, persistence of confirmed entry failed');
  const afterFailureState = faultyRecordIo.state();
  assert.equal(afterFailureState.contracts.PotERC20.status, 'pending', 'pending entry persisted before confirmed-entry write failed');

  // Retry with the state from the failed run and receipt on chain → reconcile
  const probes2 = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      [TOKEN_ERC721]: `0x${'ff'.repeat(200)}`,
      [REGISTRY_ADDR]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [txHash]: { status: 1, blockNumber: 44, transactionHash: txHash, contractAddress: TOKEN_ERC20 },
    },
  });
  let sent2 = 0;
  const deploy2 = async () => { sent2 += 1; return deployResult('PotERC721', `0x${'ee'.repeat(32)}`); };

  const result = await runRelease({
    env: planEnv,
    deployerAddress: DEPLOYER,
    recordIo: makeRecordIo(afterFailureState),
    probes: probes2,
    deployContract: deploy2,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(sent2, 2, 'no duplicate broadcast after recovery');
});


// ------------------------------------------------------------
// 7. Objective A: Fresh release-plan persistence
// ------------------------------------------------------------

test('Objective A: fresh release persists complete plan before first broadcast', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(null);
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      [TOKEN_ERC721]: `0x${'ff'.repeat(200)}`,
      [REGISTRY_ADDR]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
      [`0x${'bb'.repeat(32)}`]: { status: 1, blockNumber: 2, transactionHash: `0x${'bb'.repeat(32)}`, contractAddress: TOKEN_ERC721 },
      [`0x${'cc'.repeat(32)}`]: { status: 1, blockNumber: 3, transactionHash: `0x${'cc'.repeat(32)}`, contractAddress: REGISTRY_ADDR },
    },
  });
  let planSeenBeforeBroadcast = null;
  let sent = 0;
  const deployContract = async (artifact, gasLimit, hooks) => {
    // Capture the plan (record state) before broadcasting this artifact
    const currentState = recordIo.state();
    if (planSeenBeforeBroadcast === null) {
      planSeenBeforeBroadcast = currentState;
    }
    sent += 1;
    const txHash = mockTxHash('dd' + sent);
    hooks.onSent(txHash);
    const receipt = { status: 1, blockNumber: 10 + sent, transactionHash: txHash, contractAddress: RELEASE_ADDRESS(artifact.name) };
    if (hooks.onReceipt) hooks.onReceipt(receipt);
    return deployResult(artifact.name, txHash, receipt);
  };

  const result = await runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Fresh Token',
      POT_ERC20_SYMBOL: 'FRES',
      POT_ERC721_NAME: 'Fresh Collectibles',
      POT_ERC721_SYMBOL: 'FRSC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  });
  assert.equal(result.sentCount, 3, 'all three contracts deployed');

  // The plan must have been persisted before the first broadcast
  const final = recordIo.state();
  assert.ok(final.releasePlan, 'release plan must be persisted in the record');
  assert.equal(final.releasePlan.version, 1, 'plan schema version must be 1');
  assert.equal(final.releasePlan.network, NETWORK, 'plan network must match');
  assert.equal(final.releasePlan.chainId, CHAIN_ID, 'plan chainId must match');
  assert.equal(final.releasePlan.deployer, DEPLOYER, 'plan deployer must match');
  assert.equal(final.releasePlan.tokenConfig.erc20Name, 'Fresh Token', 'plan erc20 name must match env');
  assert.equal(final.releasePlan.tokenConfig.erc20Symbol, 'FRES', 'plan erc20 symbol must match env');
  assert.equal(final.releasePlan.tokenConfig.erc721Name, 'Fresh Collectibles', 'plan erc721 name must match env');
  assert.equal(final.releasePlan.tokenConfig.erc721Symbol, 'FRSC', 'plan erc721 symbol must match env');
  assert.equal(final.releasePlan.nativeObjects[0].kind, 'asset', 'plan nativeObjects must include asset');
  assert.equal(final.releasePlan.nativeObjects[0].id, 1, 'plan asset id must match env');
  assert.equal(final.releasePlan.nativeObjects[1].kind, 'nft_collection', 'plan nativeObjects must include nft_collection');
  assert.equal(final.releasePlan.nativeObjects[1].id, 2, 'plan nft id must match env');
  assert.equal(final.releasePlan.nativeAccountHash, COMMITMENT, 'plan nativeAccountHash must match commitment');
  assert.equal(final.releasePlan.commitmentSource, 'derived', 'plan commitmentSource must be derived');

  // Verify the plan was present before the first broadcast
  assert.ok(planSeenBeforeBroadcast.releasePlan, 'plan must be present in record before first broadcast');
  assert.equal(planSeenBeforeBroadcast.releasePlan.tokenConfig.erc20Name, 'Fresh Token', 'plan erc20 name must be present before first broadcast');
});

// ------------------------------------------------------------
// 8. Objective B: Validate exact configuration across both stages
// ------------------------------------------------------------

function planMismatchHarness(planOverrides = {}, envOverrides = {}, expectErrorPattern) {
  return async () => {
    const recordFile = tempFile();
    const basePlan = {
      version: 1,
      network: NETWORK,
      chainId: CHAIN_ID,
      deployer: DEPLOYER,
      tokenConfig: {
        erc20Name: 'Portaldot Pot Token',
        erc20Symbol: 'POT',
        erc721Name: 'Portaldot Pot Collectibles',
        erc721Symbol: 'POTC',
      },
      nativeObjects: [
        { kind: 'asset', id: 1 },
        { kind: 'nft_collection', id: 2 },
      ],
      nativeAccountHash: COMMITMENT,
      commitmentSource: 'derived',
    };
    const plan = { ...basePlan, ...planOverrides };
    const record = {
      ...existingRecord,
      releasePlan: plan,
    };
    const recordIo = makeRecordIo(record);
    const probes = makeProbes({
      evmBalance: 10_000n * 10n ** 18n,
      nativeFree: 10_000n * 10n ** 14n,
      codes: {
        [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      },
      receipts: {
        [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
      },
    });
    let sent = 0;
    const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };
    const env = { ...probeEnv(), ...envOverrides };
    await assert.rejects(() => runRelease({
      env,
      deployerAddress: DEPLOYER,
      recordIo,
      probes,
      deployContract,
      recordFile,
      networkName: NETWORK,
      chainId: CHAIN_ID,
    }), expectErrorPattern);
    assert.equal(sent, 0, 'no deployment may proceed when configuration conflicts with frozen plan');
  };
}

test('Objective B: changed native asset ID aborts before signing', async () => {
  await planMismatchHarness(
    { nativeObjects: [{ kind: 'asset', id: 999 }, { kind: 'nft_collection', id: 2 }] },
    {},
    /native asset id.*999.*but the environment configures 1|refusing to drift/
  );
});

test('Objective B: changed NFT collection ID aborts before signing', async () => {
  await planMismatchHarness(
    { nativeObjects: [{ kind: 'asset', id: 1 }, { kind: 'nft_collection', id: 999 }] },
    {},
    /native nft_collection id.*999.*but the environment configures 2|refusing to drift/
  );
});

test('Objective B: changed native account hash aborts before signing', async () => {
  await planMismatchHarness(
    { nativeAccountHash: `0x${'ff'.repeat(32)}` },
    {},
    /native account commitment conflicts/
  );
});

test('Objective B: different release-plan deployer aborts before signing', async () => {
  const recordFile = tempFile();
  const record = {
    ...existingRecord,
    deployer: `0x${'99'.repeat(20)}`,
    releasePlan: {
      version: 1,
      network: NETWORK,
      chainId: CHAIN_ID,
      deployer: `0x${'99'.repeat(20)}`,
      tokenConfig: {
        erc20Name: 'Portaldot Pot Token',
        erc20Symbol: 'POT',
        erc721Name: 'Portaldot Pot Collectibles',
        erc721Symbol: 'POTC',
      },
      nativeObjects: [
        { kind: 'asset', id: 1 },
        { kind: 'nft_collection', id: 2 },
      ],
      nativeAccountHash: COMMITMENT,
      commitmentSource: 'derived',
    },
  };
  const recordIo = makeRecordIo(record);
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
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
  }), /different deployer/);
  assert.equal(sent, 0, 'no deployment may proceed when deployer conflicts with plan');
});

test('Objective B: network mismatch aborts before signing', async () => {
  const recordFile = tempFile();
  const record = {
    ...existingRecord,
    network: 'otherNetwork',
    releasePlan: {
      ...existingRecord.releasePlan,
      network: 'otherNetwork',
    },
  };
  const recordIo = makeRecordIo(record);
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
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
  }), /belongs to network/);
  assert.equal(sent, 0, 'no deployment may proceed when network conflicts with plan');
});

test('Objective B: chainId mismatch aborts before signing', async () => {
  const recordFile = tempFile();
  // Record chainId is correct, but releasePlan chainId differs
  const record = {
    ...existingRecord,
    releasePlan: {
      ...existingRecord.releasePlan,
      chainId: 1,
    },
  };
  const recordIo = makeRecordIo(record);
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
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
  }), /release plan chainId/);
  assert.equal(sent, 0, 'no deployment may proceed when chainId conflicts with plan');
});

test('Objective B: token metadata drift aborts before signing', async () => {
  await planMismatchHarness(
    {},
    { POT_ERC20_NAME: 'Different Token' },
    /release plan.*erc20Name.*conflicts/
  );
});

test('Objective B: binding attempt with conflicting config aborts before signing', async () => {
  // A binding attempt where env native IDs conflict with the frozen plan
  const recordFile = tempFile();
  const record = {
    ...existingRecord,
    bindings: [],
  };
  const recordIo = makeRecordIo(record);
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: {
      [TOKEN_ERC20]: `0x${'ff'.repeat(200)}`,
      [TOKEN_ERC721]: `0x${'ff'.repeat(200)}`,
      [REGISTRY_ADDR]: `0x${'ff'.repeat(200)}`,
    },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
      [`0x${'bb'.repeat(32)}`]: { status: 1, blockNumber: 2, transactionHash: `0x${'bb'.repeat(32)}`, contractAddress: TOKEN_ERC721 },
      [`0x${'cc'.repeat(32)}`]: { status: 1, blockNumber: 3, transactionHash: `0x${'cc'.repeat(32)}`, contractAddress: REGISTRY_ADDR },
    },
  });
  let sent = 0;
  const bindSender = async (params, hooks) => {
    sent += 1;
    const txHash = mockTxHash('bb' + sent);
    if (hooks.onSent) hooks.onSent(txHash);
    return { hash: txHash, wait: async () => ({ status: 1, blockNumber: 77, transactionHash: txHash }) };
  };
  const registryViews = {
    isBound: async () => false,
    bindingOfToken: async () => null,
    bindingCount: async () => 0,
  };
  const encodeBind = () => '0xbind';
  const env = {
    ...probeEnv(),
    POT_NATIVE_ASSET_ID: '999', // conflicts with plan's asset id 1
  };
  await assert.rejects(() => runBinding({
    env,
    recordIo,
    probes,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
    signerAddress: DEPLOYER,
    registryViews,
    bindSender,
    encodeBind,
    registryAddress: REGISTRY_ADDR,
    tokenAddresses: { erc20: TOKEN_ERC20, erc721: TOKEN_ERC721 },
  }), /native asset id 1 but the environment configures 999/);
  assert.equal(sent, 0, 'no binding transaction may proceed when config conflicts with frozen plan');
});

// ------------------------------------------------------------
// 9. Objective C: Additional pending deployment receipt reconciliation tests
// ------------------------------------------------------------

test('Objective C: receipt missing contractAddress aborts even when record has address', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    receipts: {
      // Receipt has no contractAddress field
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}` },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };
  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /contract-creation address/);
  assert.equal(sent, 0, 'no deployment may proceed when receipt lacks contractAddress');
});

test('Objective C: receipt contractAddress malformed aborts', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: 'not-an-address' },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };
  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /contract-creation address/);
  assert.equal(sent, 0, 'no deployment may proceed when receipt contractAddress is malformed');
});

test('Objective C: receipt address different from recorded address aborts', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, blockNumber: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC721 },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };
  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /does not match the recorded address/);
  assert.equal(sent, 0, 'no deployment may proceed when receipt address differs from journaled address');
});

test('Objective C: missing block number aborts reconciliation', async () => {
  const recordFile = tempFile();
  const recordIo = makeRecordIo(verifiedRecordWithEntry({
    address: TOKEN_ERC20,
    txHash: `0x${'aa'.repeat(32)}`,
    blockNumber: 1,
    status: 'confirmed',
  }));
  const probes = makeProbes({
    evmBalance: 10_000n * 10n ** 18n,
    nativeFree: 10_000n * 10n ** 14n,
    codes: { [TOKEN_ERC20]: `0x${'ff'.repeat(200)}` },
    receipts: {
      [`0x${'aa'.repeat(32)}`]: { status: 1, transactionHash: `0x${'aa'.repeat(32)}`, contractAddress: TOKEN_ERC20 },
    },
  });
  let sent = 0;
  const deployContract = async () => { sent += 1; return deployResult('PotERC20', `0x${'ee'.repeat(32)}`); };
  await assert.rejects(() => runRelease({
    env: {
      ...probeEnv(),
      POT_ERC20_NAME: 'Custom Token',
      POT_ERC20_SYMBOL: 'CUSTOM',
      POT_ERC721_NAME: 'Custom Collectibles',
      POT_ERC721_SYMBOL: 'CUSTC',
    },
    deployerAddress: DEPLOYER,
    recordIo,
    probes,
    deployContract,
    recordFile,
    networkName: NETWORK,
    chainId: CHAIN_ID,
  }), /invalid block number/);
  assert.equal(sent, 0, 'no deployment may proceed when receipt block number is invalid');
});
