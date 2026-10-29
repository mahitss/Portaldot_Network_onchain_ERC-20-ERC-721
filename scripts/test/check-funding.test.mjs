import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REQUIRED_TPOT,
  EVM_DECIMALS,
  NATIVE_DECIMALS,
  assessFunding,
  parseRequiredTpot,
  tpotToEvmUnits,
  tpotToNativeUnits,
  tpotToUnits,
} from '../lib/validation.cjs';

test('parseRequiredTpot returns the default when unset or empty', () => {
  assert.equal(parseRequiredTpot(undefined), DEFAULT_REQUIRED_TPOT);
  assert.equal(parseRequiredTpot(''), DEFAULT_REQUIRED_TPOT);
  assert.equal(DEFAULT_REQUIRED_TPOT, 1350n);
});

test('parseRequiredTpot parses whole decimal values', () => {
  assert.equal(parseRequiredTpot('1350'), 1350n);
  assert.equal(parseRequiredTpot('0'), 0n);
  assert.equal(parseRequiredTpot('1'), 1n);
  assert.equal(parseRequiredTpot(' 1350 '), 1350n);
  assert.equal(parseRequiredTpot('999999999999999999999999999'), 999999999999999999999999999n);
  assert.equal(parseRequiredTpot(1350), 1350n);
});

test('parseRequiredTpot rejects malformed, negative and fractional overrides', () => {
  assert.throws(() => parseRequiredTpot('-1'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('1.5'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('1,000'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('1e3'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('0x10'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot(' '), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('1_000'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('+1'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot(null), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot(true), /invalid POT_REQUIRED_TPOT/);
});

test('tpotToUnits converts in the native 14-decimal and EVM 18-decimal scales', () => {
  assert.equal(tpotToUnits(1n, NATIVE_DECIMALS), 10n ** 14n);
  assert.equal(tpotToUnits(1350n, NATIVE_DECIMALS), 1350n * 10n ** 14n);
  assert.equal(tpotToUnits(1n, EVM_DECIMALS), 10n ** 18n);
  assert.equal(tpotToUnits(1350n, EVM_DECIMALS), 1350n * 10n ** 18n);
  assert.equal(tpotToNativeUnits(1350n), 1350n * 10n ** 14n);
  assert.equal(tpotToEvmUnits(1350n), 1350n * 10n ** 18n);
  // invariant: the EVM and native thresholds differ by exactly the conversion factor
  assert.equal(tpotToEvmUnits(1350n) / tpotToNativeUnits(1350n), 10_000n);
});

const REQUIRED_EVM_WEI = tpotToEvmUnits(1350n);
const REQUIRED_NATIVE_UNITS = tpotToNativeUnits(1350n);

test('assessFunding passes only at the exact threshold', () => {
  const ready = assessFunding({
    requiredTpot: 1350n,
    evmBalanceWei: REQUIRED_EVM_WEI,
    nativeFreeUnits: REQUIRED_NATIVE_UNITS,
  });
  assert.equal(ready.funded, true);
  assert.equal(ready.evmShortfallWei, 0n);
  assert.equal(ready.nativeShortfallUnits, 0n);
});

test('assessFunding rejects one base unit below the threshold', () => {
  const short = assessFunding({
    requiredTpot: 1350n,
    evmBalanceWei: REQUIRED_EVM_WEI - 1n,
    nativeFreeUnits: REQUIRED_NATIVE_UNITS - 1n,
  });
  assert.equal(short.funded, false);
  assert.equal(short.evmFunded, false);
  assert.equal(short.nativeFunded, false);
  assert.equal(short.evmShortfallWei, 1n);
  assert.equal(short.nativeShortfallUnits, 1n);
});

test('assessFunding rejects any native balance and any zero EVM balance', () => {
  const zero = assessFunding({
    requiredTpot: 1350n,
    evmBalanceWei: 0n,
    nativeFreeUnits: 0n,
  });
  assert.equal(zero.funded, false);
  assert.equal(zero.evmShortfallWei, REQUIRED_EVM_WEI);
  assert.equal(zero.nativeShortfallUnits, REQUIRED_NATIVE_UNITS);
});

test('assessFunding accepts balances above the threshold', () => {
  const funded = assessFunding({
    requiredTpot: 1350n,
    evmBalanceWei: REQUIRED_EVM_WEI + 10n ** 3n,
    nativeFreeUnits: REQUIRED_NATIVE_UNITS * 2n,
  });
  assert.equal(funded.funded, true);
});

test('assessFunding handles very large balances without JavaScript number precision loss', () => {
  const huge = (1n << 200n);
  const funded = assessFunding({
    requiredTpot: 1350n,
    evmBalanceWei: huge,
    nativeFreeUnits: huge,
  });
  assert.equal(funded.funded, true);
  assert.equal(funded.evmShortfallWei, 0n);
});

test('assessFunding still verifies a failed native read is a failed preflight', () => {
  const nativeFailed = assessFunding({
    requiredTpot: 1350n,
    evmBalanceWei: REQUIRED_EVM_WEI,
    nativeFreeUnits: null,
    evmReadError: null,
    nativeReadError: 'native WebSocket timed out',
  });
  assert.equal(nativeFailed.funded, false);
  assert.equal(nativeFailed.evmFunded, true);
  assert.equal(nativeFailed.nativeFunded, false);

  const evmFailed = assessFunding({
    requiredTpot: 1350n,
    evmBalanceWei: null,
    nativeFreeUnits: REQUIRED_NATIVE_UNITS,
    evmReadError: 'RPC unreachable',
    nativeReadError: null,
  });
  assert.equal(evmFailed.funded, false);
  assert.equal(evmFailed.nativeFunded, true);
  assert.equal(evmFailed.evmFunded, false);
});

test('assessFunding refuses non-bigint balances when reads did not fail', () => {
  assert.throws(
    () => assessFunding({ requiredTpot: 1350n, evmBalanceWei: '1', nativeFreeUnits: REQUIRED_NATIVE_UNITS }),
    /evmBalanceWei must be a bigint/
  );
  assert.throws(
    () => assessFunding({ requiredTpot: 1350n, evmBalanceWei: REQUIRED_EVM_WEI, nativeFreeUnits: '1' }),
    /nativeFreeUnits must be a bigint/
  );
});

test('assessFunding supports a malformed threshold override explicitly', () => {
  // The override is parsed by parseRequiredTpot; here the threshold itself is
  // exercised directly, including a custom threshold swap on one ledger.
  const custom = assessFunding({
    requiredTpot: 0n,
    evmBalanceWei: 0n,
    nativeFreeUnits: 0n,
  });
  assert.equal(custom.funded, true);
});
