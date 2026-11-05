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
const fs = require('node:fs');
const path = require('node:path');

// Read and structurally validate a compiled artifact. Fails closed on any
// missing or invalid data — never guesses a bytecode shape.
function readArtifact(artifactPath) {
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read artifact at ${artifactPath}: ${error.message}`);
  }
  if (!artifact || typeof artifact !== 'object') {
    throw new Error(`artifact at ${artifactPath} is not an object`);
  }
  if (typeof artifact.deployedBytecode !== 'string' ||
      !/^0x[0-9a-fA-F]*$/.test(artifact.deployedBytecode) ||
      (artifact.deployedBytecode.length - 2) % 2 !== 0) {
    throw new Error(`artifact at ${artifactPath} has an invalid or missing deployedBytecode`);
  }
  if (typeof artifact.bytecode !== 'string' ||
      !/^0x[0-9a-fA-F]*$/.test(artifact.bytecode)) {
    throw new Error(`artifact at ${artifactPath} has an invalid or missing bytecode`);
  }
  return artifact;
}

// Verify that runtime `code` matches the artifact's deployedBytecode, with
// awareness of Solidity constructs that legitimately differ:
//   - immutable variables: constructor-set values patched into the runtime
//     code; artifact stores offsets, not values.
//   - library link references: artifact stores placeholders padded to 20
//     bytes; runtime code contains the deployed library addresses.
// In this codebase neither applies: artifacts have empty linkReferences and
// no immutables metadata. Therefore exact match is required. If a future
// artifact reports immutables or link references, comparison fails closed
// with an explicit manual-verification requirement rather than guessing.
function verifyArtifactRuntimeCode(name, artifactPath, code) {
  const artifact = readArtifact(artifactPath);
  const expected = String(artifact.deployedBytecode).toLowerCase();
  const actual = String(code || '').toLowerCase();

  const linkReferences = artifact.deployedLinkReferences || artifact.linkReferences || {};
  const hasLinkRefs = Object.keys(linkReferences).length > 0;
  const hasImmutables =
    (Array.isArray(artifact.immutables) && artifact.immutables.length > 0) ||
    (artifact.immutables && typeof artifact.immutables === 'object' &&
      Object.keys(artifact.immutables).length > 0);

  if (!hasLinkRefs && !hasImmutables) {
    if (actual === expected) {
      return { method: 'exact', artifact: path.basename(artifactPath), bytes: (actual.length - 2) / 2 };
    }
    throw new Error(
      `${name}: runtime bytecode does not match the compiled artifact; deployment identity cannot be proven; refusing to reuse or redeploy`
    );
  }

  // Immutables and/or link references are present. We can still verify:
  // compare only the non-patched regions (length match + every non-patched
  // byte equal). If the artifact does not carry the patch offsets we fail
  // closed rather than silently accept.
  if (hasImmutables) {
    const offsets = getImmutableOffsets(artifact.immutables);
    if (offsets.length === 0) {
      throw new Error(
        `${name}: artifact reports immutables but no patch offsets are available; automatic verification is not possible; manual inspection is required`
      );
    }
    return verifyWithSkipRanges(name, expected, actual, offsets, 'immutables');
  }
  if (hasLinkRefs) {
    const offsets = getLinkReferenceOffsets(linkReferences);
    if (offsets.length === 0) {
      throw new Error(
        `${name}: artifact reports library link references but no patch offsets are available; automatic verification is not possible; manual inspection is required`
      );
    }
    return verifyWithSkipRanges(name, expected, actual, offsets, 'link-references');
  }
  throw new Error(
    `${name}: unsupported bytecode layout; automatic verification is not possible; manual inspection is required`
  );
}

// Extract absolute byte offsets of immutable patches from solc metadata.
function getImmutableOffsets(immutables) {
  const ranges = [];
  if (Array.isArray(immutables)) {
    for (const entry of immutables) {
      if (entry && Number.isSafeInteger(entry.start) && entry.start >= 0 &&
          (Number.isSafeInteger(entry.length) ? entry.length : 32) >= 0) {
        ranges.push({ start: entry.start, length: Number.isSafeInteger(entry.length) ? entry.length : 32 });
      }
    }
  }
  return ranges;
}

// Extract absolute byte offsets from a solc linkReferences object:
//   { "contracts/PotRegistry.sol:PotRegistry": { "Library": [ { start: 123, length: 20 } ] } }
function getLinkReferenceOffsets(linkReferences) {
  const ranges = [];
  for (const source of Object.values(linkReferences || {})) {
    for (const lib of Object.values(source || {})) {
      for (const entry of lib || []) {
        if (entry && Number.isSafeInteger(entry.start) && Number.isSafeInteger(entry.length)) {
          ranges.push({ start: entry.start, length: entry.length });
        }
      }
    }
  }
  return ranges;
}

// Compare expected (artifact) vs actual (on-chain) byte arrays, skipping the
// recorded patch ranges. Throws on any unverifiable difference.
function verifyWithSkipRanges(name, expected, actual, skipRanges, label) {
  // Normalize to hex byte arrays.
  if (expected.length !== actual.length) {
    throw new Error(
      `${name}: runtime bytecode length does not match the compiled artifact (expected ${(expected.length - 2) / 2} bytes, got ${(actual.length - 2) / 2}); refusing to reuse or redeploy`
    );
  }
  const expectedBytes = Buffer.from(expected.slice(2), 'hex');
  const actualBytes = Buffer.from(actual.slice(2), 'hex');
  // Build skip set.
  const skip = new Array(expectedBytes.length).fill(false);
  for (const range of skipRanges) {
    for (let i = range.start; i < range.start + range.length && i < skip.length; i++) {
      skip[i] = true;
    }
  }
  for (let i = 0; i < expectedBytes.length; i++) {
    if (skip[i]) continue;
    if (expectedBytes[i] !== actualBytes[i]) {
      throw new Error(
        `${name}: runtime bytecode mismatch at byte offset ${i} (outside ${label} patch regions); deployment identity cannot be proven; refusing to reuse or redeploy`
      );
    }
  }
  return { method: 'patched-' + label, artifact: path.basename(''), bytes: expectedBytes.length, patchedRanges: skipRanges.length };
}

// Verify a single confirmed deployment entry against chain evidence.
// Throws on any disagreement; never invents an address.
// If `artifactPath` is provided, runtime bytecode must match the artifact
// (with immutable/link-reference handling) — not just be non-empty.
async function verifyDeploymentEntry(name, entry, probes, artifactPath) {
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

  // If an artifact path is provided, the runtime code must match the
  // compiled artifact — not merely exist. Immutables and library link
  // references are handled; incompatible layouts fail closed.
  if (artifactPath) {
    verifyArtifactRuntimeCode(name, artifactPath, code);
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
// If `artifacts` (name → artifact file path) is provided, runtime bytecode
// is verified against the compiled artifacts — not merely non-empty.
async function verifyAllDeployments(record, probes, artifacts) {
  const REQUIRED_CONTRACT_NAMES = ['PotERC20', 'PotERC721', 'PotRegistry'];
  const verified = {};
  for (const name of REQUIRED_CONTRACT_NAMES) {
    const entry = (record.contracts || {})[name];
    if (!entry || entry.status !== 'confirmed') {
      throw new Error(
        `cannot bind: the deployment record has no confirmed ${name} entry. The deployment phase must complete before binding.`
      );
    }
    const artifactPath = artifacts ? artifacts[name] : undefined;
    verified[name] = await verifyDeploymentEntry(name, entry, probes, artifactPath);
  }
  return verified;
}

module.exports = {
  verifyDeploymentEntry,
  verifyAllDeployments,
  verifyArtifactRuntimeCode,
};
