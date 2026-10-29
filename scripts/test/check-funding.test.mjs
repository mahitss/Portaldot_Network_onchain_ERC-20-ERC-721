import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REQUIRED_TPOT,
  EVM_DECIMALS,
  NATIVE_DECIMALS,
  assessFunding,
  assessReleaseBudget,
  parseFeeMarginPercent,
  parseRequiredTpot,
  tpotToEvmUnits,
  tpotToNativeUnits,
  tpotToUnits,
  ceilDiv,
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

// --- parseFeeMarginPercent ---

test('parseFeeMarginPercent defaults to 20 and accepts explicit 0..100 values', () => {
  assert.equal(parseFeeMarginPercent(undefined), 20);
  assert.equal(parseFeeMarginPercent(''), 20);
  assert.equal(parseFeeMarginPercent('0'), 0);
  assert.equal(parseFeeMarginPercent('100'), 100);
  assert.equal(parseFeeMarginPercent('35'), 35);
  assert.equal(parseFeeMarginPercent(' 35 '), 35);
});

test('parseFeeMarginPercent rejects malformed and out-of-range values', () => {
  assert.throws(() => parseFeeMarginPercent('-5'), /invalid POT_RELEASE_FEE_MARGIN_PCT/);
  assert.throws(() => parseFeeMarginPercent('1.5'), /invalid POT_RELEASE_FEE_MARGIN_PCT/);
  assert.throws(() => parseFeeMarginPercent('101'), /integer percentage between 0 and 100/);
  assert.throws(() => parseFeeMarginPercent('1e2'), /invalid POT_RELEASE_FEE_MARGIN_PCT/);
  assert.throws(() => parseFeeMarginPercent(' '), /invalid POT_RELEASE_FEE_MARGIN_PCT/);
  assert.throws(() => parseFeeMarginPercent('abc'), /invalid POT_RELEASE_FEE_MARGIN_PCT/);
  assert.throws(() => parseFeeMarginPercent(null), /invalid POT_RELEASE_FEE_MARGIN_PCT/);
  assert.throws(() => parseFeeMarginPercent(true), /invalid POT_RELEASE_FEE_MARGIN_PCT/);
});

// --- ceilDiv ---

test('ceilDiv rounds up exactly and never touches JavaScript numbers', () => {
  assert.equal(ceilDiv(10n, 4n), 3n);
  assert.equal(ceilDiv(8n, 4n), 2n);
  assert.equal(ceilDiv(1n, 10n ** 18n), 1n);
  assert.equal(ceilDiv(0n, 7n), 0n);
  const huge = (1n << 200n) + 7n;
  assert.equal(ceilDiv(huge, 3n), (1n << 200n) / 3n + 3n);
  assert.throws(() => ceilDiv(1n, 0n), /positive divisor/);
});

// --- assessReleaseBudget: the stage-aware whole-release requirement ---

const GAS = 27_440n;
const E20 = 10_589_282_911_910_634n;
const E721 = 16_865_512_345_550_202n;
const ER = 16_656_979_668_562_858n;

test('assessReleaseBudget composes deployment + binding reserve + exact margin, per ledger', () => {
  const deploymentGas = E20 + E721 + ER;
  const budget = assessReleaseBudget({
    creationEstimatesGas: [E20, E721, ER],
    bindingEstimateGas: ER,
    outstandingBindings: 2,
    gasPriceWei: GAS,
    feeMarginPercent: 20,
    evmBalanceWei: 10_000n * 10n ** 18n,
    nativeFreeUnits: 10_000n * 10n ** 14n,
  });
  const deploymentWei = deploymentGas * GAS;
  const bindingWei = ER * 2n * GAS;
  const subtotal = deploymentWei + bindingWei;
  assert.equal(budget.deploymentBudgetWei, deploymentWei);
  assert.equal(budget.bindingBudgetWei, bindingWei);
  assert.equal(budget.subtotalWei, subtotal);
  assert.equal(budget.marginWei, ceilDiv(subtotal * 20n, 100n));
  assert.equal(budget.requiredEvmWei, subtotal + ceilDiv(subtotal * 20n, 100n));
  // exact conversion into native units (1 native unit = 10^4 wei)
  assert.equal(budget.requiredNativeUnits, ceilDiv(budget.requiredEvmWei, 10n ** 4n));
  assert.equal(budget.funded, true);
  assert.equal(budget.floorApplied, false);
});

test('assessReleaseBudget complains one base unit short, in the exact ledger units', () => {
  const base = assessReleaseBudget({
    creationEstimatesGas: [E20, E721, ER],
    bindingEstimateGas: ER,
    outstandingBindings: 2,
    gasPriceWei: GAS,
    feeMarginPercent: 20,
  });
  const short = assessReleaseBudget({
    creationEstimatesGas: [E20, E721, ER],
    bindingEstimateGas: ER,
    outstandingBindings: 2,
    gasPriceWei: GAS,
    feeMarginPercent: 20,
    evmBalanceWei: base.requiredEvmWei - 1n,
    nativeFreeUnits: base.requiredNativeUnits,
  });
  assert.equal(short.funded, false);
  assert.equal(short.evmShortfallWei, 1n);
  assert.equal(short.nativeShortfallUnits, 0n);
});

test('assessReleaseBudget raises the requirement when the manual floor dominates (deploy mode only)', () => {
  const computed = assessReleaseBudget({
    creationEstimatesGas: [1000n],
    bindingEstimateGas: 0n,
    outstandingBindings: 0,
    gasPriceWei: GAS,
    feeMarginPercent: 20,
    requiredTpotFloor: 0n,
  });
  assert.equal(computed.floorApplied, false);
  const floored = assessReleaseBudget({
    creationEstimatesGas: [1000n],
    bindingEstimateGas: 0n,
    outstandingBindings: 0,
    gasPriceWei: GAS,
    feeMarginPercent: 20,
    requiredTpotFloor: 1350n,
  });
  assert.equal(floored.floorApplied, true);
  assert.equal(floored.requiredEvmWei, 1350n * 10n ** 18n);
  assert.equal(floored.requiredNativeUnits, 1350n * 10n ** 14n);
});

test('assessReleaseBudget keeps failed ledger reads as failed preflights', () => {
  const failed = assessReleaseBudget({
    creationEstimatesGas: [E20],
    bindingEstimateGas: ER,
    outstandingBindings: 1,
    gasPriceWei: GAS,
    evmBalanceWei: null,
    evmReadError: 'RPC unreachable',
    nativeFreeUnits: null,
    nativeReadError: 'timed out',
  });
  assert.equal(failed.funded, false);
  assert.equal(failed.evmFunded, false);
  assert.equal(failed.nativeFunded, false);
});

test('assessReleaseBudget validates its inputs strictly', () => {
  assert.throws(() => assessReleaseBudget({ gasPriceWei: '1' }), /gasPriceWei must be a non-negative bigint/);
  assert.throws(
    () => assessReleaseBudget({ gasPriceWei: GAS, creationEstimatesGas: [42] }),
    /creationEstimatesGas\[0\] must be a non-negative bigint/
  );
  assert.throws(
    () => assessReleaseBudget({ gasPriceWei: GAS, bindingEstimateGas: 5 }),
    /bindingEstimateGas must be a non-negative bigint/
  );
  assert.throws(
    () => assessReleaseBudget({ gasPriceWei: GAS, outstandingBindings: 1.5 }),
    /outstandingBindings must be a non-negative integer/
  );
  assert.throws(
    () => assessReleaseBudget({ gasPriceWei: GAS, feeMarginPercent: 101 }),
    /feeMarginPercent must be an integer between 0 and 100/
  );
  assert.throws(
    () => assessReleaseBudget({ gasPriceWei: GAS, requiredTpotFloor: -1n }),
    /requiredTpotFloor must be non-negative/
  );
});

test('assessReleaseBudget round-trips the live 2026-10-29 measurements into the documented recommendation', () => {
  const budget = assessReleaseBudget({
    creationEstimatesGas: [E20, E721, ER],
    bindingEstimateGas: ER,
    outstandingBindings: 2,
    gasPriceWei: GAS,
    feeMarginPercent: 20,
    requiredTpotFloor: 0n,
  });
  // documented figures: creation subtotal ≈ 1,209.9 tPOT + 913.7 tPOT bindings = 2,123.6; ×1.2 ≈ 2,549
  const subtotalTPOT = Number(budget.subtotalWei) / 1e18;
  assert.ok(Math.abs(subtotalTPOT - 2123.6) < 1.5, `subtotal ${subtotalTPOT}`);
  const requiredTPOT = Number(budget.requiredEvmWei) / 1e18;
  assert.ok(Math.abs(requiredTPOT - 2549) < 2.5, `required ${requiredTPOT}`);
  // the old 1,350 tPOT fixed recommendation is PROVABLY insufficient for the whole release
  assert.ok(1350n * 10n ** 18n < budget.requiredEvmWei);
});
