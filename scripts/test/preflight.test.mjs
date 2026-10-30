import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReleasePreflight, DEFAULT_GAS_MARGIN_PERCENT } from '../lib/preflight.cjs';
import { assessReleaseBudget, ceilDiv, WEI_PER_NATIVE_UNIT } from '../lib/validation.cjs';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOYER_EVM = '0xf7eC65d11e35375A250e474059a917B537804142';
const ACCOUNT_HEX = '0xf7ec65d11e35375a250e474059a917b537804142eeeeeeeeeeeeeeeeeeeeeeee';
const ACCOUNT_SS58 = '5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8Y';
const COMMITMENT = `0x${createHash('sha256').update(Buffer.from(ACCOUNT_HEX.slice(2), 'hex')).digest('hex')}`;
const TPOT_EVM = 1350n * 10n ** 18n;
const TPOT_NATIVE = 1350n * 10n ** 14n;
const BLOCK_LIMIT = 18446744073709551615n;
const ESTIMATE = 1_000_000_000_000_000n;
const BIND_ESTIMATE = 17_000_000_000_000_000n;
const GAS_PRICE = 27_440n;

function passingConfig(overrides = {}) {
  return {
    expectedChainId: 420420777,
    deployerEvm: DEPLOYER_EVM,
    nativeAccount: { hex: ACCOUNT_HEX, ss58: ACCOUNT_SS58 },
    nativeAccountHash: COMMITMENT,
    requiredTpot: 1350n,
    nativeObjects: [
      { kind: 'asset', id: 1 },
      { kind: 'nft_collection', id: 2 },
    ],
    requireDualCounterparts: true,
    artifacts: [],
    gasLimitRaw: null,
    tokenConfig: { erc20Name: 'Portaldot Pot Token', erc20Symbol: 'POT', erc721Name: 'Pot Collectibles', erc721Symbol: 'POTC' },
    ...overrides,
  };
}

// Fully passing fake probes; each call is recorded by name.
function passingProbes(record = [], overrides = {}) {
  const wrap = (name, fn) => async (...args) => {
    record.push(name);
    return fn(...args);
  };
  return {
    chainId: wrap('chainId', async () => 420420777n),
    evmBalance: wrap('evmBalance', async () => TPOT_EVM),
    nativeFreeBalance: wrap('nativeFreeBalance', async () => TPOT_NATIVE),
    gasPrice: wrap('gasPrice', async () => 27_440n),
    nativeObject: wrap('nativeObject', async (kind, id) => ({ kind, id, exists: true, details: 'fake object' })),
    blockGasLimit: wrap('blockGasLimit', async () => BLOCK_LIMIT),
    estimateCreationGas: wrap('estimateCreationGas', async () => ESTIMATE),
    code: wrap('code', async (address) => `0x5b${'ff'.repeat(100)}`),
    receipt: wrap('receipt', async (txHash) => ({ status: 1, transactionHash: txHash, blockNumber: 1, contractAddress: '0x' + 'ab'.repeat(20) })),
    estimateCall: wrap('estimateCall', async ({ to, data, from }) => BIND_ESTIMATE),
    ...overrides,
  };
}

test('preflight passes with every probe healthy and orders the cheap checks first', async () => {
  const calls = [];
  const result = await runReleasePreflight(passingConfig(), passingProbes(calls));
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.ok(calls[0] === 'chainId');
  assert.equal(result.checks[0].name, 'chain id');
});

test('a failing preflight never lets the broadcast path run', async () => {
  const sentinel = { sent: 0 };
  const badProbes = passingProbes([], {
    nativeObject: async () => {
      throw new Error('native asset 1 does not exist on chain (runtime returned Option::None)');
    },
  });
  const result = await runReleasePreflight(passingConfig(), badProbes);
  assert.equal(result.ok, false);
  // The calling pattern used by deploy.js/bind.js: nothing outside the
  // preflight runs unless ok is true.
  if (result.ok) {
    sentinel.sent += 1;
  }
  assert.equal(sentinel.sent, 0);
  assert.ok(result.failures.some((name) => name.startsWith('asset 1')));
});

test('a failing chain id is recorded and still aborts the release', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    chainId: async () => 1n,
  }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('chain id'));
  assert.match(result.checks[0].detail, /wrong chain ID/);
});

test('insufficient EVM funding fails with the exact shortfall in tPOT and wei', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    evmBalance: async () => TPOT_EVM - 1n,
  }));
  assert.equal(result.ok, false);
  const evmRow = result.checks.find((check) => check.name.startsWith('funding (EVM ledger'));
  assert.equal(evmRow.pass, false);
  assert.match(evmRow.detail, /short 0\.000000000000000001 tPOT/);
  assert.ok(result.failures.some((name) => name.startsWith('funding (EVM ledger')));
});

test('insufficient native funding fails in native units', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    nativeFreeBalance: async () => TPOT_NATIVE - 1n,
  }));
  assert.equal(result.ok, false);
  const nativeRow = result.checks.find((check) => check.name.startsWith('funding (native ledger'));
  assert.equal(nativeRow.pass, false);
  assert.match(nativeRow.detail, /short/);
});

test('a failed native read is a failed preflight even with a funded EVM balance', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    nativeFreeBalance: async () => {
      throw new Error('native WebSocket timed out');
    },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((name) => name.startsWith('funding (native ledger')));
  const detail = result.checks.find((check) => check.name.startsWith('funding (native ledger')).detail;
  assert.match(detail, /read failed/);
});

test('a failed EVM read is a failed preflight even with a funded native balance', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    evmBalance: async () => {
      throw new Error('RPC unreachable');
    },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((name) => name.startsWith('funding (EVM ledger')));
});

test('zero balances fail both funding checks', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    evmBalance: async () => 0n,
    nativeFreeBalance: async () => 0n,
  }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((name) => name.startsWith('funding (EVM ledger')));
  assert.ok(result.failures.some((name) => name.startsWith('funding (native ledger')));
});

test('balances far above the threshold keep the release eligible', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    evmBalance: async () => 1n << 200n,
    nativeFreeBalance: async () => 1n << 200n,
  }));
  assert.equal(result.ok, true);
});

test('Option::None on the native runtime rejects the object', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    nativeObject: async (kind, id) => {
      if (kind === 'asset') throw new Error(`native asset ${id} does not exist on chain (runtime returned Option::None)`);
      return { kind, id, exists: true, details: 'ok' };
    },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((name) => name.startsWith('asset 1')));
});

test('unsupported runtime storage queries reject fail-closed', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    nativeObject: async () => {
      throw new Error('the native runtime does not support assets.asset: the query is missing from runtime metadata, so the object cannot be verified. Failing closed.');
    },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((name) => name.includes('exists on the native runtime')));
});

test('native storage timeouts are rejections, not successes', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    nativeObject: async () => {
      throw new Error('reading native asset 1 from the native runtime (timed out after 20000ms)');
    },
  }));
  assert.equal(result.ok, false);
});

test('missing dual counterparts abort the release before object checks', async () => {
  const result = await runReleasePreflight(
    passingConfig({ nativeObjects: [{ kind: 'asset', id: 1 }] }),
    passingProbes([], { nativeObject: async () => { throw new Error('should not be probed'); } })
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('native counterparts configured'));
  assert.ok(result.checks.find((check) => check.name === 'native counterparts configured').detail.includes('POT_NATIVE_NFT_ID'));
});

test('malformed native ids in the config fail the counterpart check', async () => {
  const result = await runReleasePreflight(
    passingConfig({ nativeObjects: [{ kind: 'asset', id: 'abc' }, { kind: 'nft_collection', id: 2 }] }),
    passingProbes()
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('native counterparts configured'));
});

test('an oversized artifact fails the release', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-artifact-'));
  try {
    const file = path.join(dir, 'artifact.json');
    fs.writeFileSync(file, JSON.stringify({ deployedBytecode: `0x${'ff'.repeat(11000)}`, abi: [] }));
    const result = await runReleasePreflight(
      passingConfig({ artifacts: [{ name: 'PotERC20', file, maxSizeBytes: 10240 }] }),
      passingProbes()
    );
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((name) => name.startsWith('artifact PotERC20')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicitly configured gas limit below the RPC creation estimate is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-gas-'));
  try {
    const file = path.join(dir, 'artifact.json');
    fs.writeFileSync(file, JSON.stringify({ deployedBytecode: '0x60016001', abi: [] }));
    // 5,000,000 is magnitudes below the 10^16-scale estimates this RPC returns.
    const result = await runReleasePreflight(
      passingConfig({ artifacts: [{ name: 'PotERC20', file, maxSizeBytes: 10240 }], gasLimitRaw: '5000000' }),
      passingProbes()
    );
    const gasRow = result.checks.find((check) => check.name === 'gas plan (PotERC20)');
    assert.equal(gasRow.pass, false);
    assert.match(gasRow.detail, /below the RPC's own creation estimate/);
    assert.equal(result.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a gas limit above the block gas limit is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-gas-'));
  try {
    const file = path.join(dir, 'artifact.json');
    fs.writeFileSync(file, JSON.stringify({ deployedBytecode: '0x60016001', abi: [] }));
    const result = await runReleasePreflight(
      passingConfig({
        artifacts: [{ name: 'PotERC20', file, maxSizeBytes: 10240 }],
        gasLimitRaw: '18446744073709551616', // one wei of gas above u64::MAX
      }),
      passingProbes([], { blockGasLimit: async () => 18446744073709551615n })
    );
    assert.equal(result.ok, false);
    const gasRow = result.checks.find((check) => check.name === 'gas plan (PotERC20)');
    assert.match(gasRow.detail, /exceeds the block gas limit/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed creation estimate keeps the release disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-gas-'));
  try {
    const file = path.join(dir, 'artifact.json');
    fs.writeFileSync(file, JSON.stringify({ deployedBytecode: '0x60016001', abi: [] }));
    const result = await runReleasePreflight(
      passingConfig({ artifacts: [{ name: 'PotERC20', file, maxSizeBytes: 10240 }] }),
      passingProbes([], { estimateCreationGas: async () => { throw new Error('eth_estimateGas failed for PotERC20: account has no balance'); } })
    );
    assert.equal(result.ok, false);
    const gasRow = result.checks.find((check) => check.name === 'gas plan (PotERC20)');
    assert.match(gasRow.detail, /eth_estimateGas failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a gas override the plan derives estimate + 20 percent and stays within the block limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-gas-'));
  try {
    const file = path.join(dir, 'artifact.json');
    fs.writeFileSync(file, JSON.stringify({ deployedBytecode: '0x60016001', abi: [] }));
    const result = await runReleasePreflight(
      passingConfig({ artifacts: [{ name: 'PotERC20', file, maxSizeBytes: 10240 }] }),
      passingProbes()
    );
    assert.equal(result.ok, true);
    assert.equal(result.gasPlan.PotERC20, (ESTIMATE * 120n) / 100n);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable block gas limit fails the gas gate closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-gas-'));
  try {
    const file = path.join(dir, 'artifact.json');
    fs.writeFileSync(file, JSON.stringify({ deployedBytecode: '0x60016001', abi: [] }));
    const result = await runReleasePreflight(
      passingConfig({ artifacts: [{ name: 'PotERC20', file, maxSizeBytes: 10240 }] }),
      passingProbes([], { blockGasLimit: async () => { throw new Error('latest block unavailable'); } })
    );
    assert.equal(result.ok, false);
    const gasRow = result.checks.find((check) => check.name === 'gas plan (PotERC20)');
    assert.match(gasRow.detail, /cannot be proven safe|block gas limit could not be read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken commitment derivation fails the identity check', async () => {
  const wrongHash = `0x${'ff'.repeat(32)}`;
  const result = await runReleasePreflight(passingConfig({ nativeAccountHash: wrongHash }), passingProbes());
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('deployer identity and native mapping'));
});

test('the zero commitment is rejected on the explicit override path', async () => {
  const zero = `0x${'00'.repeat(32)}`;
  const result = await runReleasePreflight(
    passingConfig({ nativeAccountHash: zero, commitmentSource: 'override' }),
    passingProbes()
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('deployer identity and native mapping'));
  assert.match(result.checks.find((check) => check.name === 'deployer identity and native mapping').detail, /zero hash/);
});

test('a zero derived commitment fails the sha256 match before storing', async () => {
  const zero = `0x${'00'.repeat(32)}`;
  const result = await runReleasePreflight(passingConfig({ nativeAccountHash: zero }), passingProbes());
  assert.equal(result.ok, false);
  assert.match(
    result.checks.find((check) => check.name === 'deployer identity and native mapping').detail,
    /is not SHA-256 of the 32-byte account/
  );
});

test('empty token configuration is rejected', async () => {
  const result = await runReleasePreflight(
    passingConfig({ tokenConfig: { erc20Name: '', erc20Symbol: 'POT', erc721Name: 'x', erc721Symbol: 'POTC' } }),
    passingProbes()
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('token configuration'));
});

// --- Deploy mode: the computed whole-release budget ---

const WHOLE_RELEASE_ESTIMATES = {
  PotERC20: 10_589_282_911_910_634n,
  PotERC721: 16_865_512_345_550_202n,
  PotRegistry: 16_656_979_668_562_858n,
};

function wholeReleaseProbes(record = [], overrides = {}) {
  return passingProbes(record, {
    estimateCreationGas: async (artifact) => {
      const estimate = WHOLE_RELEASE_ESTIMATES[artifact.name];
      if (estimate === undefined) throw new Error(`no estimated gas for ${artifact.name}`);
      return estimate;
    },
    ...overrides,
  });
}

async function writeArtifacts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-budget-'));
  const artifacts = ['PotERC20', 'PotERC721', 'PotRegistry'].map((name) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ deployedBytecode: '0x60016001', abi: [] }));
    return { name, file, maxSizeBytes: 10240 };
  });
  return { dir, artifacts };
}

test('deploy mode with a zero floor computes the whole-release budget and passes at exactly sufficient funds', async () => {
  const { dir, artifacts } = await writeArtifacts();
  try {
    const deploymentGas = WHOLE_RELEASE_ESTIMATES.PotERC20 + WHOLE_RELEASE_ESTIMATES.PotERC721 + WHOLE_RELEASE_ESTIMATES.PotRegistry;
    const deploymentWei = deploymentGas * GAS_PRICE;
    const bindingWei = WHOLE_RELEASE_ESTIMATES.PotRegistry * 2n * GAS_PRICE;
    const subtotal = deploymentWei + bindingWei;
    const required = subtotal + ceilDiv(subtotal * 20n, 100n);
    const config = passingConfig({
      requiredTpot: 0n, // no floor: the computed budget must dominate
      artifacts,
      outstandingArtifacts: artifacts,
      bindingReserveCount: 2,
      bindingReserveArtifact: artifacts[2],
    });
    const result = await runReleasePreflight(config, wholeReleaseProbes([], {
      evmBalance: async () => required,
      nativeFreeBalance: async () => ceilDiv(required, WEI_PER_NATIVE_UNIT),
    }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    const budgetRow = result.checks.find((check) => check.name === 'release budget (whole release)');
    assert.equal(budgetRow.pass, true);
    assert.match(budgetRow.detail, /binding reserve 2 x/);
    assert.match(budgetRow.detail, /\+20% margin/);
    assert.equal(result.budget.requiredEvmWei, required);
    assert.equal(result.budget.requiredNativeUnits, ceilDiv(required, WEI_PER_NATIVE_UNIT));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy mode aborts one base unit below the computed whole-release requirement', async () => {
  const { dir, artifacts } = await writeArtifacts();
  try {
    const deploymentGas = WHOLE_RELEASE_ESTIMATES.PotERC20 + WHOLE_RELEASE_ESTIMATES.PotERC721 + WHOLE_RELEASE_ESTIMATES.PotRegistry;
    const deploymentWei = deploymentGas * GAS_PRICE;
    const bindingWei = WHOLE_RELEASE_ESTIMATES.PotRegistry * 2n * GAS_PRICE;
    const subtotal = deploymentWei + bindingWei;
    const required = subtotal + ceilDiv(subtotal * 20n, 100n);
    const config = passingConfig({
      requiredTpot: 0n,
      artifacts,
      outstandingArtifacts: artifacts,
      bindingReserveCount: 2,
      bindingReserveArtifact: artifacts[2],
    });
    const result = await runReleasePreflight(config, wholeReleaseProbes([], {
      evmBalance: async () => required - 1n,
      nativeFreeBalance: async () => ceilDiv(required, WEI_PER_NATIVE_UNIT),
    }));
    assert.equal(result.ok, false);
    const evmRow = result.checks.find((check) => check.name.startsWith('funding (EVM ledger'));
    assert.match(evmRow.detail, /short 0\.000000000000000001 tPOT/);
    const nativeRow = result.checks.find((check) => check.name.startsWith('funding (native ledger'));
    assert.equal(nativeRow.pass, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the allowed floor raises the computed whole-release requirement', async () => {
  const { dir, artifacts } = await writeArtifacts();
  try {
    const deploymentGas = WHOLE_RELEASE_ESTIMATES.PotERC20 + WHOLE_RELEASE_ESTIMATES.PotERC721 + WHOLE_RELEASE_ESTIMATES.PotRegistry;
    const deploymentWei = deploymentGas * GAS_PRICE;
    const bindingWei = WHOLE_RELEASE_ESTIMATES.PotRegistry * 2n * GAS_PRICE;
    const subtotal = deploymentWei + bindingWei;
    const required = subtotal + ceilDiv(subtotal * 20n, 100n);
    const config = passingConfig({
      requiredTpot: ceilDiv(required * 2n, 10n ** 18n), // a floor far above the computed budget
      artifacts,
      outstandingArtifacts: artifacts,
      bindingReserveCount: 2,
      bindingReserveArtifact: artifacts[2],
    });
    const result = await runReleasePreflight(config, wholeReleaseProbes([], {
      evmBalance: async () => required, // would cover the computed budget only
    }));
    assert.equal(result.ok, false);
    assert.equal(result.budget.floorApplied, true);
    const evmRow = result.checks.find((check) => check.name.startsWith('funding (EVM ledger'));
    assert.match(evmRow.detail, /short/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed gas-price read keeps the whole-release budget fail-closed without any funding row passing', async () => {
  const result = await runReleasePreflight(passingConfig(), passingProbes([], {
    gasPrice: async () => { throw new Error('the RPC provided no gas price (fee unavailable)'); },
  }));
  assert.equal(result.ok, false);
  const budgetRow = result.checks.find((check) => check.name === 'release budget (whole release)');
  assert.equal(budgetRow.pass, false);
  assert.match(budgetRow.detail, /no gas price/);
  assert.ok(result.failures.includes('funding (both ledgers)'));
});

test('a required binding reserve without an artifact to bound it is refused', async () => {
  const { dir, artifacts } = await writeArtifacts();
  try {
    const config = passingConfig({
      requiredTpot: 0n,
      artifacts,
      outstandingArtifacts: artifacts,
      bindingReserveCount: 2,
      bindingReserveArtifact: undefined,
    });
    const result = await runReleasePreflight(config, wholeReleaseProbes());
    assert.equal(result.ok, false);
    assert.match(
      result.checks.find((check) => check.name === 'release budget (whole release)').detail,
      /unbounded binding reserve/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Bind mode: the remaining-phase budget ---

const REGISTRY_ADDR = `0x${'cd'.repeat(20)}`;
const TOKEN_ERC20 = `0x${'11'.repeat(20)}`;
const TOKEN_ERC721 = `0x${'22'.repeat(20)}`;

function bindConfig(overrides = {}) {
  const registryFile = overrides.registryFile;
  return {
    mode: 'bind',
    expectedChainId: 420420777,
    deployerEvm: DEPLOYER_EVM,
    identityEvm: DEPLOYER_EVM,
    nativeAccount: { hex: ACCOUNT_HEX, ss58: ACCOUNT_SS58 },
    nativeAccountHash: COMMITMENT,
    commitmentSource: 'derived',
    networkName: 'portaldotTestnet',
    record: { network: 'portaldotTestnet', chainId: 420420777, deployer: DEPLOYER_EVM, contracts: {}, tokens: {}, bindings: [] },
    registryAddress: REGISTRY_ADDR,
    tokenAddresses: { erc20: TOKEN_ERC20, erc721: TOKEN_ERC721 },
    outstandingCalls: [
      { label: 'erc20', token: TOKEN_ERC20, to: REGISTRY_ADDR, data: `0x${'dd'.repeat(32)}` },
      { label: 'erc721', token: TOKEN_ERC721, to: REGISTRY_ADDR, data: `0x${'ee'.repeat(32)}` },
    ],
    nativeObjects: [
      { kind: 'asset', id: 1 },
      { kind: 'nft_collection', id: 2 },
    ],
    requireDualCounterparts: true,
    artifacts: registryFile ? [{ name: 'PotRegistry', file: registryFile, maxSizeBytes: 10240 }] : [],
    feeMarginPercent: 20,
    gasLimitRaw: null,
    registryFile: undefined,
    ...overrides,
  };
}

function bindProbes(record = [], overrides = {}) {
  return passingProbes(record, {
    // Deliberately modest balances: far below any whole-release requirement,
    // yet sufficient for the outstanding binds. Binding must never demand
    // the original deployment budget again.
    evmBalance: async () => 500n * 10n ** 18n,
    nativeFreeBalance: async () => 500n * 10n ** 14n,
    estimateCall: async ({ to, data, from }) => BIND_ESTIMATE,
    ...overrides,
  });
}

test('bind mode budgets only the outstanding calls and accepts a balance far below the whole-release requirement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-bind-'));
  try {
    const registryFile = path.join(dir, 'registry.json');
    fs.writeFileSync(registryFile, JSON.stringify({ deployedBytecode: '0x60016001', abi: [] }));
    const subtotal = 2n * BIND_ESTIMATE * GAS_PRICE;
    const expectedRequired = subtotal + ceilDiv(subtotal * 20n, 100n);
    // 2,000 tPOT: enough for the remaining bindings, far below the whole
    // release (deployment + bindings + margin, ~2,549 tPOT measured).
    const result = await runReleasePreflight(bindConfig({ registryFile }), bindProbes([], {
      evmBalance: async () => 2_000n * 10n ** 18n,
      nativeFreeBalance: async () => 2_000n * 10n ** 14n,
    }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.budget.bindingBudgetWei, subtotal);
    assert.equal(result.budget.requiredEvmWei, expectedRequired);
    const budgetRow = result.checks.find((check) => check.name === 'binding budget (remaining phase)');
    assert.match(budgetRow.detail, /2 outstanding bind call\(s\)/);
    // per-call gas plans for both outstanding binds
    assert.match(result.checks.find((check) => check.name === 'bind gas plan (erc20)').detail, /estimate 17000000000000000/);
    assert.ok(result.bindGasPlan.erc20 === (BIND_ESTIMATE * 120n) / 100n);
    assert.ok(result.bindGasPlan.erc721 === (BIND_ESTIMATE * 120n) / 100n);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bind mode halves the requirement when only one binding is outstanding (resume scenario)', async () => {
  const config = bindConfig({
    outstandingCalls: [{ label: 'erc721', token: TOKEN_ERC721, to: REGISTRY_ADDR, data: `0x${'ee'.repeat(32)}` }],
  });
  const subtotal = BIND_ESTIMATE * GAS_PRICE;
  const expectedRequired = subtotal + ceilDiv(subtotal * 20n, 100n);
  // 600 tPOT would never cover the whole release but covers one binding.
  const result = await runReleasePreflight(config, bindProbes([], {
    evmBalance: async () => 600n * 10n ** 18n,
    nativeFreeBalance: async () => 600n * 10n ** 14n,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.budget.bindingBudgetWei, subtotal);
  assert.equal(result.budget.requiredEvmWei, expectedRequired);
  assert.match(result.checks.find((check) => check.name === 'binding budget (remaining phase)').detail, /1 outstanding bind call\(s\)/);
});

test('bind mode fails closed when a bind-call estimate fails', async () => {
  const result = await runReleasePreflight(bindConfig(), bindProbes([], {
    estimateCall: async () => { throw new Error('eth_estimateGas failed for the call: simulation rejected'); },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('binding budget (remaining phase)'));
  assert.ok(result.failures.includes('funding (both ledgers)'));
});

test('bind mode verifies the deployment record identity before anything is signed', async () => {
  const result = await runReleasePreflight(
    bindConfig({ record: { network: 'portaldotTestnet', chainId: 420420777, deployer: `0x${'99'.repeat(20)}`, contracts: {}, tokens: {}, bindings: [] } }),
    bindProbes()
  );
  assert.equal(result.ok, false);
  const row = result.checks.find((check) => check.name === 'deployment record identity (network, chainId, deployer)');
  assert.equal(row.pass, false);
  assert.match(row.detail, /does not match the binding identity/);
});

test('bind mode rejects a wrong-record network and chainId', async () => {
  for (const broken of [
    { network: 'otherNet', chainId: 420420777 },
    { network: 'portaldotTestnet', chainId: 5 },
  ]) {
    const result = await runReleasePreflight(
      bindConfig({ record: { ...broken, deployer: DEPLOYER_EVM } }),
      bindProbes()
    );
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes('deployment record identity (network, chainId, deployer)'));
  }
});

test('bind mode requires live bytecode at the registry and both tokens', async () => {
  const targets = { PotRegistry: REGISTRY_ADDR, PotERC20: TOKEN_ERC20, PotERC721: TOKEN_ERC721 };
  for (const target of Object.keys(targets)) {
    const result = await runReleasePreflight(bindConfig(), bindProbes([], {
      code: async (address) => address.toLowerCase() === String(targets[target]).toLowerCase() ? '0x' : '0x5bff',
    }));
    assert.equal(result.ok, false);
    assert.ok(result.failures.includes(`${target} bytecode present`));
  }
});

test('bind mode still fails when native counterpart configuration is incomplete', async () => {
  const result = await runReleasePreflight(
    bindConfig({ nativeObjects: [{ kind: 'asset', id: 1 }] }),
    bindProbes()
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('native counterparts configured'));
});
