import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertOptionSome,
  compareBinding,
  formatUnits,
  normalizeBindingValue,
  validateBindingEntry,
  validateDeploymentRecord,
  validateEvmAddress,
  validateNativeAccountHash,
  validateReceipt,
} from '../lib/validation.cjs';

const DEPLOYER_EVM = '0xf7eC65d11e35375A250e474059a917B537804142';
const SS58 = '5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8Y';

test('assertOptionSome accepts a runtime Option::Some', () => {
  const option = { isSome: true, isNone: false, toString: () => 'details' };
  assert.equal(assertOptionSome(option, 'native asset 1'), option);
});

test('assertOptionSome rejects Option::None as a missing object', () => {
  assert.throws(
    () => assertOptionSome({ isSome: false, isNone: true }, 'native asset 1'),
    /does not exist on chain \(runtime returned Option::None\)/
  );
});

test('assertOptionSome rejects missing, ambiguous and inconsistent results', () => {
  assert.throws(() => assertOptionSome(null, 'native asset 1'), /storage returned nothing/);
  assert.throws(() => assertOptionSome(undefined, 'native asset 1'), /storage returned nothing/);
  assert.throws(() => assertOptionSome('some details', 'native asset 1'), /ambiguous storage result/);
  // A plain object without Option flags must never pass as proof of existence.
  assert.throws(
    () => assertOptionSome({ toString: () => 'details', exists: 1 }, 'native asset 1'),
    /not a runtime Option/
  );
  // toString() output alone is NEVER existence proof.
  const toStringOnly = { toString: () => 'asset exists!' };
  assert.throws(() => assertOptionSome(toStringOnly, 'native asset 1'), /not a runtime Option/);
  assert.throws(
    () => assertOptionSome({ isSome: true, isNone: true }, 'native asset 1'),
    /inconsistent runtime Option flags/
  );
  assert.throws(
    () => assertOptionSome({ isSome: false, isNone: false }, 'native asset 1'),
    /inconsistent runtime Option flags/
  );
});

test('validateEvmAddress normalizes valid addresses and rejects SS58 inputs', () => {
  assert.equal(validateEvmAddress(DEPLOYER_EVM), DEPLOYER_EVM.toLowerCase());
  assert.equal(validateEvmAddress(DEPLOYER_EVM.toLowerCase()), DEPLOYER_EVM.toLowerCase());
  assert.equal(validateEvmAddress(DEPLOYER_EVM.slice(2)), DEPLOYER_EVM.toLowerCase());
  assert.throws(
    () => validateEvmAddress(SS58, 'POT_NATIVE_ACCOUNT'),
    /looks like an SS58 native account/
  );
  assert.throws(() => validateEvmAddress('', 'empty'), /not a valid EVM address/);
  assert.throws(() => validateEvmAddress('0x1234'), /not a valid EVM address/);
  assert.throws(() => validateEvmAddress('0xzz...'), /not a valid EVM address/);
  assert.throws(() => validateEvmAddress(12345, 'number'), /of type number/);
});

test('validateNativeAccountHash requires a 32-byte hex value', () => {
  assert.equal(validateNativeAccountHash(`0x${'ab'.repeat(32)}`), `0x${'ab'.repeat(32)}`);
  assert.equal(validateNativeAccountHash('ab'.repeat(32)), `0x${'ab'.repeat(32)}`);
  assert.equal(validateNativeAccountHash('AB'.repeat(32)), `0x${'ab'.repeat(32)}`);
  assert.throws(() => validateNativeAccountHash('0x' + 'ab'.repeat(31)), /not a 32-byte SHA-256 value/);
  assert.throws(() => validateNativeAccountHash(''), /not a 32-byte/);
  assert.throws(() => validateNativeAccountHash(42), /of type number/);
});

test('validateReceipt enforces status, presence and transaction-hash match', () => {
  assert.doesNotThrow(() => validateReceipt('0xabc', { transactionHash: '0xabc', status: 1 }));
  assert.throws(() => validateReceipt('0xabc', null), /receipt not found/);
  assert.throws(() => validateReceipt('0xabc', undefined), /receipt not found/);
  assert.throws(() => validateReceipt('0xabc', { transactionHash: '0xabc', status: 0 }), /failed with status 0/);
  assert.throws(() => validateReceipt('0xabc', { transactionHash: '0xdef', status: 1 }), /hash mismatch/);
  assert.throws(() => validateReceipt('0xabc', { status: 1 }), /hash mismatch/);
  assert.throws(() => validateReceipt('0xabc', 'weird'), /unexpected receipt/);
});

test('formatUnits renders base units without precision loss', () => {
  assert.equal(formatUnits(1350n * 10n ** 14n, 14), '1350');
  assert.equal(formatUnits(1350n * 10n ** 14n - 5n, 14), '1349.99999999999995');
  assert.equal(formatUnits(0n, 18), '0');
  assert.equal(formatUnits(1n, 18), '0.000000000000000001');
  assert.equal(formatUnits(123456789n, 18), '0.000000000123456789');
  assert.equal(formatUnits(10_000n, 18), '0.00000000000001');
  // decimals 0 keeps the exact integer; 2^200 is far beyond Number precision
  assert.equal(
    formatUnits(2n ** 200n, 0),
    '1606938044258990275541962092341162602522202993782792835301376'
  );
});

const bindingFixture = () => ({
  token: DEPLOYER_EVM,
  tokenKind: 0,
  nativeKind: 1,
  nativeId: 7,
  nativeDecimals: 14,
  evmDecimals: 18,
  conversionFactor: '10000',
  nativeAccountHash: `0x${'ab'.repeat(32)}`,
  active: true,
});

test('compareBinding accepts an identical on-chain binding', () => {
  const actual = {
    token: bindingFixture().token,
    tokenKind: 0n,
    nativeKind: 1n,
    nativeId: 7n,
    nativeDecimals: 14n,
    evmDecimals: 18n,
    conversionFactor: 10000n,
    registeredAt: 123n,
    nativeAccountHash: bindingFixture().nativeAccountHash,
    active: true,
  };
  assert.deepEqual(compareBinding(bindingFixture(), actual), []);
});

test('compareBinding lists every field mismatch', () => {
  const actual = {
    token: bindingFixture().token,
    tokenKind: 1n,
    nativeKind: 2n,
    nativeId: 9n,
    nativeDecimals: 0n,
    evmDecimals: 0n,
    conversionFactor: 1n,
    nativeAccountHash: `0x${'cd'.repeat(32)}`,
    active: false,
  };
  const mismatches = compareBinding(bindingFixture(), actual);
  assert.equal(mismatches.length, 8);
  assert.ok(mismatches.includes('nativeId: expected 7, on-chain 9'));
  assert.ok(mismatches.includes('active: expected true, on-chain false'));
});

test('compareBinding rejects malformed actual values', () => {
  const actual = { ...bindingFixture(), conversionFactor: 'not-a-number' };
  assert.throws(() => compareBinding(bindingFixture(), actual), /is not a decimal integer/);
  const noBoolean = { ...bindingFixture(), active: 'true' };
  assert.throws(() => compareBinding(bindingFixture(), noBoolean), /is not a boolean/);
});

test('normalizeBindingValue handles numbers, strings and BigInts consistently', () => {
  assert.equal(normalizeBindingValue('nativeId', '7'), 7n);
  assert.equal(normalizeBindingValue('nativeId', 7), 7n);
  assert.equal(normalizeBindingValue('nativeId', 7n), 7n);
  assert.equal(
    normalizeBindingValue('nativeAccountHash', 'AB'.repeat(32)),
    `0x${'ab'.repeat(32)}`
  );
  assert.throws(() => normalizeBindingValue('nativeId', -1), /non-negative integer|Must be/);
});

test('validateBindingEntry requires every documented field', () => {
  const entry = { ...bindingFixture(), txHash: `0x${'11'.repeat(32)}`, blockNumber: 42, status: 'confirmed' };
  assert.doesNotThrow(() => validateBindingEntry(entry));
  const { txHash, ...missingEvidence } = entry;
  assert.doesNotThrow(() => validateBindingEntry(missingEvidence));
  for (const field of ['token', 'nativeId', 'nativeAccountHash', 'active']) {
    const hole = { ...bindingFixture() };
    delete hole[field];
    assert.throws(() => validateBindingEntry(hole), /is missing field/);
  }
  const badTx = { ...entry, txHash: 'not-a-hash' };
  assert.throws(() => validateBindingEntry(badTx), /txHash is not a transaction hash/);
});

test('validateDeploymentRecord rejects malformed records fail-closed', () => {
  assert.doesNotThrow(() => validateDeploymentRecord(validRecord()));
  assert.throws(() => validateDeploymentRecord(null), /is not an object/);
  assert.throws(() => validateDeploymentRecord([]), /is not an object/);
  assert.throws(() => validateDeploymentRecord({ network: 'x', chainId: 420420777 }), /no contracts table/);
  const noChain = validRecord();
  noChain.chainId = 1;
  assert.throws(() => validateDeploymentRecord(noChain), /chainId is not 420420777/);
  const badTx = validRecord();
  badTx.contracts.PotERC20.txHash = '0x1234';
  assert.throws(() => validateDeploymentRecord(badTx), /txHash is not a 32-byte transaction hash/);
  const badAddress = validRecord();
  badAddress.contracts.PotERC20.address = SS58;
  assert.throws(() => validateDeploymentRecord(badAddress), /EVM address/);
  const noBindings = validRecord();
  noBindings.bindings = 'sure';
  assert.throws(() => validateDeploymentRecord(noBindings), /bindings is not an array/);
  const noTokens = validRecord();
  noTokens.tokens = null;
  assert.throws(() => validateDeploymentRecord(noTokens), /no tokens table/);
});

test('validateDeploymentRecord accepts pending, per-transaction entries and partial records', () => {
  // A resumable record written immediately after the first send: the first
  // contract is pending (txHash only), the others are not present yet.
  const pending = validRecord();
  pending.contracts = {
    PotERC20: {
      txHash: `0x${'11'.repeat(32)}`,
      gasLimit: '1000',
      status: 'pending',
    },
  };
  pending.tokens = {};
  assert.doesNotThrow(() => validateDeploymentRecord(pending));

  // A partial record with one confirmed contract: valid, resume-usable.
  const partial = validRecord();
  partial.contracts = {
    PotERC20: {
      address: '0x0000000000000000000000000000000000000001',
      txHash: `0x${'11'.repeat(32)}`,
      blockNumber: 1,
      status: 'confirmed',
    },
  };
  partial.tokens = { erc20: { address: '0x0000000000000000000000000000000000000001', name: 'a', symbol: 'POT', decimals: 18 } };
  assert.doesNotThrow(() => validateDeploymentRecord(partial));

  // Legacy records without a status field behave as confirmed entries.
  const legacy = validRecord();
  delete legacy.contracts.PotERC20.status;
  assert.doesNotThrow(() => validateDeploymentRecord(legacy));
});

test('validateDeploymentRecord still rejects malformed pending entries', () => {
  // pending without any txHash is invalid: the record entry is written with
  // the transaction hash the moment the transaction is sent.
  const missingHash = validRecord();
  missingHash.contracts = { PotERC20: { status: 'pending' } };
  missingHash.tokens = {};
  assert.throws(() => validateDeploymentRecord(missingHash), /txHash is not a 32-byte transaction hash/);

  // An invalid status aborts.
  const badStatus = validRecord();
  badStatus.contracts.PotERC20.status = 'maybe';
  assert.throws(() => validateDeploymentRecord(badStatus), /invalid status/);

  // A confirmed entry without an address aborts.
  const noAddress = validRecord();
  noAddress.contracts.PotERC20 = { txHash: `0x${'11'.repeat(32)}`, status: 'confirmed' };
  assert.throws(() => validateDeploymentRecord(noAddress), /address is required for a confirmed entry/);

  // Pending entries may carry a valid address (recovered from chain), but a
  // malformed one is never accepted.
  const badPendingAddress = validRecord();
  badPendingAddress.contracts = { PotERC20: { address: 'nope', txHash: `0x${'11'.repeat(32)}`, status: 'pending' } };
  badPendingAddress.tokens = {};
  assert.throws(() => validateDeploymentRecord(badPendingAddress), /EVM address/);

  // Negative or fractional blockNumbers abort.
  const badBlock = validRecord();
  badBlock.contracts.PotERC20.blockNumber = -1;
  assert.throws(() => validateDeploymentRecord(badBlock), /blockNumber/);
});

function validRecord() {
  return {
    network: 'portaldotTestnet',
    chainId: 420420777,
    deployer: DEPLOYER_EVM,
    deployedAt: '2026-10-25T00:00:00.000Z',
    contracts: {
      PotERC20: { address: '0x0000000000000000000000000000000000000001', txHash: `0x${'11'.repeat(32)}`, blockNumber: 1 },
      PotERC721: { address: '0x0000000000000000000000000000000000000002', txHash: `0x${'22'.repeat(32)}`, blockNumber: 2 },
      PotRegistry: { address: '0x0000000000000000000000000000000000000003', txHash: `0x${'33'.repeat(32)}`, blockNumber: 3 },
    },
    tokens: {
      erc20: { address: '0x0000000000000000000000000000000000000001', name: 'a', symbol: 'POT', decimals: 18 },
      erc721: { address: '0x0000000000000000000000000000000000000002', name: 'b', symbol: 'POTC' },
    },
    bindings: [],
  };
}
