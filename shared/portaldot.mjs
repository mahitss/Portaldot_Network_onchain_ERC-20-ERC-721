import { blake2b512, fromHex, toHex } from './blake2b.mjs';

export const CHAIN_ID = 420420777;
export const RPC_URL = 'https://test-evm-rpc-v3.portaldot.dev';
export const WS_URL = 'wss://test-node-v3.portaldot.dev';
export const EXPLORER_URL = 'https://explorer-v3.portaldot.dev';

export const NATIVE_DECIMALS = 14;
export const EVM_DECIMALS = 18;
export const CONVERSION_FACTOR = 10n ** BigInt(EVM_DECIMALS - NATIVE_DECIMALS);
export const SS58_PREFIX = 42;
export const ACCOUNT_SUFFIX_BYTE = 0xee;
export const SS58PRE = new TextEncoder().encode('SS58PRE');

export const MAX_UINT256 = (1n << 256n) - 1n;

function toBigIntAmount(amount) {
  if (typeof amount === 'bigint') {
    if (amount < 0n) {
      throw new Error('amount must be non-negative');
    }
    return amount;
  }
  if (typeof amount === 'number') {
    throw new Error(`amount must be a bigint or decimal-integer string, got number`);
  }
  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`invalid amount: ${amount}`);
    }
    return BigInt(trimmed);
  }
  throw new Error(`amount must be a bigint or decimal-integer string, got ${typeof amount}`);
}

export const KIND_ERC20 = 0;
export const KIND_ERC721 = 1;
export const NATIVE_NONE = 0;
export const NATIVE_ASSETS = 1;
export const NATIVE_NFTS = 2;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }
  const digits = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += ALPHABET[digits[i]];
  }
  return out;
}

export function base58Decode(text) {
  let value = 0n;
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error(`invalid base58 character: ${char}`);
    }
    value = value * 58n + BigInt(index);
  }
  let hex = value === 0n ? '' : value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  const bytes = hex.length === 0 ? new Uint8Array(0) : fromHex(hex);
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') {
    zeros += 1;
  }
  const output = new Uint8Array(zeros + bytes.length);
  output.set(bytes, zeros);
  return output;
}

export function ss58Encode(addressBytes, prefix = SS58_PREFIX) {
  const payload = new Uint8Array(1 + addressBytes.length);
  payload[0] = prefix;
  payload.set(addressBytes, 1);
  const preimage = new Uint8Array(SS58PRE.length + payload.length);
  preimage.set(SS58PRE, 0);
  preimage.set(payload, SS58PRE.length);
  const checksum = blake2b512(preimage).subarray(0, 2);
  const full = new Uint8Array(payload.length + 2);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58Encode(full);
}

export function ss58Decode(address) {
  const full = base58Decode(address.trim());
  if (full.length < 3) {
    throw new Error('address too short');
  }
  const payload = full.subarray(0, full.length - 2);
  const checksum = full.subarray(full.length - 2);
  const preimage = new Uint8Array(SS58PRE.length + payload.length);
  preimage.set(SS58PRE, 0);
  preimage.set(payload, SS58PRE.length);
  const expected = blake2b512(preimage).subarray(0, 2);
  for (let i = 0; i < 2; i += 1) {
    if (expected[i] !== checksum[i]) {
      throw new Error('invalid SS58 checksum');
    }
  }
  return { prefix: payload[0], bytes: payload.subarray(1) };
}

export function nativeAccountBytes(evmAddress) {
  const clean = evmAddress.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`invalid EVM address: ${evmAddress}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  for (let i = 20; i < 32; i += 1) {
    bytes[i] = ACCOUNT_SUFFIX_BYTE;
  }
  return bytes;
}

export function evmAddressToNativeAccount(evmAddress, prefix = SS58_PREFIX) {
  const bytes = nativeAccountBytes(evmAddress);
  return {
    evmAddress: `0x${evmAddress.replace(/^0x/i, '').toLowerCase()}`,
    bytes,
    hex: toHex(bytes),
    ss58: ss58Encode(bytes, prefix),
  };
}

export function nativeAccountToEvmAddress(ss58) {
  const decoded = ss58Decode(ss58);
  if (decoded.prefix !== SS58_PREFIX) {
    throw new Error(`invalid SS58 prefix: ${decoded.prefix}, expected ${SS58_PREFIX}`);
  }
  if (decoded.bytes.length !== 32) {
    throw new Error(`expected a 32 byte account, got ${decoded.bytes.length}`);
  }
  for (let i = 20; i < 32; i += 1) {
    if (decoded.bytes[i] !== ACCOUNT_SUFFIX_BYTE) {
      throw new Error(
        `invalid native account suffix byte at position ${i}: expected 0x${ACCOUNT_SUFFIX_BYTE.toString(16).padStart(2, '0')}, got 0x${decoded.bytes[i].toString(16).padStart(2, '0')}`
      );
    }
  }
  return toHex(decoded.bytes.subarray(0, 20));
}

export async function sha256Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

export async function nativeAccountHash(evmAddress) {
  return sha256Hex(nativeAccountBytes(evmAddress));
}

export function evmToNative(amount) {
  const value = toBigIntAmount(amount);
  if (value > MAX_UINT256) {
    throw new Error(`amount ${value} exceeds uint256 maximum ${MAX_UINT256}`);
  }
  if (value % CONVERSION_FACTOR !== 0n) {
    throw new Error(`amount ${value} is not exactly divisible by conversion factor ${CONVERSION_FACTOR}`);
  }
  return value / CONVERSION_FACTOR;
}

export function nativeToEvm(amount) {
  const value = toBigIntAmount(amount);
  if (value > MAX_UINT256) {
    throw new Error(`input ${value} exceeds uint256 maximum ${MAX_UINT256}`);
  }
  const result = value * CONVERSION_FACTOR;
  if (result > MAX_UINT256) {
    throw new Error(`conversion result ${result} exceeds uint256 maximum ${MAX_UINT256}`);
  }
  return result;
}

export function formatAmount(amount, decimals) {
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseAmount(text, decimals) {
  const trimmed = String(text).trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid amount: ${text}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimals`);
  }
  const padded = fraction.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded);
}
