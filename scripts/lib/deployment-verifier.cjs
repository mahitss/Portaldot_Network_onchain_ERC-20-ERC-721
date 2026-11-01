// Shared deployment verification for both deploy.js and bind.js.
//
// Verifies that each required contract (PotERC20, PotERC721, PotRegistry)
// has a confirmed deployment entry whose transaction evidence reconciles
// with the chain:
//   - the receipt exists on chain
//   - the receipt transaction hash matches the recorded txHash
//   - for contract-creation receipts, receipt.contractAddress matches the
//     recorded address
//   - the receipt block number is valid
//   - the recorded block number matches the receipt block number (if both
//     are present)
//   - runtime bytecode exists at the proven address
//
// Any disagreement aborts fail-closed. Bytecode presence alone is never
// accepted as proof of deployment identity — the receipt is the source of
// truth.

const { validateReceipt } = require('./validation.cjs');

// Verify a single confirmed deployment entry against chain evidence.
// Throws on any disagreement; never invents an address.
async function verifyDeploymentEntry(name, entry, probes) {
  if (!entry || entry.status !== 'confirmed') {
    throw new Error(`${name} has no confirmed deployment entry; cannot verify`);
  }
  if (typeof entry.address !== 'string') {
    throw new Error(`${name} confirmed entry has no address; cannot verify`);
  }
  if (typeof entry.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(entry.txHash)) {
    throw new Error(`${name} confirmed entry has an invalid txHash: ${entry.txHash}`);
  }

  // The receipt must exist on chain. Prefer a dedicated deploymentReceipt
  // probe when available (so binding receipts do not collide), falling
  // back to the generic receipt probe for backwards compatibility.
  const receiptFn = (typeof probes.deploymentReceipt === 'function') ? probes.deploymentReceipt : probes.receipt;
  const receipt = await receiptFn(entry.txHash);
  if (receipt === null || receipt === undefined) {
    throw new Error(
      `cannot reuse ${name}: receipt for recorded transaction ${entry.txHash} is not available on chain. The transaction outcome cannot be proven, so the record is not reused and nothing is redeployed.`
    );
  }

  // The receipt must be successful and its transaction hash must match.
  validateReceipt(entry.txHash, receipt);

  // For contract-creation receipts, the contractAddress must be present and valid.
  if (
    typeof receipt.contractAddress !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(receipt.contractAddress)
  ) {
    throw new Error(
      `cannot reuse ${name}: the receipt for ${entry.txHash} does not contain a valid contract-creation address; refusing to reuse or redeploy`
    );
  }

  // If the journal recorded an address, require it to match the receipt.
  if (String(receipt.contractAddress).toLowerCase() !== String(entry.address).toLowerCase()) {
    throw new Error(
      `cannot reuse ${name}: the receipt contract address ${receipt.contractAddress} does not match the recorded address ${entry.address}; the record and the chain disagree. Refusing to reuse or overwrite.`
    );
  }

  // The receipt block number must be valid.
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0) {
    throw new Error(
      `cannot reuse ${name}: the receipt for ${entry.txHash} has an invalid block number ${JSON.stringify(receipt.blockNumber)}; refusing to reuse or redeploy`
    );
  }

  // Recorded block number, if present, must match the receipt.
  if (typeof entry.blockNumber === 'number' && entry.blockNumber !== receipt.blockNumber) {
    throw new Error(
      `cannot reuse ${name}: the recorded block number ${entry.blockNumber} does not match the receipt block number ${receipt.blockNumber}; the record and the chain disagree.`
    );
  }

  // Runtime bytecode must exist at the proven address.
  const code = await probes.code(receipt.contractAddress);
  if (typeof code !== 'string' || code === '0x') {
    throw new Error(
      `cannot reuse ${name}: the receipt reports success but no bytecode exists at ${receipt.contractAddress}; the outcome is ambiguous, refusing to reuse or redeploy`
    );
  }

  return {
    address: receipt.contractAddress,
    txHash: entry.txHash,
    blockNumber: receipt.blockNumber,
    gasLimit: entry.gasLimit,
    status: 'confirmed',
    codeBytes: typeof code === 'string' ? (code.length - 2) / 2 : 0,
  };
}

// Verify all three required contracts (PotERC20, PotERC721, PotRegistry)
// before any binding transaction is signed. Returns a map of name → verified
// entry. Throws fail-closed on any discrepancy.
async function verifyAllDeployments(record, probes) {
  const REQUIRED_CONTRACT_NAMES = ['PotERC20', 'PotERC721', 'PotRegistry'];
  const verified = {};
  for (const name of REQUIRED_CONTRACT_NAMES) {
    const entry = (record.contracts || {})[name];
    if (!entry || entry.status !== 'confirmed') {
      throw new Error(
        `cannot bind: the deployment record has no confirmed ${name} entry. The deployment phase must complete before binding.`
      );
    }
    verified[name] = await verifyDeploymentEntry(name, entry, probes);
  }
  return verified;
}

module.exports = {
  verifyDeploymentEntry,
  verifyAllDeployments,
};
