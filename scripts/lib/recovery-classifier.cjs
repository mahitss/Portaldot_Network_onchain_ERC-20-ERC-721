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

function classifyRecoveryState(receipt, tx, rpcError) {
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
    if (receipt.transactionHash === undefined && receipt.status === undefined) {
      // Malformed receipt (no status, no hash).
      return AMBIGUOUS;
    }
    // Check status without Number() coercion.
    const status = receipt.status;
    if (status === 1 || status === '1' || status === true) {
      return MINED_SUCCESS;
    }
    if (status === 0 || status === '0' || status === false) {
      return MINED_FAILURE;
    }
    // Missing or unrecognized status → ambiguous.
    if (status === undefined || status === null) {
      return AMBIGUOUS;
    }
    return AMBIGUOUS;
  }
  // No receipt. Check if transaction is known.
  if (tx && typeof tx === 'object' && tx.hash) {
    return KNOWN_PENDING;
  }
  // Both absent and no RPC error → unknown (safe to rebroadcast).
  if (receipt === null && (tx === null || tx === undefined)) {
    return UNKNOWN;
  }
  // Anything else → ambiguous.
  return AMBIGUOUS;
}

module.exports = {
  MINED_SUCCESS,
  MINED_FAILURE,
  KNOWN_PENDING,
  UNKNOWN,
  AMBIGUOUS,
  classifyRecoveryState,
};
