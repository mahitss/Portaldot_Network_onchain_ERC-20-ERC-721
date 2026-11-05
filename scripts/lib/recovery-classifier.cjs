// Shared recovery-state classifier for deployment and binding operations.
//
// Classifies provider evidence into one of five states:
//   MINED_SUCCESS  — valid successful receipt exists
//   MINED_FAILURE  — receipt exists but status indicates failure
//   KNOWN_PENDING  — transaction is known but not yet mined
//   UNKNOWN        — transaction and receipt both absent (safe to rebroadcast)
//   AMBIGUOUS      — RPC error, malformed data, or conflicting results

const MINED_SUCCESS = 'MINED_SUCCESS';
const MINED_FAILURE = 'MINED_FAILURE';
const KNOWN_PENDING = 'KNOWN_PENDING';
const UNKNOWN = 'UNKNOWN';
const AMBIGUOUS = 'AMBIGUOUS';

function classifyRecoveryState(receipt, tx, rpcError, expectedTxHash) {
  // RPC error or exception → ambiguous.
  if (rpcError) {
    return AMBIGUOUS;
  }
  // Malformed receipt → ambiguous.
  if (receipt !== null && receipt !== undefined && typeof receipt !== 'object') {
    return AMBIGUOUS;
  }
  // Receipt exists.
  if (receipt && typeof receipt === 'object') {
    // Transaction hash must match the journaled hash exactly (case-insensitive hex).
    if (receipt.transactionHash !== undefined) {
      if (expectedTxHash !== undefined && expectedTxHash !== null) {
        if (String(receipt.transactionHash).toLowerCase() !== String(expectedTxHash).toLowerCase()) {
          return AMBIGUOUS; // receipt does not belong to this transaction
        }
      } else if (!/^0x[0-9a-fA-F]{64}$/.test(String(receipt.transactionHash))) {
        return AMBIGUOUS;
      }
    } else {
      // No transaction hash in receipt — cannot prove identity.
      return AMBIGUOUS;
    }
    // Strict status: 1/'1' → success, 0/'0' → failure, anything else → ambiguous.
    const status = receipt.status;
    if (status === 1 || status === '1' || status === true || status === 1n) {
      if (!isMinedReceipt(receipt)) return AMBIGUOUS;
      return MINED_SUCCESS;
    }
    if (status === 0 || status === '0' || status === false || status === 0n) {
      if (!isMinedReceipt(receipt)) return AMBIGUOUS;
      return MINED_FAILURE;
    }
    return AMBIGUOUS;
  }
  // No receipt. Check if transaction is known.
  if (tx && typeof tx === 'object' && tx.hash) {
    if (expectedTxHash !== undefined && expectedTxHash !== null) {
      if (String(tx.hash).toLowerCase() !== String(expectedTxHash).toLowerCase()) {
        return AMBIGUOUS; // a transaction with a different hash is known — cannot trust it
      }
    }
    return KNOWN_PENDING;
  }
  // Both absent and no RPC error → unknown (safe to rebroadcast).
  if (receipt === null && (tx === null || tx === undefined)) {
    return UNKNOWN;
  }
  // Anything else → ambiguous.
  return AMBIGUOUS;
}

// A mined receipt must carry a valid, non-negative safe-integer block number.
function isMinedReceipt(receipt) {
  const bn = receipt.blockNumber;
  return typeof bn === 'number' && Number.isSafeInteger(bn) && bn >= 0;
}

module.exports = {
  MINED_SUCCESS,
  MINED_FAILURE,
  KNOWN_PENDING,
  UNKNOWN,
  AMBIGUOUS,
  classifyRecoveryState,
};
