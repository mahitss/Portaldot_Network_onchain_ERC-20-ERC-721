const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transaction } = require('ethers');

const JOURNAL_SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const PORTALDOT_CHAIN_ID = 420420777;
const MAX_UINT256 = (1n << 256n) - 1n;

// Strict canonical nonce validation: non-negative integer, no leading zeros
// (except "0"), no fractions, no signs, no exponents.
function isCanonicalNonce(value) {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= MAX_UINT256;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= Number(MAX_UINT256);
  }
  if (typeof value === 'string') {
    return /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= MAX_UINT256;
  }
  return false;
}

// Canonical string representation of a nonce for comparison without coercion.
function canonicalNonceString(value) {
  if (typeof value === 'bigint') {
    return value.toString(10);
  }
  if (typeof value === 'number') {
    return value.toString(10);
  }
  if (typeof value === 'string') {
    return BigInt(value).toString(10);
  }
  throw new Error('cannot canonicalize nonce of type ' + typeof value);
}

function generateOperationId() {
  return crypto.randomUUID();
}

function parseAndValidateSignedTx(signed, expectedChainId, options = {}) {
  if (typeof signed !== 'string' || !/^0x[0-9a-fA-F]*$/.test(signed)) {
    throw new Error('signed transaction is not a valid hex string');
  }
  let parsed;
  try {
    parsed = Transaction.from(signed);
  } catch (error) {
    throw new Error('cannot parse signed transaction: ' + error.message);
  }
  const chainId = expectedChainId || PORTALDOT_CHAIN_ID;
  if (parsed.chainId === undefined || parsed.chainId === null) {
    throw new Error('signed transaction has no chain ID');
  }
  if (BigInt(parsed.chainId) !== BigInt(chainId)) {
    throw new Error('signed transaction chainId ' + parsed.chainId + ' does not match expected chainId ' + chainId);
  }
  if (parsed.nonce === undefined || parsed.nonce === null) {
    throw new Error('signed transaction has no nonce');
  }
  if (parsed.gasLimit === undefined || parsed.gasLimit === null) {
    throw new Error('signed transaction has no gas limit');
  }
  if (!parsed.hash || typeof parsed.hash !== 'string') {
    throw new Error('signed transaction has no derivable hash');
  }
  if (options.expectedSender) {
    if (!parsed.from || String(parsed.from).toLowerCase() !== String(options.expectedSender).toLowerCase()) {
      throw new Error('signed transaction sender ' + parsed.from + ' does not match expected sender ' + options.expectedSender);
    }
  }
  if (options.expectedTxHash) {
    if (String(parsed.hash).toLowerCase() !== String(options.expectedTxHash).toLowerCase()) {
      throw new Error('signed transaction hash ' + parsed.hash + ' does not match expected ' + options.expectedTxHash);
    }
  }
  // Strict nonce validation: journal nonce must be canonical.
  if (options.expectedNonce !== undefined && options.expectedNonce !== null) {
    if (!isCanonicalNonce(options.expectedNonce)) {
      throw new Error('journal nonce is not a canonical non-negative integer: ' + String(options.expectedNonce));
    }
  }
  if (parsed.nonce === undefined || parsed.nonce === null) {
    throw new Error('signed transaction has no nonce');
  }
  if (!isCanonicalNonce(parsed.nonce)) {
    throw new Error('signed transaction nonce is not a canonical non-negative integer: ' + String(parsed.nonce));
  }
  if (options.expectedNonce !== undefined && options.expectedNonce !== null) {
    // Compare canonical string representations to avoid Number() coercion.
    if (canonicalNonceString(parsed.nonce) !== canonicalNonceString(options.expectedNonce)) {
      throw new Error('signed transaction nonce ' + parsed.nonce + ' does not match expected ' + options.expectedNonce);
    }
  }
  if (options.expectedTo !== undefined) {
    const actualTo = parsed.to ? String(parsed.to).toLowerCase() : null;
    const expectedTo = options.expectedTo ? String(options.expectedTo).toLowerCase() : null;
    if (actualTo !== expectedTo) {
      throw new Error('signed transaction destination ' + parsed.to + ' does not match expected ' + options.expectedTo);
    }
  }
  if (options.expectedValue !== undefined) {
    if (BigInt(parsed.value || 0) !== BigInt(options.expectedValue)) {
      throw new Error('signed transaction value ' + parsed.value + ' does not match expected ' + options.expectedValue);
    }
  }
  if (options.expectedData !== undefined) {
    if (String(parsed.data || '0x').toLowerCase() !== String(options.expectedData).toLowerCase()) {
      throw new Error('signed transaction data does not match expected operation data');
    }
  }
  return {
    txHash: parsed.hash,
    nonce: parsed.nonce,
    gasLimit: parsed.gasLimit,
    chainId: parsed.chainId,
    from: parsed.from,
    to: parsed.to,
    data: parsed.data,
    value: parsed.value,
    maxFeePerGas: parsed.maxFeePerGas,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
    gasPrice: parsed.gasPrice,
    accessList: parsed.accessList,
  };
}

function readPendingJournal(recordFile) {
  const journalPath = recordFile + '.journal';
  if (!fs.existsSync(journalPath)) {
    return { status: 'missing', entry: null, error: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (parsed.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
      return { status: 'malformed', entry: null, error: 'missing or unsupported schema version (expected ' + JOURNAL_SCHEMA_VERSION + ', got ' + parsed.schemaVersion + ')' };
    }
    if (!parsed.operation || !parsed.txHash || !parsed.signed || !parsed.operationId) {
      return { status: 'malformed', entry: null, error: 'journal missing required fields' };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(parsed.txHash)) {
      return { status: 'malformed', entry: null, error: 'invalid transaction hash format' };
    }
    if (!/^0x[0-9a-fA-F]+$/.test(parsed.signed)) {
      return { status: 'malformed', entry: null, error: 'invalid signed transaction bytes' };
    }
    if (!parsed.expectedSender || !/^0x[0-9a-fA-F]{40}$/.test(parsed.expectedSender)) {
      return { status: 'malformed', entry: null, error: 'missing or invalid expected sender' };
    }
    if (parsed.chainId !== PORTALDOT_CHAIN_ID) {
      return { status: 'malformed', entry: null, error: 'invalid chain ID' };
    }
    if (parsed.nonce === undefined || parsed.nonce === null) {
      return { status: 'malformed', entry: null, error: 'missing nonce' };
    }
    if (!isCanonicalNonce(parsed.nonce)) {
      return { status: 'malformed', entry: null, error: 'journal nonce is not a canonical non-negative integer' };
    }
    if (parsed.operation !== 'deploy' && parsed.operation !== 'bind') {
      return { status: 'malformed', entry: null, error: 'invalid operation type: ' + parsed.operation };
    }
    // Validate expectedTo.
    if (parsed.expectedTo !== null && parsed.expectedTo !== undefined) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(parsed.expectedTo)) {
        return { status: 'malformed', entry: null, error: 'invalid expected destination' };
      }
    } else if (parsed.operation === 'bind') {
      return { status: 'malformed', entry: null, error: 'binding journal missing expected destination (registry)' };
    }
    // Validate expectedValue.
    if (parsed.expectedValue === undefined || parsed.expectedValue === null) {
      return { status: 'malformed', entry: null, error: 'missing expected value' };
    }
    // Validate expectedData.
    if (!parsed.expectedData || !/^0x[0-9a-fA-F]*$/.test(parsed.expectedData)) {
      return { status: 'malformed', entry: null, error: 'missing or invalid expected data' };
    }
    // Validate createdAt.
    if (!parsed.createdAt || typeof parsed.createdAt !== 'string') {
      return { status: 'malformed', entry: null, error: 'missing createdAt' };
    }
    // Validate status.
    if (parsed.status === 'failed') {
      // Terminal failure evidence: receipt evidence must be present and match
      // the journaled transaction hash.
      if (!parsed.receipt || typeof parsed.receipt !== 'object') {
        return { status: 'malformed', entry: null, error: 'terminal failure journal is missing receipt evidence' };
      }
      if (typeof parsed.receipt.transactionHash !== 'string' ||
          parsed.receipt.transactionHash.toLowerCase() !== String(parsed.txHash).toLowerCase()) {
        return { status: 'malformed', entry: null, error: 'terminal failure receipt transaction hash does not match the journal hash' };
      }
      if (!Number.isSafeInteger(parsed.receipt.blockNumber) || parsed.receipt.blockNumber < 0) {
        return { status: 'malformed', entry: null, error: 'terminal failure receipt has an invalid block number' };
      }
      if (!Number.isSafeInteger(parsed.receipt.status) || parsed.receipt.status !== 0) {
        return { status: 'malformed', entry: null, error: 'terminal failure receipt status is not a known failure value' };
      }
      if (!parsed.failedAt || typeof parsed.failedAt !== 'string') {
        return { status: 'malformed', entry: null, error: 'terminal failure journal is missing failedAt' };
      }
      return { status: 'terminal_failure', entry: parsed, error: null };
    }
    if (parsed.status !== 'pending') {
      return { status: 'malformed', entry: null, error: 'invalid status: ' + String(parsed.status) };
    }
    // Operation-specific validation.
    if (parsed.operation === 'deploy') {
      if (!parsed.params || !parsed.params.artifact) {
        return { status: 'malformed', entry: null, error: 'deployment journal missing artifact name' };
      }
    }
    if (parsed.operation === 'bind') {
      if (!parsed.params || !parsed.params.token || !parsed.params.nativeAccountHash) {
        return { status: 'malformed', entry: null, error: 'binding journal missing required params' };
      }
    }
    return { status: 'ok', entry: parsed, error: null };
  } catch (error) {
    return { status: 'malformed', entry: null, error: error.message };
  }
}

function fsyncDirectory(directory) {
  try {
    const dirFd = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // directory fsync unsupported on this platform; link still provides
    // atomic publication, durability is best-effort.
  }
}

function persistPendingEntry(recordFile, entry) {
  const directory = path.dirname(recordFile);
  fs.mkdirSync(directory, { recursive: true });
  const journalPath = recordFile + '.journal';

  // Unique temporary file in the same directory.
  const tmp = `${journalPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  // Exclusive creation: the temporary file is created fresh.
  const fd = fs.openSync(tmp, 'wx', FILE_MODE);
  try {
    const data = `${JSON.stringify(entry, null, 2)}\n`;
    let written = 0;
    while (written < data.length) {
      const n = fs.writeSync(fd, data, written);
      if (n <= 0) throw new Error('failed to write full journal payload');
      written += n;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw new Error('cannot write journal for ' + journalPath + ': ' + error.message);
  }
  try {
    fs.chmodSync(tmp, FILE_MODE);
  } catch {
    // best-effort; default perms remain restrictive on POSIX
  }
  // Publish atomically without replacing any existing journal. link(2) fails
  // with EEXIST if the destination exists, giving atomic no-clobber
  // publication. If publication fails, the temp file is removed and the
  // original (missing or existing) journal is left untouched.
  try {
    fs.linkSync(tmp, journalPath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    if (error.code === 'EEXIST') {
      const existing = readPendingJournal(recordFile);
      if (existing.status === 'ok' && existing.entry &&
          existing.entry.txHash === entry.txHash &&
          existing.entry.operation === entry.operation &&
          existing.entry.operationId === entry.operationId) {
        const existingStr = JSON.stringify(existing.entry);
        const newStr = JSON.stringify(entry);
        if (existingStr === newStr) {
          return journalPath;
        }
        throw new Error('cannot persist journal: same operation ID but different payload.');
      }
      if (existing.status === 'terminal_failure') {
        throw new Error('cannot persist journal: an unresolved terminal failure journal already exists at ' + journalPath + '. Resolve it manually.');
      }
      throw new Error('cannot persist journal: an unresolved journal already exists at ' + journalPath + '.');
    }
    throw new Error('cannot publish journal at ' + journalPath + ': ' + error.message);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup of temp */ }
  }
  fsyncDirectory(directory);
  return journalPath;
}

function persistTerminalFailure(recordFile, failureEvidence) {
  const directory = path.dirname(recordFile);
  fs.mkdirSync(directory, { recursive: true });
  const journalPath = recordFile + '.journal';
  const existing = readPendingJournal(recordFile);
  if (existing.status === 'terminal_failure') {
    return journalPath; // already recorded
  }
  if (existing.status !== 'ok' || !existing.entry) {
    throw new Error('cannot persist terminal failure: journal is missing or unreadable');
  }
  const entry = {
    ...existing.entry,
    status: 'failed',
    failedAt: new Date().toISOString(),
    failure: failureEvidence || {},
    receipt: {
      transactionHash: existing.entry.txHash,
      ...(failureEvidence && failureEvidence.receipt ? failureEvidence.receipt : {}),
    },
  };
  const tmp = `${journalPath}.fail-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'wx', FILE_MODE);
  try {
    const data = `${JSON.stringify(entry, null, 2)}\n`;
    let written = 0;
    while (written < data.length) {
      const n = fs.writeSync(fd, data, written);
      if (n <= 0) throw new Error('failed to write full journal payload');
      written += n;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw new Error('cannot write terminal failure journal: ' + error.message);
  }
  try { fs.closeSync(fd); } catch { /* best-effort */ }
  try {
    fs.chmodSync(tmp, FILE_MODE);
  } catch {
    // best-effort
  }
  // Same-operation atomic replace (rename over the existing pending journal).
  try {
    fs.renameSync(tmp, journalPath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw new Error('cannot publish terminal failure journal: ' + error.message);
  }
  fsyncDirectory(directory);
  return journalPath;
}

function clearPendingJournal(recordFile, expectedOpId, expectedTxHash) {
  if (!expectedOpId) {
    throw new Error('clearPendingJournal requires an operation ID');
  }
  if (!expectedTxHash) {
    throw new Error('clearPendingJournal requires a transaction hash');
  }
  const journalPath = recordFile + '.journal';
  if (!fs.existsSync(journalPath)) {
    return;
  }
  const existing = readPendingJournal(recordFile);
  if (existing.status === 'terminal_failure') {
    throw new Error('cannot clear a failed transaction journal; resolve the terminal failure manually');
  }
  if (existing.status !== 'ok' || !existing.entry) {
    throw new Error('cannot clear journal: journal is malformed or unreadable');
  }
  if (existing.entry.operationId !== expectedOpId) {
    throw new Error('refusing to clear journal: operation ID mismatch');
  }
  if (existing.entry.txHash !== expectedTxHash) {
    throw new Error('refusing to clear journal: txHash mismatch');
  }
  try {
    fs.unlinkSync(journalPath);
  } catch (error) {
    throw new Error(`failed to remove journal at ${journalPath}: ${error.message}`);
  }
  // Best-effort directory fsync to make the deletion durable.
  fsyncDirectory(path.dirname(journalPath));
}

function validateDeploymentTransaction(signed, journal, expectedDeployer, expectedInitcode, expectedNonce) {
  if (!journal || !journal.txHash) {
    throw new Error('validateDeploymentTransaction requires a valid journal with txHash');
  }
  if (!expectedDeployer) {
    throw new Error('validateDeploymentTransaction requires an explicit expected deployer');
  }
  if (!expectedInitcode) {
    throw new Error('validateDeploymentTransaction requires independently reconstructed initcode');
  }
  if (expectedNonce === undefined || expectedNonce === null) {
    throw new Error('validateDeploymentTransaction requires an explicit expected nonce');
  }
  const parsed = parseAndValidateSignedTx(signed, PORTALDOT_CHAIN_ID, {
    expectedSender: expectedDeployer,
    expectedTxHash: journal.txHash,
    expectedNonce: expectedNonce,
    expectedTo: null,
    expectedValue: '0',
    expectedData: expectedInitcode,
  });
  if (parsed.from.toLowerCase() !== expectedDeployer.toLowerCase()) {
    throw new Error('deployment transaction sender does not match expected deployer');
  }
  if (parsed.to !== null) {
    throw new Error('deployment transaction must be a contract creation');
  }
  return parsed;
}

function validateBindingTransaction(signed, journal, expectedSigner, expectedRegistry, expectedCalldata, expectedNonce) {
  if (!journal || !journal.txHash) {
    throw new Error('validateBindingTransaction requires a valid journal with txHash');
  }
  if (!expectedSigner) {
    throw new Error('validateBindingTransaction requires an explicit expected signer');
  }
  if (!expectedRegistry) {
    throw new Error('validateBindingTransaction requires an explicit expected registry address');
  }
  if (!expectedCalldata) {
    throw new Error('validateBindingTransaction requires explicit expected calldata');
  }
  if (expectedNonce === undefined || expectedNonce === null) {
    throw new Error('validateBindingTransaction requires an explicit expected nonce');
  }
  const parsed = parseAndValidateSignedTx(signed, PORTALDOT_CHAIN_ID, {
    expectedSender: expectedSigner,
    expectedTxHash: journal.txHash,
    expectedNonce: expectedNonce,
    expectedTo: expectedRegistry,
    expectedValue: '0',
    expectedData: expectedCalldata,
  });
  if (parsed.from.toLowerCase() !== expectedSigner.toLowerCase()) {
    throw new Error('binding transaction sender does not match expected signer');
  }
  if (!parsed.to || parsed.to.toLowerCase() !== expectedRegistry.toLowerCase()) {
    throw new Error('binding transaction destination must be the PotRegistry address');
  }
  return parsed;
}

module.exports = {
  FILE_MODE,
  JOURNAL_SCHEMA_VERSION,
  generateOperationId,
  parseAndValidateSignedTx,
  persistPendingEntry,
  readPendingJournal,
  clearPendingJournal,
  persistTerminalFailure,
  validateDeploymentTransaction,
  validateBindingTransaction,
};