const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transaction } = require('ethers');
const {
  isKnownUnsupportedSyncError,
  fsyncDirectory,
  reportDirSync,
} = require('./durability.cjs');

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
      // Terminal failure evidence: receipt evidence must be present, canonical,
      // and match the journaled transaction hash.
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
      const rs = parsed.receipt.status;
      const definiteFailure = rs === 0 || rs === '0' || rs === false || rs === 0n;
      if (!definiteFailure) {
        return { status: 'malformed', entry: null, error: 'terminal failure receipt status is not a known failure value' };
      }
      if (!parsed.failedAt || typeof parsed.failedAt !== 'string') {
        return { status: 'malformed', entry: null, error: 'terminal failure journal is missing failedAt' };
      }
      // Canonicalize: status is always stored as 0 (number) for consumers reading this.
      parsed.receipt.status = 0;
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

// Directory synchronization is provided by the shared durability module
// (./durability.cjs). It is used by persistPendingEntry,
// persistTerminalFailure, and clearPendingJournal.

function persistPendingEntry(recordFile, entry, fs_ = fs) {
  const directory = path.dirname(recordFile);
  fs_.mkdirSync(directory, { recursive: true });
  const journalPath = recordFile + '.journal';

  // Unique temporary file in the same directory.
  const tmp = `${journalPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  // Exclusive creation: the temporary file is created fresh.
  const fd = fs_.openSync(tmp, 'wx', FILE_MODE);
  try {
    const data = `${JSON.stringify(entry, null, 2)}\n`;
    let written = 0;
    while (written < data.length) {
      const n = fs_.writeSync(fd, data, written);
      if (n <= 0) throw new Error('failed to write full journal payload');
      written += n;
    }
    fs_.fsyncSync(fd);
  } catch (error) {
    // Write or fsync failed: close fd and clean up temp, aggregating errors
    // so cleanup failures do not hide the original error.
    let closeError = null;
    try { fs_.closeSync(fd); } catch (e) { closeError = e; }
    let unlinkError = null;
    try { fs_.unlinkSync(tmp); } catch (e) { unlinkError = e; }
    let message = 'cannot write journal for ' + journalPath + ': ' + error.message;
    if (closeError !== null) message += '. close also failed: ' + closeError.message;
    if (unlinkError !== null) message += '. cleanup also failed: ' + unlinkError.message;
    throw new Error(message);
  }
  // Lifetime rule: exactly one close for this open, after complete write and
  // fsync. Close failures propagate; publication is aborted so an incomplete
  // journal is never published.
  try {
    fs_.closeSync(fd);
  } catch (error) {
    let unlinkError = null;
    try { fs_.unlinkSync(tmp); } catch { /* cleanup failure aggregated below */ }
    let message =
      'cannot close temporary journal file ' + tmp + ': ' + error.message +
      '; publication aborted to avoid incomplete journal';
    if (unlinkError !== null) message += '. cleanup also failed: ' + unlinkError.message;
    throw new Error(message);
  }
  try {
    fs_.chmodSync(tmp, FILE_MODE);
  } catch {
    // best-effort; default perms remain restrictive on POSIX
  }
  // Publish atomically without replacing any existing journal. link(2) fails
  // with EEXIST if the destination exists, giving atomic no-clobber
  // publication. If publication fails, the temp file is removed and the
  // original (missing or existing) journal is left untouched.
  try {
    fs_.linkSync(tmp, journalPath);
  } catch (error) {
    let unlinkError = null;
    try { fs_.unlinkSync(tmp); } catch { /* cleanup failure aggregated below */ }
    if (error.code === 'EEXIST') {
      const existing = readPendingJournal(recordFile);
      if (existing.status === 'ok' && existing.entry &&
          existing.entry.txHash === entry.txHash &&
          existing.entry.operation === entry.operation &&
          existing.entry.operationId === entry.operationId) {
        const existingStr = JSON.stringify(existing.entry);
        const newStr = JSON.stringify(entry);
        if (existingStr === newStr) {
          try { fs_.unlinkSync(tmp); } catch { /* duplicate already published; cleanup best-effort */ }
          return journalPath;
        }
        throw new Error('cannot persist journal: same operation ID but different payload.');
      }
      if (existing.status === 'terminal_failure') {
        throw new Error('cannot persist journal: an unresolved terminal failure journal already exists at ' + journalPath + '. Resolve it manually.');
      }
      throw new Error('cannot persist journal: an unresolved journal already exists at ' + journalPath + '.');
    }
    let message = 'cannot publish journal at ' + journalPath + ': ' + error.message;
    if (unlinkError !== null) message += '. cleanup also failed: ' + unlinkError.message;
    throw new Error(message);
  }
  // The hard link was created: unlink the temporary name. A cleanup failure
  // here does not undo publication, but it must not silently disappear.
  try {
    fs_.unlinkSync(tmp);
  } catch (error) {
    throw new Error(
      'journal published at ' + journalPath + ' but temporary file cleanup failed: ' + error.message
    );
  }
  const syncResult = fsyncDirectory(directory, fs_);
  reportDirSync(syncResult, 'journal published');
  return journalPath;
}

// Validate and canonicalize a definite-failure receipt before storing it as
// terminal evidence. Never stores raw caller-provided evidence unverified.
function normalizeDefiniteFailureReceipt(receipt, expectedTxHash) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('terminal failure requires a valid receipt object');
  }
  if (typeof receipt.transactionHash !== 'string') {
    throw new Error('receipt transaction hash is missing');
  }
  if (String(receipt.transactionHash).toLowerCase() !== String(expectedTxHash).toLowerCase()) {
    throw new Error('receipt transaction hash does not match the journal hash');
  }
  const status = receipt.status;
  const definiteFailure = status === 0 || status === '0' || status === false || status === 0n;
  if (!definiteFailure) {
    throw new Error('receipt status is not a definite failure value');
  }
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0) {
    throw new Error('receipt has an invalid block number');
  }
  return {
    chainId: receipt.chainId,
    blockHash: typeof receipt.blockHash === 'string' ? receipt.blockHash : undefined,
    blockNumber: receipt.blockNumber,
    transactionHash: String(expectedTxHash).toLowerCase(),
    status: 0,
    gasUsed: typeof receipt.gasUsed === 'bigint' ? receipt.gasUsed.toString()
      : typeof receipt.gasUsed === 'string' ? receipt.gasUsed
      : typeof receipt.gasUsed === 'number' && Number.isFinite(receipt.gasUsed) ? String(receipt.gasUsed)
      : undefined,
  };
}

function persistTerminalFailure(recordFile, failureEvidence, fs_ = fs) {
  const directory = path.dirname(recordFile);
  fs_.mkdirSync(directory, { recursive: true });
  const journalPath = recordFile + '.journal';
  const existing = readPendingJournal(recordFile);
  if (existing.status === 'terminal_failure') {
    return journalPath; // already recorded
  }
  if (existing.status !== 'ok' || !existing.entry) {
    throw new Error('cannot persist terminal failure: journal is missing or unreadable');
  }
  const normalizedReceipt = normalizeDefiniteFailureReceipt(
    failureEvidence && failureEvidence.receipt ? failureEvidence.receipt : null,
    existing.entry.txHash
  );
  const entry = {
    ...existing.entry,
    status: 'failed',
    failedAt: new Date().toISOString(),
    failure: failureEvidence && failureEvidence.failure ? failureEvidence.failure : {},
    receipt: normalizedReceipt,
  };
  const tmp = `${journalPath}.fail-${process.pid}-${Date.now()}`;
  const fd = fs_.openSync(tmp, 'wx', FILE_MODE);
  try {
    const data = `${JSON.stringify(entry, null, 2)}\n`;
    let written = 0;
    while (written < data.length) {
      const n = fs_.writeSync(fd, data, written);
      if (n <= 0) throw new Error('failed to write full journal payload');
      written += n;
    }
    fs_.fsyncSync(fd);
  } catch (error) {
    // Write or fsync failed: close fd and clean up temp, aggregating errors.
    let closeError = null;
    try { fs_.closeSync(fd); } catch (e) { closeError = e; }
    let unlinkError = null;
    try { fs_.unlinkSync(tmp); } catch (e) { unlinkError = e; }
    let message = 'cannot write terminal failure journal: ' + error.message;
    if (closeError !== null) message += '. close also failed: ' + closeError.message;
    if (unlinkError !== null) message += '. cleanup also failed: ' + unlinkError.message;
    throw new Error(message);
  }
  // Close must succeed before publication. Never publish terminal evidence
  // after a failed close. The original pending journal is preserved.
  try {
    fs_.closeSync(fd);
  } catch (error) {
    let unlinkError = null;
    try { fs_.unlinkSync(tmp); } catch { /* cleanup failure aggregated below */ }
    let message =
      'cannot close temporary terminal failure journal ' + tmp + ': ' + error.message +
      '; publication aborted, original pending journal preserved';
    if (unlinkError !== null) message += '. cleanup also failed: ' + unlinkError.message;
    throw new Error(message);
  }
  try {
    fs_.chmodSync(tmp, FILE_MODE);
  } catch {
    // best-effort
  }
  // Same-operation atomic replace (rename over the existing pending journal).
  // If rename fails, the temp file is removed and the original pending
  // journal is preserved untouched.
  let renameError = null;
  try {
    fs_.renameSync(tmp, journalPath);
  } catch (error) {
    renameError = error;
  }
  if (renameError !== null) {
    let unlinkError = null;
    try { fs_.unlinkSync(tmp); } catch (e) { unlinkError = e; }
    let message = 'cannot publish terminal failure journal: ' + renameError.message;
    if (unlinkError !== null) message += '. cleanup also failed: ' + unlinkError.message;
    throw new Error(message);
  }
  // Verify the terminal journal after publication: read it back and confirm
  // it is readable as terminal_failure before returning success.
  const verified = readPendingJournal(recordFile);
  if (verified.status !== 'terminal_failure') {
    throw new Error(
      'terminal failure journal published but read-back verification failed: ' +
        (verified.error || 'unexpected status ' + verified.status)
    );
  }
  const syncResult = fsyncDirectory(directory, fs_);
  reportDirSync(syncResult, 'terminal failure journal published');
  return journalPath;
}

function clearPendingJournal(recordFile, expectedOpId, expectedTxHash, fs_ = fs) {
  if (!expectedOpId) {
    throw new Error('clearPendingJournal requires an operation ID');
  }
  if (!expectedTxHash) {
    throw new Error('clearPendingJournal requires a transaction hash');
  }
  const journalPath = recordFile + '.journal';
  if (!fs_.existsSync(journalPath)) {
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
    fs_.unlinkSync(journalPath);
  } catch (error) {
    throw new Error(`failed to remove journal at ${journalPath}: ${error.message}`);
  }
  // Best-effort directory fsync to make the deletion durable.
  const syncResult = fsyncDirectory(path.dirname(journalPath), fs_);
  reportDirSync(syncResult, 'journal deleted');
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
  fsyncDirectory,
  validateDeploymentTransaction,
  validateBindingTransaction,
};