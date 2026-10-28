import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONVERSION_FACTOR,
  base58Decode,
  base58Encode,
  escapeHtml,
  evmAddressToNativeAccount,
  evmToNative,
  formatAmount,
  nativeAccountHash,
  nativeAccountToEvmAddress,
  nativeToEvm,
  parseAmount,
  ss58Decode,
  ss58Encode,
} from '../../shared/portaldot.mjs';
import { blake2b512, fromHex, toHex } from '../../shared/blake2b.mjs';

const GUIDE_ADDRESS = '0xf7eC65d11e35375A250e474059a917B537804142';
const GUIDE_SS58 = '5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8Y';
const MAKHZAN_ADDRESS = '0x60481DFcFCA34A8F095939D9675eC715127B2e44';
const MAKHZAN_SS58 = '5EEwsqgiEVZNUdUHdmsEMqBQzJjNy5PULPBYoo5yF2GX45DZ';
const ALICE_PUBKEY = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
const ALICE_SS58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

test('blake2b-512 matches known vectors', () => {
  assert.equal(
    toHex(blake2b512(new TextEncoder().encode('abc'))),
    '0xba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923'
  );
  assert.equal(
    toHex(blake2b512(new Uint8Array(0))),
    '0x786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce'
  );
});

test('base58 round trips', () => {
  assert.equal(base58Encode(fromHex('00')), '1');
  assert.equal(toHex(base58Decode('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY')).slice(2, 66).length, 64);
});

test('ss58 encoding matches the official guide and known account', () => {
  assert.equal(ss58Encode(fromHex(ALICE_PUBKEY)), ALICE_SS58);
  const decoded = ss58Decode(ALICE_SS58);
  assert.equal(decoded.prefix, 42);
  assert.equal(toHex(decoded.bytes), `0x${ALICE_PUBKEY}`);
  assert.throws(() => ss58Decode('5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8X'));
});

test('evm address maps to the deterministic native account', () => {
  const guide = evmAddressToNativeAccount(GUIDE_ADDRESS);
  assert.equal(guide.ss58, GUIDE_SS58);
  assert.equal(guide.hex, `0x${GUIDE_ADDRESS.slice(2).toLowerCase()}${'ee'.repeat(12)}`);

  const makhzan = evmAddressToNativeAccount(MAKHZAN_ADDRESS);
  assert.equal(makhzan.ss58, MAKHZAN_SS58);

  assert.equal(nativeAccountToEvmAddress(GUIDE_SS58), GUIDE_ADDRESS.toLowerCase());
  assert.equal(nativeAccountToEvmAddress(MAKHZAN_SS58), MAKHZAN_ADDRESS.toLowerCase());

  // Round-trip using the guide address as the EVM address
  const guideEvm = GUIDE_ADDRESS.slice(2).toLowerCase();
  assert.equal(nativeAccountToEvmAddress(evmAddressToNativeAccount(guideEvm).ss58), `0x${guideEvm}`);
});

test('nativeAccountToEvmAddress rejects invalid accounts', () => {
  // Wrong SS58 prefix
  const wrongPrefix = ss58Encode(fromHex(ALICE_PUBKEY), 0);
  assert.throws(() => nativeAccountToEvmAddress(wrongPrefix));

  // Wrong suffix: 0x00 instead of 0xEE
  const zeroSuffix = new Uint8Array(32);
  zeroSuffix.set(fromHex(ALICE_PUBKEY.slice(2)), 0);
  assert.throws(() => nativeAccountToEvmAddress(ss58Encode(zeroSuffix)));

  // Wrong suffix: 0xEF instead of 0xEE
  const efSuffix = new Uint8Array(32);
  efSuffix.set(fromHex(ALICE_PUBKEY.slice(2)), 0);
  for (let i = 20; i < 32; i += 1) {
    efSuffix[i] = 0xef;
  }
  assert.throws(() => nativeAccountToEvmAddress(ss58Encode(efSuffix)));

  // Wrong length: 20 bytes instead of 32
  assert.throws(() => nativeAccountToEvmAddress(ss58Encode(fromHex(ALICE_PUBKEY.slice(2)))));

  // Invalid checksum
  assert.throws(() => nativeAccountToEvmAddress(GUIDE_SS58.replace(/Y$/, 'Z')));

  // Malformed base58
  assert.throws(() => nativeAccountToEvmAddress('notbase58!!!!'));
});

test('evmToNative converts exact amounts and rejects invalid inputs', () => {
  assert.equal(evmToNative(10000n), 1n);
  assert.equal(evmToNative(0n), 0n);
  assert.equal(evmToNative(10000000000n), 1000000n);
  assert.equal(evmToNative('10000'), 1n);

  // Non-divisible amounts must throw, never silently truncate
  assert.throws(() => evmToNative(9999n));
  assert.throws(() => evmToNative(12345n));

  // Negative amounts rejected
  assert.throws(() => evmToNative(-1n));

  // Fractional and malformed strings rejected
  assert.throws(() => evmToNative('1.5'));
  assert.throws(() => evmToNative('abc'));

  // Unsafe JavaScript numbers rejected (silent precision loss)
  assert.throws(() => evmToNative(12345678901234567890));
});

test('nativeToEvm converts exact amounts and rejects overflow', () => {
  assert.equal(nativeToEvm(1n), 10000n);
  assert.equal(nativeToEvm(0n), 0n);
  assert.equal(nativeToEvm(1000000n), 10000000000n);
  assert.equal(nativeToEvm('1'), 10000n);

  const MAX_UINT256 = (1n << 256n) - 1n;
  const maxNative = MAX_UINT256 / CONVERSION_FACTOR;
  assert.equal(nativeToEvm(maxNative), maxNative * CONVERSION_FACTOR);

  // Overflow beyond uint256 maximum
  assert.throws(() => nativeToEvm(maxNative + 1n));

  // Negative amounts rejected
  assert.throws(() => nativeToEvm(-1n));

  // Fractional and malformed strings rejected
  assert.throws(() => nativeToEvm('1.5'));
  assert.throws(() => nativeToEvm('abc'));

  // Unsafe JavaScript numbers rejected
  assert.throws(() => nativeToEvm(12345678901234567890));
});

test('native account hash is deterministic sha256 of the 32 byte account', async () => {
  const first = await nativeAccountHash(GUIDE_ADDRESS);
  const second = await nativeAccountHash(GUIDE_ADDRESS.toLowerCase());
  assert.equal(first, second);
  assert.match(first, /^0x[0-9a-f]{64}$/);
  assert.notEqual(first, await nativeAccountHash(MAKHZAN_ADDRESS));
});

test('unit conversions keep the 14 to 18 decimal relationship', () => {
  assert.equal(CONVERSION_FACTOR, 10000n);
  assert.equal(nativeToEvm(1n), 10000n);
  assert.equal(evmToNative(10000n), 1n);
  assert.throws(() => evmToNative(9999n));
  assert.equal(formatAmount(1500000000000000000n, 18), '1.5');
  assert.equal(formatAmount(1n, 14), '0.00000000000001');
  assert.equal(parseAmount('1.5', 18), 1500000000000000000n);
  assert.equal(parseAmount('1', 14), 100000000000000n);
  assert.throws(() => parseAmount('1.2345', 2));
  assert.throws(() => parseAmount('abc', 18));
});

test('evmToNative rejects amounts exceeding uint256 range', () => {
  const MAX_UINT256 = (1n << 256n) - 1n;

  // Largest uint256-range EVM amount divisible by CONVERSION_FACTOR converts exactly
  const maxDivisible = (MAX_UINT256 / CONVERSION_FACTOR) * CONVERSION_FACTOR;
  assert.equal(evmToNative(maxDivisible), maxDivisible / CONVERSION_FACTOR);

  // EVM amount greater than MAX_UINT256 is rejected
  assert.throws(() => evmToNative(MAX_UINT256 + 1n));

  // Non-divisible EVM amounts are rejected
  assert.throws(() => evmToNative(9999n));
});

test('nativeToEvm accepts largest representable result and rejects out-of-range', () => {
  const MAX_UINT256 = (1n << 256n) - 1n;
  const maxNative = MAX_UINT256 / CONVERSION_FACTOR;

  // Largest representable result accepted
  assert.equal(nativeToEvm(maxNative), maxNative * CONVERSION_FACTOR);

  // Input exceeding uint256 rejected
  assert.throws(() => nativeToEvm(MAX_UINT256 + 1n));

  // Result exceeding uint256 rejected
  assert.throws(() => nativeToEvm(maxNative + 1n));

  // Negative, fractional, malformed rejected
  assert.throws(() => nativeToEvm(-1n));
  assert.throws(() => nativeToEvm('1.5'));
  assert.throws(() => nativeToEvm('abc'));
});

test('escapeHtml escapes HTML special characters', () => {
  assert.equal(escapeHtml('plain text'), 'plain text');
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(
    escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;'
  );
  assert.equal(escapeHtml(''), '');
});
