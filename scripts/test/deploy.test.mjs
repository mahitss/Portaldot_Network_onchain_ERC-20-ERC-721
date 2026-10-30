import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateChainId,
  validateContractArtifact,
  validateGasLimit,
} from '../lib/validation.cjs';
import { buildPreflightConfig, loadArtifact } from '../deploy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOYER_EVM = '0xf7eC65d11e35375A250e474059a917B537804142';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-artifact-'));
}

function writeArtifact(dir, deployedBytecode) {
  const file = path.join(dir, 'artifact.json');
  fs.writeFileSync(file, JSON.stringify({ deployedBytecode, abi: [] }));
  return file;
}

test('validateContractArtifact accepts the real compiled artifacts', () => {
  for (const file of ['PotERC20.sol/PotERC20.json', 'PotERC721.sol/PotERC721.json', 'PotRegistry.sol/PotRegistry.json']) {
    const runtimeBytes = validateContractArtifact(path.join(root, 'artifacts', 'contracts', file), 10240);
    assert.ok(runtimeBytes > 0);
    assert.ok(runtimeBytes <= 10240);
  }
});

test('validateContractArtifact rejects oversized runtime bytecode', () => {
  const dir = tempDir();
  try {
    const artifactPath = writeArtifact(dir, `0x${'ff'.repeat(11000)}`);
    assert.throws(() => validateContractArtifact(artifactPath, 10240), /exceeds limit of 10240 bytes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateContractArtifact rejects missing and malformed artifacts', () => {
  const dir = tempDir();
  try {
    assert.throws(() => validateContractArtifact(path.join(dir, 'missing.json'), 10240), /cannot read contract artifact/);
    const malformed = writeArtifact(dir, 'not-bytecode');
    assert.throws(() => validateContractArtifact(malformed, 10240), /invalid or missing deployedBytecode/);
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    assert.throws(() => validateContractArtifact(path.join(dir, 'broken.json'), 10240), /cannot read contract artifact/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateChainId accepts the Portaldot V3 chain id and rejects others', () => {
  assert.doesNotThrow(() => validateChainId(420420777, 420420777));
  assert.doesNotThrow(() => validateChainId(420420777n, 420420777));
  assert.throws(() => validateChainId(1, 420420777), /wrong chain ID/);
  assert.throws(() => validateChainId(420420776, 420420777), /wrong chain ID/);
  assert.throws(() => validateChainId(0, 420420777), /wrong chain ID/);
  assert.throws(() => validateChainId('nope', 420420777), /invalid chain id/);
});

test('validateGasLimit requires a positive integer gas value as BigInt', () => {
  assert.equal(validateGasLimit('5000000'), 5_000_000n);
  assert.equal(validateGasLimit(5000000), 5_000_000n);
  assert.equal(validateGasLimit(5000000n), 5_000_000n);
  // The block gas limit observed on the live Portaldot V3 RPC exceeds 2^53,
  // so BigInt inputs must be preserved exactly.
  const blockLimit = 18446744073709551615n;
  assert.equal(validateGasLimit(blockLimit), blockLimit);
  assert.equal(validateGasLimit('18446744073709551615'), blockLimit);
});

test('validateGasLimit rejects invalid and unsafe values', () => {
  assert.throws(() => validateGasLimit(0), /invalid POT_GAS_LIMIT/);
  assert.throws(() => validateGasLimit(-1), /invalid POT_GAS_LIMIT/);
  assert.throws(() => validateGasLimit('-1'), /invalid POT_GAS_LIMIT/);
  assert.throws(() => validateGasLimit('0'), /invalid POT_GAS_LIMIT/);
  assert.throws(() => validateGasLimit('1.5'), /invalid POT_GAS_LIMIT/);
  assert.throws(() => validateGasLimit(1.5), /invalid POT_GAS_LIMIT/);
  assert.throws(() => validateGasLimit('abc'), /invalid POT_GAS_LIMIT/);
  assert.throws(() => validateGasLimit(''), /invalid POT_GAS_LIMIT/);
  assert.throws(() => validateGasLimit(undefined), /gas limit is required/);
  assert.throws(() => validateGasLimit(null), /gas limit is required/);
  assert.throws(() => validateGasLimit(2 ** 53), /invalid POT_GAS_LIMIT/);
});

const baseEnv = () => ({
  POT_NATIVE_ASSET_ID: '1',
  POT_NATIVE_NFT_ID: '2',
});

test('buildPreflightConfig builds a dual-ledger config with defaults', async () => {
  const config = await buildPreflightConfig({ env: baseEnv(), deployerAddress: DEPLOYER_EVM });
  assert.equal(config.expectedChainId, 420420777);
  assert.equal(config.deployerEvm, DEPLOYER_EVM.toLowerCase());
  assert.equal(config.requiredTpot, 1350n);
  assert.equal(config.commitmentSource, 'derived');
  // mapped account is H160 followed by twelve 0xEE bytes (24 hex chars)
  assert.match(config.nativeAccount.hex, /^0xf7ec65d11e35375a250e474059a917b537804142e{24}$/);
  assert.match(config.nativeAccount.ss58, /^5/);
  // the derived commitment is sha256 of the 32-byte account
  const expectedHash = `0x${createHash('sha256').update(Buffer.from(config.nativeAccount.hex.slice(2), 'hex')).digest('hex')}`;
  assert.equal(config.nativeAccountHash, expectedHash);
  assert.deepEqual(
    config.nativeObjects.map((object) => [object.kind, object.id]),
    [['asset', 1], ['nft_collection', 2]]
  );
  assert.equal(config.requireDualCounterparts, true);
  assert.equal(config.gasLimitRaw, null);
  assert.equal(config.artifacts.length, 3);
  // stage-aware budget configuration
  assert.equal(config.mode, 'deploy');
  assert.equal(config.feeMarginPercent, 20);
  assert.equal(config.bindingReserveCount, 2);
  assert.equal(config.bindingReserveArtifact.name, 'PotRegistry');
  assert.equal(config.outstandingArtifacts.length, 3);
});

test('buildPreflightConfig requires BOTH native counterparts explicitly', async () => {
  await assert.rejects(
    () => buildPreflightConfig({ env: { ...baseEnv(), POT_NATIVE_NFT_ID: undefined }, deployerAddress: DEPLOYER_EVM }),
    /missing POT_NATIVE_NFT_ID/
  );
  await assert.rejects(
    () => buildPreflightConfig({ env: { ...baseEnv(), POT_NATIVE_ASSET_ID: '' }, deployerAddress: DEPLOYER_EVM }),
    /missing POT_NATIVE_ASSET_ID/
  );
  await assert.rejects(
    () => buildPreflightConfig({ env: {}, deployerAddress: DEPLOYER_EVM }),
    /missing POT_NATIVE_ASSET_ID and POT_NATIVE_NFT_ID/
  );
});

test('buildPreflightConfig rejects malformed native ids and threshold overrides', async () => {
  await assert.rejects(
    () => buildPreflightConfig({ env: { ...baseEnv(), POT_NATIVE_ASSET_ID: 'x' }, deployerAddress: DEPLOYER_EVM }),
    /invalid POT_NATIVE_ASSET_ID/
  );
  await assert.rejects(
    () => buildPreflightConfig({ env: { ...baseEnv(), POT_NATIVE_NFT_ID: '4294967296' }, deployerAddress: DEPLOYER_EVM }),
    /invalid POT_NATIVE_NFT_ID/
  );
  await assert.rejects(
    () => buildPreflightConfig({ env: { ...baseEnv(), POT_REQUIRED_TPOT: '1.5' }, deployerAddress: DEPLOYER_EVM }),
    /invalid POT_REQUIRED_TPOT/
  );
  await assert.rejects(
    () => buildPreflightConfig({ env: { ...baseEnv(), POT_RELEASE_FEE_MARGIN_PCT: '-5' }, deployerAddress: DEPLOYER_EVM }),
    /invalid POT_RELEASE_FEE_MARGIN_PCT/
  );
  await assert.rejects(
    () => buildPreflightConfig({ env: { ...baseEnv(), POT_RELEASE_FEE_MARGIN_PCT: '150' }, deployerAddress: DEPLOYER_EVM }),
    /invalid POT_RELEASE_FEE_MARGIN_PCT/
  );
  const configured = await buildPreflightConfig({
    env: { ...baseEnv(), POT_RELEASE_FEE_MARGIN_PCT: '35', POT_REQUIRED_TPOT: '2000' },
    deployerAddress: DEPLOYER_EVM,
  });
  assert.equal(configured.feeMarginPercent, 35);
  assert.equal(configured.requiredTpot, 2000n);
});

test('buildPreflightConfig accepts an explicit commitment override', async () => {
  const config = await buildPreflightConfig({
    env: { ...baseEnv(), POT_NATIVE_ACCOUNT_HASH: `0x${'ab'.repeat(32)}` },
    deployerAddress: DEPLOYER_EVM,
  });
  assert.equal(config.commitmentSource, 'override');
  assert.equal(config.nativeAccountHash, `0x${'ab'.repeat(32)}`);
});

test('buildPreflightConfig never accepts an SS58 address as the EVM identity', async () => {
  await assert.rejects(
    () => buildPreflightConfig({ env: baseEnv(), deployerAddress: '5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8Y' }),
    /looks like an SS58 native account|not a valid EVM address/
  );
});

test('loadArtifact reports missing artifacts with compile guidance', () => {
  assert.throws(() => loadArtifact(path.join(root, 'artifacts', 'nope.json')), /cannot read contract artifact/);
});
