// Transaction journal for crash-safe broadcast recovery.
//
// Every broadcast is preceded by persisting the exact signed raw transaction
// to an atomic journal file. If the process crashes between journaling and
// broadcasting, a retry can either rebroadcast the exact same signed bytes
// (same txHash, same nonce — no duplicate transaction risk) or fail closed
// with a documented manual recovery path.
//
// The signed raw transaction is replay-capable material: anyone who possesses
// it can broadcast it. It is therefore treated as sensitive:
//   - Never logged
//   - Never committed to Git (see .gitignore)
//   - Written with owner-only file permissions where supported
//   - Validated again before any rebroadcast
//
// Journal entry shape (per pending operation):
//   {
//     operation: 'deploy' | 'bind',
//     contract: 'PotERC20' | 'PotERC721' | 'PotRegistry' | null,
//     txHash: '0x...',            // derived from signed transaction
//     signed: '0x...',            // raw signed transaction bytes (replay-capable!)
//     params: {...},              // human-readable parameters for debugging
//     createdAt: ISO timestamp,
//     attempts: 0,                // broadcast attempt counter
//     status: 'pending'           // 'pending' | 'confirmed' | 'failed'
//   }

const fs = require('node:fs');
const path = require('node:path');
const { Transaction } = require('ethers');

// Owner-only file permissions (0o600) where supported.
const FILE_MODE = 0o600;

const PORTALDOT_CHAIN_ID = 420420777;

// Parse and re-validate a signed raw transaction before any rebroadcast.
// Throws if the signed bytes are malformed or if any critical field
// (chainId, sender/nonce, gas limit) is missing or invalid.
function parseAndValidateSignedTx(signed, expectedChainId, options = {}) {
  if (typeof signed !== 'string' || !/^0x[0-9a-fA-F]*$/.test(signed)) {
    throw new Error('signed transaction is not a valid hex string');
  }
  let parsed;
  try {
    parsed = Transaction.from(signed);
  } catch (error) {
    throw new Error(`cannot parse signed transaction: ${error.message}`);
  }
  // Validate chain ID.
  const chainId = expectedChainId || PORTALDOT_CHAIN_ID;
  if (parsed.chainId !== undefined && BigInt(parsed.chainId) !== BigInt(chainId)) {
    throw new Error(
      `signed transaction chainId ${parsed.chainId} does not match expected chainId ${chainId}; refusing to rebroadcast`
    );
  }
  // Validate nonce.
  if (parsed.nonce === undefined || parsed.nonce === null) {
    throw new Error('signed transaction has no nonce; refusing to rebroadcast');
  }
  // Validate gas limit.
  if (parsed.gasLimit === undefined || parsed.gasLimit === null) {
    throw new Error('signed transaction has no gas limit; refusing to rebroadcast');
  }
  // Validate hash.
  if (!parsed.hash || typeof parsed.hash !== 'string') {
    throw new Error('signed transaction has no derivable hash; refusing to rebroadcast');
  }
  // Validate signer.
  if (options.expectedSender) {
    if (!parsed.from || String(parsed.from).toLowerCase() !== String(options.expectedSender).toLowerCase()) {
      throw new Error(
        `signed transaction sender ${parsed.from} does not match expected sender ${options.expectedSender}; refusing to rebroadcast`
      );
    }
  }
  // Validate transaction hash.
  if (options.expectedTxHash) {
    if (String(parsed.hash).toLowerCase() !== String(options.expectedTxHash).toLowerCase()) {
      throw new Error(
        `signed transaction hash ${parsed.hash} does not match journaled hash ${options.expectedTxHash}; refusing to rebroadcast`
      );
    }
  }
  // Validate nonce against journaled nonce.
  if (options.expectedNonce !== undefined && options.expectedNonce !== null) {
    if (Number(parsed.nonce) !== Number(options.expectedNonce)) {
      throw new Error(
        `signed transaction nonce ${parsed.nonce} does not match journaled nonce ${options.expectedNonce}; refusing to rebroadcast`
      );
    }
  }
  // Validate destination.
  if (options.expectedTo !== undefined) {
    const actualTo = parsed.to ? String(parsed.to).toLowerCase() : null;
    const expectedTo = options.expectedTo ? String(options.expectedTo).toLowerCase() : null;
    if (actualTo !== expectedTo) {
      throw new Error(
        `signed transaction destination ${parsed.to} does not match expected destination ${options.expectedTo}; refusing to rebroadcast`
      );
    }
  }
  // Validate value.
  if (options.expectedValue !== undefined) {
    if (BigInt(parsed.value || 0) !== BigInt(options.expectedValue)) {
      throw new Error(
        `signed transaction value ${parsed.value} does not match expected value ${options.expectedValue}; refusing to rebroadcast`
      );
    }
  }
  // Validate data (initcode or calldata).
  if (options.expectedData !== undefined) {
    if (String(parsed.data || '0x').toLowerCase() !== String(options.expectedData).toLowerCase()) {
      throw new Error('signed transaction data does not match expected operation data; refusing to rebroadcast');
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

// Atomically persist a pending journal entry. Uses replace-atomic write
// (temp file in same directory, then rename) so an interrupted write can
// never leave a half-written journal. File permissions are restricted to
// owner read/write where supported (0o600) because the journal contains
// replay-capable signed transaction bytes.
function persistPendingEntry(recordFile, entry) {
  const directory = path.dirname(recordFile);
  fs.mkdirSync(directory, { recursive: true });
  const journalPath = `${recordFile}.journal`;

  // Exclusive creation: fail if an unresolved journal already exists.
  if (fs.existsSync(journalPath)) {
    const existing = readPendingJournal(recordFile);
    if (existing.status === 'ok' && existing.entry &&
        existing.entry.txHash === entry.txHash &&
        existing.entry.operation === entry.operation) {
      // Same operation — idempotent, allow.
    } else {
      throw new Error(
        `cannot persist journal: an unresolved journal already exists at ${journalPath}. ` +
          'Refusing to overwrite. Resolve the existing journal first.'
      );
    }
  }

  const tmp = `${journalPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: FILE_MODE });
  try {
    fs.chmodSync(tmp, FILE_MODE);
  } catch {
    // best-effort
  }
  try {
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    // best-effort
  }
  try {
    fs.renameSync(tmp, journalPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw new Error(`atomic journal write failed for ${journalPath}: ${error.message}`);
  }
  try {
    fs.chmodSync(journalPath, FILE_MODE);
  } catch {
    // best-effort
  }
  return journalPath;
}

// Read the pending journal entry, if one exists.
// Returns { status: 'missing' | 'ok' | 'malformed', entry, error }.
function readPendingJournal(recordFile) {
  const journalPath = `${recordFile}.journal`;
  if (!fs.existsSync(journalPath)) {
    return { status: 'missing', entry: null, error: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    return { status: 'ok', entry: parsed, error: null };
  } catch (error) {
    return { status: 'malformed', entry: null, error: error.message };
  }
}

// Remove the journal entry after a transaction has been confirmed and the
// deployment record has been updated. Requires matching operation ID and
// txHash to prevent deleting a different journal.
function clearPendingJournal(recordFile, expectedOpId, expectedTxHash) {
  const journalPath = `${recordFile}.journal`;
  if (!fs.existsSync(journalPath)) {
    return; // already cleared
  }
  const existing = readPendingJournal(recordFile);
  if (existing.status === 'ok' && existing.entry) {
    if (expectedOpId && existing.entry.operationId && existing.entry.operationId !== expectedOpId) {
      throw new Error(
        `refusing to clear journal: operation ID mismatch (expected ${expectedOpId}, found ${existing.entry.operationId})`
      );
    }
    if (expectedTxHash && existing.entry.txHash && existing.entry.txHash !== expectedTxHash) {
      throw new Error(
        `refusing to clear journal: txHash mismatch (expected ${expectedTxHash}, found ${existing.entry.txHash})`
      );
    }
  }
  try {
    fs.unlinkSync(journalPath);
  } catch {
    // best-effort; journal may have been removed by a concurrent process
  }
}

module.exports = {
  FILE_MODE,
  parseAndValidateSignedTx,
  persistPendingEntry,
  readPendingJournal,
  clearPendingJournal,
};
