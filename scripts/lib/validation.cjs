// Pure validation functions for the Portaldot V3 release pipeline.
// External dependencies: none. Node built-ins only (node:fs for artifact reads).
// Every function is side-effect free so it can run offline inside tests.

const fs = require('node:fs');

const CHAIN_ID = 420420777;
const NATIVE_DECIMALS = 14;
const EVM_DECIMALS = 18;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT32 = (1n << 32n) - 1n;
const MAX_CODE_SIZE_BYTES = 10240;
const DEFAULT_REQUIRED_TPOT = 1350n;

// PotRegistry enums (contracts/PotRegistry.sol)
const KIND_ERC20 = 0;
const KIND_ERC721 = 1;
const NATIVE_NONE = 0;
const NATIVE_ASSETS = 1;
const NATIVE_NFTS = 2;

const REQUIRED_CONTRACT_NAMES = ['PotERC20', 'PotERC721', 'PotRegistry'];

function parseRequiredTpot(value) {
  if (value === undefined || value === '') {
    return DEFAULT_REQUIRED_TPOT;
  }
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `invalid POT_REQUIRED_TPOT: "${value}" of type ${typeof value}. Must be a whole non-negative integer amount of tPOT in decimal notation.`
    );
  }
  return BigInt(trimmed);
}

function tpotToNativeUnits(amountTpot) {
  return amountTpot * 10n ** BigInt(NATIVE_DECIMALS);
}

function tpotToEvmUnits(amountTpot) {
  return amountTpot * 10n ** BigInt(EVM_DECIMALS);
}

function tpotToUnits(amountTpot, decimals) {
  return amountTpot * 10n ** BigInt(decimals);
}

// Exact decimal rendering of a base-unit amount, without trailing zeros.
// Never uses JavaScript numbers, so values beyond 2^53 stay precise.
function formatUnits(value, decimals) {
  const v = BigInt(value);
  if (v < 0n) {
    throw new Error('formatUnits expects a non-negative amount');
  }
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const fraction = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

// Chain IDs are small but kept BigInt-safe so a 32-bit+ chain id can never
// fall through a Number() precision hole.
function validateChainId(chainId, expectedChainId) {
  let got;
  try {
    got = typeof chainId === 'bigint' ? chainId : BigInt(chainId);
  } catch {
    throw new Error(`invalid chain id: ${chainId}`);
  }
  if (got !== BigInt(expectedChainId)) {
    throw new Error(
      `wrong chain ID: ${got}. Expected ${expectedChainId} (Portaldot V3 testnet).`
    );
  }
  return got;
}

// Gas limits on this chain are Substrate/PolkaVM-scale and exceed 2^53
// (observed: u64::MAX block gas limit, ~1.0-1.7e16 per contract creation),
// so they are always handled as BigInt, never as Number.
function validateGasLimit(value) {
  if (value === undefined || value === null) {
    throw new Error('gas limit is required but not set');
  }
  if (typeof value === 'bigint') {
    if (value < 1n) throw new Error(`invalid POT_GAS_LIMIT: ${value}. Must be a positive integer gas limit.`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`invalid POT_GAS_LIMIT: ${value}. Must be a positive integer gas limit in the connected chain's gas units.`);
    }
    return BigInt(value);
  }
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text) || text === '') {
    throw new Error(`invalid POT_GAS_LIMIT: ${value}. Must be a positive integer gas limit in the connected chain's gas units.`);
  }
  const parsed = BigInt(text);
  if (parsed < 1n) {
    throw new Error(`invalid POT_GAS_LIMIT: ${value}. Must be a positive integer gas limit in the connected chain's gas units.`);
  }
  return parsed;
}

// Strict native id parsing: decimal integers only, uint32 boundaries enforced.
// Strings must be plain decimal literals, so '007' is fine but '', ' 1', '1e6',
// '+1', '-1', '0x10' and '1.0' are rejected rather than silently coerced.
function validateNativeId(id, name = 'native ID') {
  if (typeof id === 'bigint') {
    if (id < 0n || id > MAX_UINT32) {
      throw new Error(`invalid ${name}: ${id}. Must be a decimal integer in [0, 4294967295].`);
    }
    return Number(id);
  }
  if (typeof id === 'number') {
    if (!Number.isSafeInteger(id) || id < 0 || id > Number(MAX_UINT32)) {
      throw new Error(`invalid ${name}: ${id}. Must be a decimal integer in [0, 4294967295].`);
    }
    return id;
  }
  if (typeof id === 'string') {
    if (!/^[0-9]+$/.test(id)) {
      throw new Error(`invalid ${name}: "${id}". Must be a decimal integer in [0, 4294967295], without prefixes, exponents, signs or fractions.`);
    }
    const parsed = Number(id);
    if (parsed < 0 || parsed > Number(MAX_UINT32)) {
      throw new Error(`invalid ${name}: ${id}. Must be a decimal integer in [0, 4294967295].`);
    }
    return parsed;
  }
  throw new Error(`invalid ${name}: ${String(id)} of type ${typeof id}. Must be a decimal integer in [0, 4294967295].`);
}

// EVM address validation that never silently interprets an SS58 address as
// an EVM address. Returns the normalized lowercase 0x form.
function validateEvmAddress(value, name = 'EVM address') {
  if (typeof value !== 'string') {
    throw new Error(`${name} is not a valid EVM address: ${String(value)} of type ${typeof value}. Expected 0x followed by 40 hex characters.`);
  }
  const trimmed = value.trim();
  const hex = /^0x/i.test(trimmed) ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{40}$/.test(hex)) {
    return `0x${hex.toLowerCase()}`;
  }
  // Base58 (no 0/O/I/l) string of plausible SS58 length gets a dedicated hint.
  if (/^[1-9A-HJ-NP-Za-km-z]{30,56}$/.test(trimmed)) {
    throw new Error(
      `${name} looks like an SS58 native account: ${value}. Provide the 20-byte EVM address (0x + 40 hex characters) instead. Never pass an SS58 address where an EVM address is required.`
    );
  }
  throw new Error(`${name} is not a valid EVM address: ${value}. Expected 0x followed by 40 hex characters.`);
}

function validateNativeAccountHash(value, name = 'native account commitment') {
  if (typeof value !== 'string') {
    throw new Error(`${name} is not a 32-byte hash: ${String(value)} of type ${typeof value}.`);
  }
  const trimmed = value.trim();
  const hex = /^0x/i.test(trimmed) ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} is not a 32-byte SHA-256 value: ${value}. Expected 0x followed by 64 hex characters.`);
  }
  return `0x${hex.toLowerCase()}`;
}

function validateReceipt(txHash, receipt) {
  if (receipt === null || receipt === undefined) {
    throw new Error(`transaction receipt not found for ${txHash}`);
  }
  if (typeof receipt !== 'object') {
    throw new Error(`transaction ${txHash} returned an unexpected receipt (${typeof receipt})`);
  }
  if (receipt.status !== 1) {
    throw new Error(`transaction ${txHash} failed with status ${receipt.status}`);
  }
  if (
    typeof receipt.transactionHash !== 'string' ||
    receipt.transactionHash.toLowerCase() !== String(txHash).toLowerCase()
  ) {
    throw new Error(
      `receipt transaction hash mismatch: expected ${txHash}, got ${receipt.transactionHash}`
    );
  }
  return receipt;
}

function validateContractArtifact(artifactPath, maxSizeBytes) {
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read contract artifact ${artifactPath}: ${error.message}`);
  }
  const bytecode = artifact && artifact.deployedBytecode;
  if (typeof bytecode !== 'string' || !/^0x[0-9a-fA-F]*$/.test(bytecode) || (bytecode.length - 2) % 2 !== 0) {
    throw new Error(`contract artifact ${artifactPath} has an invalid or missing deployedBytecode`);
  }
  const runtimeBytes = (bytecode.length - 2) / 2;
  if (runtimeBytes > maxSizeBytes) {
    throw new Error(`runtime bytecode is ${runtimeBytes} bytes, exceeds limit of ${maxSizeBytes} bytes`);
  }
  return runtimeBytes;
}

// Runtime Option handling. A storage Result in polkadot-js is an Option with
// isSome/isNone flags; Option::None must never be treated as an existing
// object, and values without Option semantics are ambiguous, not true.
function assertOptionSome(option, label) {
  if (option === null || option === undefined) {
    throw new Error(`${label}: storage returned nothing (missing object or unsupported query). Refusing to treat absence as success.`);
  }
  if (typeof option !== 'object') {
    throw new Error(`${label}: ambiguous storage result of type ${typeof option}. Refusing to treat it as an existing object.`);
  }
  const hasSome = typeof option.isSome === 'boolean';
  const hasNone = typeof option.isNone === 'boolean';
  if (!hasSome && !hasNone) {
    throw new Error(`${label}: storage result is not a runtime Option; ambiguous outcome. Refusing toString()-style existence proofs.`);
  }
  if (hasSome && hasNone && option.isSome !== !option.isNone) {
    throw new Error(`${label}: inconsistent runtime Option flags (isSome=${option.isSome}, isNone=${option.isNone}).`);
  }
  if (option.isSome === true && option.isNone === false) {
    return option;
  }
  throw new Error(`${label} does not exist on chain (runtime returned Option::None).`);
}

// Compare an intended binding configuration against the on-chain Binding.
// Numeric fields compared through BigInt, hashes byte-insensitively.
const BINDING_FIELDS = [
  'token', 'tokenKind', 'nativeKind', 'nativeId',
  'nativeDecimals', 'evmDecimals', 'conversionFactor',
  'nativeAccountHash', 'active',
];

function normalizeBindingValue(field, value) {
  if (['tokenKind', 'nativeKind', 'nativeId', 'nativeDecimals', 'evmDecimals', 'conversionFactor'].includes(field)) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`binding field ${field} is not a non-negative integer: ${value}`);
      return BigInt(value);
    }
    if (typeof value === 'string') {
      if (!/^\d+$/.test(value)) throw new Error(`binding field ${field} is not a decimal integer: ${value}`);
      return BigInt(value);
    }
    throw new Error(`binding field ${field} has an unusable type: ${typeof value}`);
  }
  if (field === 'token') {
    return validateEvmAddress(String(value), 'binding token');
  }
  if (field === 'nativeAccountHash') {
    return validateNativeAccountHash(String(value), 'binding nativeAccountHash');
  }
  if (field === 'active') {
    if (typeof value !== 'boolean') throw new Error(`binding field active is not a boolean: ${value}`);
    return value;
  }
  throw new Error(`unknown binding field: ${field}`);
}

function compareBinding(expected, actual) {
  const mismatches = [];
  for (const field of BINDING_FIELDS) {
    const a = normalizeBindingValue(field, expected[field]);
    const b = normalizeBindingValue(field, actual[field]);
    if (a !== b) {
      mismatches.push(`${field}: expected ${String(a)}, on-chain ${String(b)}`);
    }
  }
  return mismatches;
}

// Structured funding decision in each ledger's own units. EVM balances are
// 18-decimal wei; native balances are 14-decimal units; both are BigInt.
function assessFunding({
  requiredTpot,
  evmBalanceWei,
  nativeFreeUnits,
  evmReadError = null,
  nativeReadError = null,
}) {
  const requiredNativeUnits = tpotToNativeUnits(BigInt(requiredTpot));
  const requiredEvmWei = tpotToEvmUnits(BigInt(requiredTpot));

  if (evmReadError === null && typeof evmBalanceWei !== 'bigint') {
    throw new Error(`evmBalanceWei must be a bigint, got ${typeof evmBalanceWei}`);
  }
  if (nativeReadError === null && typeof nativeFreeUnits !== 'bigint') {
    throw new Error(`nativeFreeUnits must be a bigint, got ${typeof nativeFreeUnits}`);
  }

  const evmShortfallWei = evmReadError === null && evmBalanceWei < requiredEvmWei
    ? requiredEvmWei - evmBalanceWei
    : 0n;
  const nativeShortfallUnits = nativeReadError === null && nativeFreeUnits < requiredNativeUnits
    ? requiredNativeUnits - nativeFreeUnits
    : 0n;

  const evmFunded = evmReadError === null && evmShortfallWei === 0n;
  const nativeFunded = nativeReadError === null && nativeShortfallUnits === 0n;
  return {
    funded: evmFunded && nativeFunded,
    evmFunded,
    nativeFunded,
    evmShortfallWei,
    nativeShortfallUnits,
    requiredEvmWei,
    requiredNativeUnits,
  };
}

// Fail-closed structural validation of a deployment record. Throws on any
// malformed field so callers can distinguish "no file" from "bad file".
function validateDeploymentRecord(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`deployment record is not an object (${data === null ? 'null' : typeof data})`);
  }
  if (typeof data.network !== 'string' || data.network.length === 0) {
    throw new Error('deployment record has no network name');
  }
  if (typeof data.chainId !== 'number' || Number(data.chainId) !== CHAIN_ID) {
    throw new Error(`deployment record chainId is not ${CHAIN_ID}: ${JSON.stringify(data.chainId)}`);
  }
  if (data.deployer !== undefined) {
    validateEvmAddress(data.deployer, 'deployment record deployer');
  }
  if (data.contracts === null || typeof data.contracts !== 'object') {
    throw new Error('deployment record has no contracts table');
  }
  for (const [name, entry] of Object.entries(data.contracts)) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`deployment record contract entry ${name} is not an object`);
    }
    validateEvmAddress(entry.address, `deployment record ${name}.address`);
    if (typeof entry.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(entry.txHash)) {
      throw new Error(`deployment record ${name}.txHash is not a 32-byte transaction hash: ${entry.txHash}`);
    }
  }
  if (data.tokens === null || typeof data.tokens !== 'object') {
    throw new Error('deployment record has no tokens table');
  }
  for (const [key, token] of Object.entries(data.tokens)) {
    if (token === null || typeof token !== 'object' || typeof token.address !== 'string') {
      throw new Error(`deployment record token ${key} has no address`);
    }
    validateEvmAddress(token.address, `deployment record token ${key}.address`);
  }
  if (!Array.isArray(data.bindings)) {
    throw new Error('deployment record bindings is not an array');
  }
  return data;
}

// Structural validation of one expected binding entry (the intentional,
// documented release configuration persisted by bind.js).
function validateBindingEntry(entry) {
  if (entry === null || typeof entry !== 'object') {
    throw new Error('binding entry is not an object');
  }
  for (const field of BINDING_FIELDS) {
    if (entry[field] === undefined) {
      throw new Error(`binding entry is missing field ${field}`);
    }
    normalizeBindingValue(field, entry[field]);
  }
  if (typeof entry.txHash === 'string' && !/^0x[0-9a-fA-F]{64}$/.test(entry.txHash)) {
    throw new Error(`binding entry txHash is not a transaction hash: ${entry.txHash}`);
  }
  return entry;
}

module.exports = {
  CHAIN_ID,
  NATIVE_DECIMALS,
  EVM_DECIMALS,
  MAX_UINT256,
  MAX_UINT32,
  MAX_CODE_SIZE_BYTES,
  DEFAULT_REQUIRED_TPOT,
  KIND_ERC20,
  KIND_ERC721,
  NATIVE_NONE,
  NATIVE_ASSETS,
  NATIVE_NFTS,
  REQUIRED_CONTRACT_NAMES,
  parseRequiredTpot,
  tpotToNativeUnits,
  tpotToEvmUnits,
  tpotToUnits,
  formatUnits,
  validateChainId,
  validateGasLimit,
  validateNativeId,
  validateEvmAddress,
  validateNativeAccountHash,
  validateReceipt,
  validateContractArtifact,
  assertOptionSome,
  compareBinding,
  BINDING_FIELDS,
  normalizeBindingValue,
  assessFunding,
  validateDeploymentRecord,
  validateBindingEntry,
};
