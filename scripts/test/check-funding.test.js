import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseRequiredTpot,
  tpotToUnits,
  DEFAULT_REQUIRED_TPOT,
  NATIVE_DECIMALS,
  EVM_DECIMALS,
} from '../check-funding.js';

test('parseRequiredTpot returns default when not set', () => {
  assert.equal(parseRequiredTpot(undefined), DEFAULT_REQUIRED_TPOT);
  assert.equal(parseRequiredTpot(''), DEFAULT_REQUIRED_TPOT);
});

test('parseRequiredTpot parses valid values', () => {
  assert.equal(parseRequiredTpot('1350'), 1350n);
  assert.equal(parseRequiredTpot('0'), 0n);
  assert.equal(parseRequiredTpot('1'), 1n);
});

test('parseRequiredTpot rejects invalid values', () => {
  assert.throws(() => parseRequiredTpot('-1'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('1.5'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('abc'), /invalid POT_REQUIRED_TPOT/);
  assert.throws(() => parseRequiredTpot('1,000'), /invalid POT_REQUIRED_TPOT/);
});

test('tpotToUnits converts to native decimals (14)', () => {
  assert.equal(tpotToUnits(1n, NATIVE_DECIMALS), 10n ** 14n);
  assert.equal(tpotToUnits(1350n, NATIVE_DECIMALS), 1350n * 10n ** 14n);
});

test('tpotToUnits converts to EVM decimals (18)', () => {
  assert.equal(tpotToUnits(1n, EVM_DECIMALS), 10n ** 18n);
  assert.equal(tpotToUnits(1350n, EVM_DECIMALS), 1350n * 10n ** 18n);
});

test('DEFAULT_REQUIRED_TPOT is 1350', () => {
  assert.equal(DEFAULT_REQUIRED_TPOT, 1350n);
});
