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
  // byte equal). If the artifact does not carry usable patch offsets we fail
  // closed rather than silently accept. When both are present, their skip
  // ranges are merged and validated together.
  const bytecodeLength = (expected.length - 2) / 2;
  const allOffsets = [];
  if (hasImmutables) {
    const offsets = getImmutableOffsets(artifact.immutables, bytecodeLength);
    allOffsets.push(...offsets);
  }
  if (hasLinkRefs) {
    const offsets = getLinkReferenceOffsets(linkReferences, bytecodeLength);
    allOffsets.push(...offsets);
  }
  if (allOffsets.length === 0) {
    if (hasImmutables) {
      throw new Error(
        `${name}: artifact reports immutables but no patch offsets are available; automatic verification is not possible; manual inspection is required`
      );
    }
    throw new Error(
      `${name}: artifact reports library link references but no patch offsets are available; automatic verification is not possible; manual inspection is required`
    );
  }
  // Build a descriptive method label based on which patch types are present.
  const labelParts = [];
  if (hasImmutables) labelParts.push('immutables');
  if (hasLinkRefs) labelParts.push('link-references');
  return verifyWithSkipRanges(
    name,
    expected,
    actual,
    allOffsets,
    labelParts.join('+')
  );
  throw new Error(
    `${name}: unsupported bytecode layout; automatic verification is not possible; manual inspection is required`
  );
}

// Validate and extract immutable patch ranges from an artifact's immutables
// metadata. solc emits immutables as an array of { offset, length, ... }.
// Each range is validated: offset and length must be safe integers, offset
// >= 0, length > 0, and offset + length must not exceed the bytecode length.
// Malformed metadata causes a fail-closed throw — no bytecode region is
// silently ignored.
function getImmutableOffsets(immutables, bytecodeLength) {
  const ranges = [];
  if (!Array.isArray(immutables)) return ranges;
  for (const entry of immutables) {
    if (!entry || typeof entry !== 'object') continue;
    const offset = entry.offset !== undefined ? entry.offset : entry.start;
    const length = entry.length !== undefined ? entry.length : 32;
    if (
      typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0 ||
      offset + length > bytecodeLength
    ) {
      throw new Error(
        'artifact immutables metadata has a malformed or out-of-range patch ' +
        '(offset=' + String(offset) + ', length=' + String(length) +
        ', bytecodeLength=' + bytecodeLength + '); refusing to verify'
      );
    }
    ranges.push({ start: offset, length });
  }
  return ranges;
}

// Extract and validate library link-reference patch ranges from a
// linkReferences/deployedLinkReferences object:
//   { "contracts/Foo.sol:Foo": { "Lib": [ { start: 123, length: 20 } ] } }
// solc uses "start" and "length" for link references. Each range is validated
// the same way as immutable patches. Malformed metadata fails closed.
function getLinkReferenceOffsets(linkReferences, bytecodeLength) {
  const ranges = [];
  for (const source of Object.values(linkReferences || {})) {
    for (const lib of Object.values(source || {})) {
      for (const entry of lib || []) {
        if (!entry || typeof entry !== 'object') continue;
        const start = entry.start;
        const length = entry.length;
        if (
          typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 ||
          typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0 ||
          start + length > bytecodeLength
        ) {
          throw new Error(
            'artifact link reference metadata has a malformed or out-of-range patch ' +
            '(start=' + String(start) + ', length=' + String(length) +
            ', bytecodeLength=' + bytecodeLength + '); refusing to verify'
          );
        }
        ranges.push({ start, length });
      }
    }
  }
  return ranges;
}

// Validate that skip ranges do not overlap and are within bounds. Overlapping
// or out-of-range metadata is malformed and fails closed.
function validateSkipRanges(skipRanges, bytecodeLength, label) {
  const sorted = [...skipRanges].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (r.start < 0 || r.start >= bytecodeLength || r.length <= 0 || r.start + r.length > bytecodeLength) {
      throw new Error(
        label + ' patch range out of bounds (start=' + r.start + ', length=' + r.length +
        ', bytecodeLength=' + bytecodeLength + '); refusing to verify'
      );
    }
    if (i > 0 && r.start < sorted[i - 1].start + sorted[i - 1].length) {
      throw new Error(
        label + ' patch ranges overlap; refusing to verify because a bytecode ' +
        'region could be silently ignored'
      );
    }
  }
}

// Compare expected (artifact) vs actual (on-chain) byte arrays, skipping the
// recorded patch ranges. Throws on any unverifiable difference. Malformed
// patch metadata never causes a bytecode region to be silently skipped.
function verifyWithSkipRanges(name, expected, actual, skipRanges, label) {
  // Normalize to hex byte arrays.
  if (expected.length !== actual.length) {
    throw new Error(
      `${name}: runtime bytecode length does not match the compiled artifact (expected ${(expected.length - 2) / 2} bytes, got ${(actual.length - 2) / 2}); refusing to reuse or redeploy`
    );
  }
  const bytecodeLength = (expected.length - 2) / 2;
  const expectedBytes = Buffer.from(expected.slice(2), 'hex');
  const actualBytes = Buffer.from(actual.slice(2), 'hex');

  // Validate patch ranges before using them: malformed metadata fails closed.
  validateSkipRanges(skipRanges, bytecodeLength, label);

  // Build skip set.
  const skip = new Array(bytecodeLength).fill(false);
  for (const range of skipRanges) {
    for (let i = range.start; i < range.start + range.length; i++) {
      skip[i] = true;
    }
  }
  for (let i = 0; i < bytecodeLength; i++) {
    if (skip[i]) continue;
    if (expectedBytes[i] !== actualBytes[i]) {
      throw new Error(
        `${name}: runtime bytecode mismatch at byte offset ${i} (outside ${label} patch regions); deployment identity cannot be proven; refusing to reuse or redeploy`
      );
    }
  }
  return { method: 'patched-' + label, artifact: path.basename(''), bytes: bytecodeLength, patchedRanges: skipRanges.length };
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
