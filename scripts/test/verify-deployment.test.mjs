import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compareBinding, validateBindingEntry } from '../lib/validation.cjs';
import { deploymentFilePath, classifyReleasePhase } from '../verify-deployment.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOYER_EVM = '0xf7eC65d11e35375A250e474059a917B537804142';

test('the verifier source path honours POT_DEPLOYMENTS and the network default', () => {
  process.env.PORTALDOT_NETWORK = 'portaldotTestnet';
  delete process.env.POT_DEPLOYMENTS;
  assert.equal(
    path.resolve(deploymentFilePath()).toLowerCase(),
    path.resolve(root, 'deployments', 'portaldotTestnet.json').toLowerCase()
  );
  process.env.POT_DEPLOYMENTS = 'deployments/custom.json';
  assert.equal(
    path.resolve(deploymentFilePath()).toLowerCase(),
    path.resolve(root, 'deployments', 'custom.json').toLowerCase()
  );
  delete process.env.POT_DEPLOYMENTS;
});

test('a recorded binding that matches on-chain state passes every required field', () => {
  const expected = {
    token: DEPLOYER_EVM.toLowerCase(),
    tokenKind: 0,
    nativeKind: 1,
    nativeId: 1,
    nativeDecimals: 14,
    evmDecimals: 18,
    conversionFactor: '10000',
    nativeAccountHash: `0x${'ab'.repeat(32)}`,
    active: true,
    txHash: `0x${'11'.repeat(32)}`,
    blockNumber: 42,
    status: 'confirmed',
  };
  const onChain = {
    token: DEPLOYER_EVM.toLowerCase(),
    tokenKind: 0n,
    nativeKind: 1n,
    nativeId: 1n,
    nativeDecimals: 14n,
    evmDecimals: 18n,
    conversionFactor: 10000n,
    nativeAccountHash: `0x${'ab'.repeat(32)}`,
    registeredAt: 1n,
    active: true,
  };
  assert.doesNotThrow(() => validateBindingEntry(expected));
  assert.deepEqual(compareBinding(expected, onChain), []);
});

test('a binding that mismatches its configured id, decimals, factor or active state fails', () => {
  const expected = {
    token: DEPLOYER_EVM.toLowerCase(),
    tokenKind: 0,
    nativeKind: 1,
    nativeId: 1,
    nativeDecimals: 14,
    evmDecimals: 18,
    conversionFactor: '10000',
    nativeAccountHash: `0x${'ab'.repeat(32)}`,
    active: true,
  };

  // on-chain binding was re-registered against a different native id
  const rebound = { ...toStruct(onChainBinding()), nativeId: 2n };
  assert.deepEqual(compareBinding(expected, rebound), ['nativeId: expected 1, on-chain 2']);

  // the decimal configuration was tampered with (evmDecimals no longer 18)
  const wrongDecimals = { ...toStruct(onChainBinding()), evmDecimals: 0n };
  assert.ok(compareBinding(expected, wrongDecimals).some((mismatch) => mismatch.startsWith('evmDecimals')));

  // the conversion factor no longer matches the decimals
  const wrongFactor = { ...toStruct(onChainBinding()), conversionFactor: 100n };
  assert.ok(compareBinding(expected, wrongFactor).some((mismatch) => mismatch.startsWith('conversionFactor')));

  // the binding was unbound on chain
  const inactive = { ...toStruct(onChainBinding()), active: false, token: '0x0000000000000000000000000000000000000000' };
  assert.ok(compareBinding(expected, inactive).some((mismatch) => mismatch.startsWith('active:')));
});

function onChainBinding() {
  return {
    token: DEPLOYER_EVM.toLowerCase(),
    tokenKind: 0n,
    nativeKind: 1n,
    nativeId: 1n,
    nativeDecimals: 14n,
    evmDecimals: 18n,
    conversionFactor: 10000n,
    nativeAccountHash: `0x${'ab'.repeat(32)}`,
    registeredAt: 1n,
    active: true,
  };
}

function toStruct(binding) {
  // simulates the raw ethers struct result minus typed array extras
  return { ...binding };
}

// --- Release-phase classification (mission 006.2 §5) ---

const baseLifecycle = {
  recordPresent: true,
  recordValid: true,
  contractsComplete: true,
  contractsPending: 0,
  contractsVerified: true,
  bindingsRecorded: 2,
  bindingsVerified: 2,
  bindingsMissingOnChain: 0,
  bindingsMismatched: 0,
  bindingsUntrackedOnChain: 0,
  unboundAcknowledged: false,
  otherFailures: 0,
};

test('classifyReleasePhase labels the complete dual-ledger release', () => {
  const { phase, phaseSummary } = classifyReleasePhase(baseLifecycle);
  assert.equal(phase, 'complete');
  assert.match(phaseSummary, /complete/);
});

test('classifyReleasePhase distinguishes every documented lifecycle state', () => {
  // no record
  assert.equal(classifyReleasePhase({ ...baseLifecycle, recordPresent: false }).phase, 'unusable');
  // malformed record
  assert.equal(classifyReleasePhase({ ...baseLifecycle, recordValid: false }).phase, 'unusable');
  // some required contracts not recorded yet
  const partial = classifyReleasePhase({ ...baseLifecycle, contractsComplete: false });
  assert.equal(partial.phase, 'partialDeployment');
  assert.match(partial.phaseSummary, /resumed/);
  // pending (post-crash) record entry: ambiguous outcome, never success
  const pending = classifyReleasePhase({ ...baseLifecycle, contractsPending: 1 });
  assert.equal(pending.phase, 'unconfirmed');
  assert.match(pending.phaseSummary, /pending|ambiguous/);
  // receipt/bytecode checks failed on chain
  assert.equal(classifyReleasePhase({ ...baseLifecycle, contractsVerified: false }).phase, 'unconfirmed');
  // recorded binding exists but mismatches configured values
  const mismatch = classifyReleasePhase({ ...baseLifecycle, bindingsMismatched: 1, bindingsVerified: 1 });
  assert.equal(mismatch.phase, 'configurationMismatch');
  // completed binding missing from the record (record write/verification failed)
  const untracked = classifyReleasePhase({ ...baseLifecycle, bindingsUntrackedOnChain: 1 });
  assert.equal(untracked.phase, 'bindingNotRecorded');
  assert.match(untracked.phaseSummary, /rerunning bind/);
  // deployment verified but no binding intent
  assert.equal(classifyReleasePhase({ ...baseLifecycle, bindingsRecorded: 0, bindingsVerified: 0 }).phase, 'bindingsMissing');
  // recorded bindings absent on chain
  const absent = classifyReleasePhase({ ...baseLifecycle, bindingsMissingOnChain: 1, bindingsVerified: 1 });
  assert.equal(absent.phase, 'bindingsMissing');
  // deliberate unbound release is distinct from a complete release
  const unbound = classifyReleasePhase({
    ...baseLifecycle,
    bindingsRecorded: 0,
    bindingsVerified: 0,
    unboundAcknowledged: true,
  });
  assert.equal(unbound.phase, 'deploymentOnly');
  assert.match(unbound.phaseSummary, /unbound/);
});

test('classifyReleasePhase never labels a release with generic failures as complete:ok', () => {
  const degraded = classifyReleasePhase({ ...baseLifecycle, otherFailures: 1 });
  assert.equal(degraded.phase, 'degradedVerification');
  assert.match(degraded.phaseSummary, /not ok/);
});

test('classifyReleasePhase is defensive against unusable state shapes', () => {
  assert.equal(classifyReleasePhase(null).phase, 'unusable');
  assert.equal(classifyReleasePhase(undefined).phase, 'unusable');
});
