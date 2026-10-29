import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReleasePreflight } from '../lib/preflight.cjs';

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOYER_EVM = '0xf7eC65d11e35375A250e474059a917B537804142';
const ACCOUNT_HEX = '0xf7ec65d11e35375a250e474059a917b537804142eeeeeeeeeeeeeeeeeeeeeeee';
const ACCOUNT_SS58 = '5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8Y';
const COMMITMENT = `0x${createHash('sha256').update(Buffer.from(ACCOUNT_HEX.slice(2), 'hex')).digest('hex')}`;
const TPOT_EVM = 1350n * 10n ** 18n;
const TPOT_NATIVE = 1350n * 10n ** 14n;
const BLOCK_LIMIT = 18446744073709551615n;
const ESTIMATE = 1_000_000_000_000_000n;

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
    nativeObject: wrap('nativeObject', async (kind, id) => ({ kind, id, exists: true, details: 'fake object' })),
    blockGasLimit: wrap('blockGasLimit', async () => BLOCK_LIMIT),
    estimateCreationGas: wrap('estimateCreationGas', async () => ESTIMATE),
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
