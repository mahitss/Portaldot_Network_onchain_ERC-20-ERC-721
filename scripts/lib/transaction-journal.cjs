const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transaction } = require('ethers');

const JOURNAL_SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const PORTALDOT_CHAIN_ID = 420420777;

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
  if (options.expectedNonce !== undefined && options.expectedNonce !== null) {
    if (Number(parsed.nonce) !== Number(options.expectedNonce)) {
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
    if (parsed.status !== 'pending') {
      return { status: 'malformed', entry: null, error: 'invalid status (expected pending)' };
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

function persistPendingEntry(recordFile, entry) {
  const directory = path.dirname(recordFile);
  fs.mkdirSync(directory, { recursive: true });
  const journalPath = recordFile + '.journal';

  // Exclusive creation using O_EXCL (wx) — no-clobber.
  let fd;
  try {
    fd = fs.openSync(journalPath, 'wx', FILE_MODE);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw new Error('cannot create journal file ' + journalPath + ': ' + error.message);
    }
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
    throw new Error('cannot persist journal: an unresolved journal already exists at ' + journalPath + '.');
  }
  try {
    fs.writeSync(fd, JSON.stringify(entry, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(journalPath, FILE_MODE);
  } catch {
    // best-effort
  }
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
  } catch {
    // best-effort
  }
}

function validateDeploymentTransaction(signed, journal, expectedDeployer, expectedInitcode) {
  if (!journal || !journal.txHash) {
    throw new Error('validateDeploymentTransaction requires a valid journal with txHash');
  }
  if (!expectedDeployer) {
    throw new Error('validateDeploymentTransaction requires an explicit expected deployer');
  }
  if (!expectedInitcode) {
    throw new Error('validateDeploymentTransaction requires independently reconstructed initcode');
  }
  const parsed = parseAndValidateSignedTx(signed, PORTALDOT_CHAIN_ID, {
    expectedSender: expectedDeployer,
    expectedTxHash: journal.txHash,
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

function validateBindingTransaction(signed, journal, expectedSigner, expectedRegistry, expectedCalldata) {
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
  const parsed = parseAndValidateSignedTx(signed, PORTALDOT_CHAIN_ID, {
    expectedSender: expectedSigner,
    expectedTxHash: journal.txHash,
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
  validateDeploymentTransaction,
  validateBindingTransaction,
};