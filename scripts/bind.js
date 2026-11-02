// Registry binding for the Portaldot V3 testnet.
//
// bind.js broadcasts binding transactions. It is STAGE-AWARE: after the
// deployment phase has already spent its funds, the binding stage budgets
// only the REMAINING binding transactions (each call is re-estimated live
// with eth_estimateGas at binding time), never the original whole-deployment
// balance again. Every input is still revalidated before the first
// transaction is signed, so direct invocation is exactly as safe as the
// deploy stage of the release:
// - the deployment record must exist, be structurally valid, and belong to
//   this network, chain and identity; the deployed bytecode must be live,
// - both native counterparts must be explicitly configured and must exist
//   (Option::Some) on the native runtime,
// - the remaining-binding funding threshold must be met on both ledgers,
// - an already-bound token is compared against the intended configuration
//   and the run ABORTS on any mismatch - "already bound" is never copied
//   into success, and a recorded completed binding whose record write
//   failed is reconciled by an upsert on rerun (no new transaction),
// - pending binding entries are reconciled from the chain receipt; every
//   new binding's configuration and receipt evidence is persisted to the
//   deployment record atomically, immediately after it is sent.

const fs = require('node:fs');
const path = require('node:path');
const { Transaction } = require('ethers');
const {
  KIND_ERC20,
  KIND_ERC721,
  NATIVE_ASSETS,
  NATIVE_NFTS,
  CHAIN_ID,
  MAX_CODE_SIZE_BYTES,
  compareBinding,
  parseFeeMarginPercent,
  validateDeploymentRecord,
  validateNativeId,
  validateEvmAddress,
  validateReceipt,
} = require('./lib/validation.cjs');
const { runPreflight } = require('./lib/preflight.cjs');
const { buildLiveProbes } = require('./lib/probes.cjs');
const { readJsonRecord, writeJsonAtomic, archiveRecord } = require('./lib/persistence.cjs');
const { acquireLock, releaseLock } = require('./lib/file-lock.cjs');
const { checkJournalGate } = require('./lib/journal-gate.cjs');
const { classifyRecoveryState, MINED_SUCCESS, MINED_FAILURE, KNOWN_PENDING, UNKNOWN, AMBIGUOUS } = require('./lib/recovery-classifier.cjs');
const { parseAndValidateSignedTx, persistPendingEntry, readPendingJournal, clearPendingJournal, validateDeploymentTransaction, validateBindingTransaction } = require('./lib/transaction-journal.cjs');
const { verifyAllDeployments } = require('./lib/deployment-verifier.cjs');
const { loadSharedMapping } = require('./lib/shared-loader.cjs');
const { assertReleasePlanMatchesEnv, validateReleasePlan, validatePlanAgainstRecord } = require('./deploy.js');

const root = path.resolve(__dirname, '..');

function requireRegistryArtifact() {
  const artifactPath = path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json');
  try {
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot read the PotRegistry artifact at ${artifactPath}: ${error.message}. Run "npm run compile" first; a missing registry artifact fails the release closed.`
    );
  }
}

// Resolves the EVM identity whose mapped native account is committed on
// chain. POT_NATIVE_ACCOUNT_EVM is the documented current name;
// POT_NATIVE_ACCOUNT is preserved as legacy alias for backward compatibility
// but is strictly validated as an EVM address: an SS58 address is never
// silently interpreted as an EVM address.
function resolveCommitmentIdentity({ env, deploymentDeployer }) {
  const identityEvmRaw = env.POT_NATIVE_ACCOUNT_EVM ?? env.POT_NATIVE_ACCOUNT;
  if (identityEvmRaw !== undefined && identityEvmRaw !== '') {
    return validateEvmAddress(identityEvmRaw, 'POT_NATIVE_ACCOUNT_EVM');
  }
  return validateEvmAddress(deploymentDeployer, 'deployment record deployer');
}

// Builds the bind-mode preflight configuration. Pure with respect to network
// state; exported so tests can exercise the strict-input rules.
async function buildPreflightConfig({
  env,
  signerAddress,
  deploymentDeployer,
  record,
  networkName,
  registryAddress,
  tokenAddresses,
}) {
  if (!env) {
    throw new Error('environment variables are required');
  }
  const shared = await loadSharedMapping(root);
  const identityEvm = resolveCommitmentIdentity({ env, deploymentDeployer });
  const account = shared.evmAddressToNativeAccount(identityEvm);

  const hashOverride = env.POT_NATIVE_ACCOUNT_HASH;
  let nativeAccountHash;
  let commitmentSource;
  if (hashOverride !== undefined && hashOverride !== '') {
    nativeAccountHash = hashOverride;
    commitmentSource = 'override';
  } else {
    nativeAccountHash = await shared.nativeAccountHash(identityEvm);
    commitmentSource = 'derived';
  }

  const assetIdRaw = env.POT_NATIVE_ASSET_ID;
  const nftIdRaw = env.POT_NATIVE_NFT_ID;
  const missing = [];
  if (assetIdRaw === undefined || assetIdRaw === '') missing.push('POT_NATIVE_ASSET_ID');
  if (nftIdRaw === undefined || nftIdRaw === '') missing.push('POT_NATIVE_NFT_ID');
  if (missing.length > 0) {
    throw new Error(
      `binding requires both native counterparts explicitly configured; missing ${missing.join(' and ')}. A missing id is never treated as a silent NATIVE_NONE opt-out; run a deliberate, documented unbound release instead.`
    );
  }

  return {
    mode: 'bind',
    expectedChainId: CHAIN_ID,
    // The signer executes the bind transactions and its balance must cover
    // the remaining-binding cost.
    deployerEvm: validateEvmAddress(signerAddress, 'signer EVM address'),
    // The identity the record belongs to; the preflight verifies they match.
    identityEvm,
    nativeAccount: { hex: account.hex, ss58: account.ss58 },
    nativeAccountHash,
    commitmentSource,
    networkName,
    record,
    registryAddress,
    tokenAddresses,
    // Bound in runBinding once the outstanding set is known.
    outstandingCalls: [],
    nativeObjects: [
      { kind: 'asset', id: validateNativeId(assetIdRaw, 'POT_NATIVE_ASSET_ID') },
      { kind: 'nft_collection', id: validateNativeId(nftIdRaw, 'POT_NATIVE_NFT_ID') },
    ],
    requireDualCounterparts: true,
    artifacts: [
      { name: 'PotRegistry', file: path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES },
    ],
    feeMarginPercent: parseFeeMarginPercent(env.POT_RELEASE_FEE_MARGIN_PCT),
    gasLimitRaw: null,
  };
}

function expectedBindingEntry(expected) {
  const entry = {
    token: expected.token,
    tokenKind: expected.tokenKind,
    nativeKind: expected.nativeKind,
    nativeId: expected.nativeId,
    nativeDecimals: expected.nativeDecimals,
    evmDecimals: expected.evmDecimals,
    conversionFactor: expected.conversionFactor,
    nativeAccountHash: expected.nativeAccountHash,
    active: true,
  };
  if (expected.txHash) {
    entry.txHash = expected.txHash;
    entry.blockNumber = expected.blockNumber;
    entry.status = 'confirmed';
  } else {
    entry.status = 'preExistingVerified';
  }
  return entry;
}

function upsertBinding(deployments, entry) {
  if (!Array.isArray(deployments.bindings)) {
    deployments.bindings = [];
  }
  const existingIndex = deployments.bindings.findIndex(
    (candidate) => typeof candidate.token === 'string' && candidate.token.toLowerCase() === entry.token.toLowerCase()
  );
  if (existingIndex >= 0) {
    deployments.bindings[existingIndex] = { ...deployments.bindings[existingIndex], ...entry };
  } else {
    deployments.bindings.push(entry);
  }
}

// Reconciles a PENDING binding entry from the chain receipt (crash after
// send). Ambiguous outcomes abort fail-closed.
async function reconcilePendingBinding(entry, probes) {
  const receipt = await probes.receipt(entry.txHash);
  if (receipt === null || receipt === undefined) {
    throw new Error(
      `cannot reconcile the pending binding for ${entry.token}: transaction ${entry.txHash} has no receipt yet. Its outcome is ambiguous, so the binding stage fails closed instead of sending a duplicate transaction. Rerun once the transaction is mined.`
    );
  }
  validateReceipt(entry.txHash, receipt);
  return {
    ...entry,
    blockNumber: Number(receipt.blockNumber),
    status: 'confirmed',
  };
}

// The dependency-injected binding orchestration. All side effects enter
// through injected functions, so tests can run the actual flow offline:
// - recordIo / probes as in runRelease;
// - registryViews: read-only registry queries (isBound, bindingOfToken,
//   bindingCount);
// - bindSender(params, {gasLimit, onSent}) executes one real bind
//   transaction; onSent fires after the transaction is on its way;
// - encodeBind(params) encodes the registry call for the live re-estimate.
// Lock lifecycle is managed by the shared file-lock module.
// See scripts/lib/file-lock.cjs for the implementation.

async function runBinding({
  env,
  recordIo,
  probes,
  recordFile,
  networkName,
  chainId,
  signerAddress,
  registryViews,
  bindSender,
  encodeBind,
  registryAddress,
  tokenAddresses,
  stdout = process.stdout,
  stderr = process.stderr,
  rebroadcastTx,
}) {
  if (!env) throw new Error('environment variables are required');
  for (const [name, value] of Object.entries({ recordIo, probes, recordFile, networkName, chainId, signerAddress, registryViews, bindSender, encodeBind })) {
    if (value === undefined) throw new Error(`runBinding: ${name} is required`);
  }

  // Acquire cross-process lock before any state mutation to prevent
  // concurrent binding processes from signing different operations with the same nonce.
  const lock = acquireLock(recordFile);
  try {
    // SHARED JOURNAL GATE: block all unsafe paths if an unresolved journal exists.
    const gate = checkJournalGate(recordFile, recordIo);
    if (gate.blocked) {
      throw new Error(gate.reason);
    }
    // JOURNAL-FIRST: read and validate the journal before any new signing.
    const existingJournal = readPendingJournal(recordFile);
    if (existingJournal.status === 'ok' && existingJournal.entry) {
      const je = existingJournal.entry;
      const loaded = recordIo.read(recordFile);
      if (loaded.status === 'ok' && loaded.data) {
        const record = loaded.data;
        let matched = false;
        for (const entry of (record.bindings || [])) {
          if (entry && entry.status === 'pending' && entry.txHash === je.txHash) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          throw new Error(
            `an unresolved transaction journal exists (txHash: ${je.txHash}) but no matching pending binding was found in the deployment record. ` +
              'Inspect the journal file and deployment record; reconcile manually before retrying.'
          );
        }
      }
    } else if (existingJournal.status === 'malformed') {
      throw new Error(
        `the transaction journal at ${recordFile}.journal is malformed (${existingJournal.error}). ` +
          'Refusing to proceed. Inspect and resolve the journal manually before retrying.'
      );
    }
    // 1. The record must exist and be strictly valid. Binding never creates
  //    or overwrites a record from nothing.
  const loaded = recordIo.read(recordFile);
  if (loaded.status === 'missing') {
    throw new Error(
      'deployment record not found: ' + recordFile + '. Binding never releases into a void: run the deployment phase first (npm run deploy:testnet).'
    );
  }
  if (loaded.status === 'malformed') {
    throw new Error(
      `deployment file is malformed (${recordFile}): ${loaded.error}. Fix or replace the file; binding refuses to run against an unreadable record.`
    );
  }
  let record;
  try {
    record = validateDeploymentRecord(loaded.data);
  } catch (error) {
    throw new Error(`deployment file is not a valid release record (${recordFile}): ${error.message}`);
  }

  // 2. Record/network identity: binding never operates against a record
  //    from another release.
  if (record.network !== networkName) {
    throw new Error(`deployment record network mismatch: the record says ${record.network}, the connected network is ${networkName}`);
  }
  if (Number(record.chainId) !== Number(chainId)) {
    throw new Error(`deployment record chainId mismatch: the record says ${record.chainId}, the connected chain is ${chainId}`);
  }

  // Validate the frozen release plan against the environment before building
  // the bind preflight config. The plan is authoritative: env drift aborts
  // before any binding transaction is signed.
  if (record.releasePlan) {
    validateReleasePlan(record.releasePlan);
    // Validate plan-to-record consistency: the plan must match the
    // record, the connected network/chain, and the signing identity.
    validatePlanAgainstRecord(record.releasePlan, record, networkName, chainId, signerAddress, env);
    // The bind signer must be the same identity as the deployment deployer.
    const signerEvm = validateEvmAddress(signerAddress, 'signer EVM address');
    if (signerEvm !== record.releasePlan.deployer) {
      throw new Error(
        `bind signer ${signerEvm} does not match the release plan deployer ${record.releasePlan.deployer}. ` +
          'Refusing to bind with a mismatched identity. Use POT_FORCE_FRESH_RELEASE=1 on the deployment to start a new release.'
      );
    }
    assertReleasePlanMatchesEnv(record.releasePlan, env);
  } else {
    // A valid legacy record without a release plan cannot be bound safely:
    // we cannot know the historical token names, symbols, native IDs or
    // commitment, so fail closed.
    throw new Error(
      `the deployment record at ${recordFile} was written before release plans were introduced and has no frozen plan. ` +
        'Refusing to bind without knowing the historical configuration. Set POT_FORCE_FRESH_RELEASE=1 on the deployment to start a new release.'
    );
  }

  // Before signing any binding transaction, verify that all three required
  // contracts have confirmed deployments whose transaction evidence
  // reconciles with the chain. Do not trust bytecode presence alone as
  // proof of deployment identity — the receipt is the source of truth.
  await verifyAllDeployments(record, probes);

  const config = await buildPreflightConfig({
    env,
    signerAddress,
    deploymentDeployer: record.deployer,
    record,
    networkName,
    registryAddress,
    tokenAddresses,
  });

  // 3. Required confirmed entries. A partial record must never be signed
  //    against: the registry and both tokens need live confirmed evidence.
  const registryEntry = record.contracts.PotRegistry;
  if (!registryEntry || registryEntry.status !== 'confirmed' || typeof registryEntry.address !== 'string') {
    throw new Error(
      'the deployment record has no confirmed PotRegistry entry. The deployment phase must complete (or be resumed) before binding; a partial record is never signed against.'
    );
  }
  const recordedRegistry = validateEvmAddress(registryEntry.address, 'PotRegistry address');
  if (registryAddress !== undefined && validateEvmAddress(registryAddress, 'registry address') !== recordedRegistry) {
    throw new Error('the provided registry address does not match the deployment record; refusing to bind against an unexpected contract');
  }
  const tokenEntries = {};
  for (const key of ['erc20', 'erc721']) {
    const token = record.tokens[key];
    if (!token || typeof token.address !== 'string') {
      throw new Error(
        `the deployment record is missing the ${key} token entry; the deployment phase did not complete on the named network. Binding never proceeds on a partial record.`
      );
    }
    tokenEntries[key] = validateEvmAddress(token.address, `${key} token address`);
  }
  for (const [name, key] of [['PotERC20', 'erc20'], ['PotERC721', 'erc721']]) {
    const contractEntry = record.contracts[name];
    if (
      !contractEntry ||
      contractEntry.status !== 'confirmed' ||
      String(contractEntry.address).toLowerCase() !== String(tokenEntries[key]).toLowerCase()
    ) {
      throw new Error(
        `the deployment record is internally inconsistent: ${name} and tokens.${key} disagree. Fix the record deliberately; binding refuses mixed evidence.`
      );
    }
  }

  // 4. Intended binding calls: exactly two, token-kinds pinned in code.
  //    The native ids come ONLY from the explicitly configured environment.
  const intendedCalls = [
    {
      tokens: 'erc20',
      tokenKind: KIND_ERC20,
      nativeKind: NATIVE_ASSETS,
      nativeId: config.nativeObjects.find((object) => object.kind === 'asset').id,
      nativeDecimals: 14,
      evmDecimals: 18,
      label: 'erc20',
    },
    {
      tokens: 'erc721',
      tokenKind: KIND_ERC721,
      nativeKind: NATIVE_NFTS,
      nativeId: config.nativeObjects.find((object) => object.kind === 'nft_collection').id,
      nativeDecimals: 0,
      evmDecimals: 0,
      label: 'erc721',
    },
  ];

  // 5. Reconcile any pending binding entries from chain evidence BEFORE
  //    classifying bound/outstanding, so a completed-but-unrecorded binding
  //    is recovered instead of duplicated.
  let pendingReconciled = 0;
  for (const entry of record.bindings) {
    if (entry && entry.status === 'pending') {
      const journal = readPendingJournal(recordFile);
      const signedTx = (journal.status === 'ok' && journal.entry && journal.entry.txHash === entry.txHash)
        ? journal.entry.signed
        : null;
      if (signedTx) {
        // Rebroadcast the exact same signed transaction instead of signing a
        // new one. This preserves the nonce and txHash, eliminating duplicate
        // transaction risk after a crash between journaling and broadcast.
        // Validate the signed transaction before rebroadcasting.
        const validationJournal = journal;
        const expectedCalldata = (validationJournal.status === 'ok' && validationJournal.entry) ? validationJournal.entry.expectedData : null;
        const vj = validationJournal.entry;
        const parsed = validateBindingTransaction(signedTx, vj, vj.expectedSender, vj.expectedTo, vj.expectedData);
        // Receipt-first: check if already mined.
        const existingReceipt = await probes.receipt(entry.txHash);
        const knownTx = await probes.transaction(entry.txHash);
        const state = classifyRecoveryState(existingReceipt, knownTx, null);
        if (state === MINED_FAILURE) {
          stderr.write(`\\nbinding for ${entry.token}: transaction mined but FAILED; preserving journal for manual recovery\\n`);
          continue;
        }
        if (state === MINED_SUCCESS) {
          const confirmedEntry = { ...entry, blockNumber: existingReceipt.blockNumber, status: 'confirmed' };
          upsertBinding(record, confirmedEntry);
          record.updatedAt = new Date().toISOString();
          recordIo.write(recordFile, record);
          const verifyLoaded = recordIo.read(recordFile);
          if (verifyLoaded.status !== 'ok' || !verifyLoaded.data) {
            throw new Error('failed to verify persisted binding record; journal preserved for recovery');
          }
          pendingReconciled += 1;
          stderr.write(`\\nbinding for ${entry.token}: already mined, reconciled without rebroadcast\\n`);
          const opId = validationJournal.entry.operationId;
          clearPendingJournal(recordFile, opId, entry.txHash);
          continue;
        }
        // Check if transaction is known but pending.
        if (state === KNOWN_PENDING) {
          stderr.write(`\\nbinding for ${entry.token}: transaction known but pending, preserving state\\n`);
          continue;
        }
        if (state === AMBIGUOUS) {
          stderr.write(`\\nbinding for ${entry.token}: recovery state ambiguous; preserving journal\\n`);
          continue;
        }
        const broadcast = await rebroadcastTx(signedTx);
        const receipt = broadcast.receipt;
        validateReceipt(entry.txHash, receipt);
        const confirmedEntry = {
          ...entry,
          blockNumber: receipt.blockNumber,
          status: 'confirmed',
        };
        upsertBinding(record, confirmedEntry);
        record.updatedAt = new Date().toISOString();
        recordIo.write(recordFile, record);
        const verifyLoaded = recordIo.read(recordFile);
        if (verifyLoaded.status !== 'ok' || !verifyLoaded.data) {
          throw new Error('failed to verify persisted binding record; journal preserved for recovery');
        }
        pendingReconciled += 1;
        stderr.write(`\nbinding for ${entry.token}: rebroadcast journaled transaction ${entry.txHash} (no new transaction)\n`);
        const journal = readPendingJournal(recordFile);
        const opId = (journal.status === 'ok' && journal.entry) ? journal.entry.operationId : null;
        clearPendingJournal(recordFile, opId, entry.txHash);
      } else {
        const confirmedEntry = await reconcilePendingBinding(entry, probes);
        upsertBinding(record, confirmedEntry);
        pendingReconciled += 1;
        stderr.write(`\nbinding for ${entry.token}: reconciled from chain receipt ${entry.txHash} (no new transaction)\n`);
      }
    }
  }

  // 6. Classify each intended binding. Already-bound tokens are compared
  //    field-by-field against the intended configuration; any mismatch
  //    aborts BEFORE any transaction is signed. Read-only registry queries
  //    failing is a fail-closed abort too.
  const verified = [];
  const outstanding = [];
  for (const call of intendedCalls) {
    const token = tokenEntries[call.tokens];
    const expected = {
      token,
      tokenKind: call.tokenKind,
      nativeKind: call.nativeKind,
      nativeId: call.nativeId,
      nativeDecimals: call.nativeDecimals,
      evmDecimals: call.evmDecimals,
      conversionFactor: (10n ** BigInt(call.evmDecimals - call.nativeDecimals)).toString(),
      nativeAccountHash: config.nativeAccountHash,
      active: true,
    };

    let bound;
    try {
      bound = await registryViews.isBound(token);
    } catch (error) {
      throw new Error(
        `reading the on-chain binding state for ${call.label} (${token}) failed: ${error.message}. Fail-closed: distinguishing bound from unknown state is required before signing.`
      );
    }
    if (bound) {
      let actual;
      try {
        actual = await registryViews.bindingOfToken(token);
      } catch (error) {
        throw new Error(`reading the on-chain binding for ${call.label} (${token}) failed: ${error.message}`);
      }
      const mismatches = compareBinding(expected, actual);
      if (mismatches.length > 0) {
        stderr.write(`\nthe existing binding for ${token} does not match the intended configuration:\n`);
        stderr.write(`\nthe existing binding for ${token} does not match the intended configuration:\n`);
        for (const mismatch of mismatches) {
          stderr.write(`  mismatch: ${mismatch}\n`);
        }
        throw new Error(
          `aborting before any transaction: the on-chain binding for ${call.label} (${token}) does not match the requested configuration. If matching the existing binding was intended, bind with the values shown above instead of silently accepting the mismatch.`
        );
      }
      verified.push({ call, expected });
      stdout.write(`${call.label}: already bound and consistent with the intended configuration (${token} -> nativeId ${call.nativeId})\n`);
    } else {
      // A confirmed binding entry for this token in the record while the
      // chain reports the token unbound: the record and the chain disagree,
      // and binding must never silently replace recorded evidence.
      const recorded = (record.bindings || []).find(
        (candidate) => candidate && candidate.token && String(candidate.token).toLowerCase() === token.toLowerCase()
      );
      if (recorded && recorded.status === 'confirmed') {
        throw new Error(
          `the record contains a confirmed binding for ${token} (tx ${recorded.txHash}) but the registry reports it unbound; the record and the chain disagree. Resolve the disagreement deliberately before binding (the record is never overwritten silently).`
        );
      }
      outstanding.push({ call, expected });
    }
  }

  // 7. Bind-mode preflight: record identity, bytecode, counterparts, and
  //    the REMAINING-binding budget from live call re-estimates. No
  //    transaction is signed here even if something fails.
  const bindConfig = {
    ...config,
    outstandingCalls: outstanding.map(({ call, expected }) => ({
      label: call.label,
      token: expected.token,
      to: recordedRegistry,
      data: encodeBind(expected),
    })),
  };
  const preflight = await runPreflight(bindConfig, probes);
  stdout.write(`${JSON.stringify(preflight.checks, null, 2)}\n`);
  if (!preflight.ok) {
    throw new Error(
      `binding preflight failed: ${preflight.failures.join('; ')}. No binding transaction was signed.`
    );
  }

  // 8. Persist reconciled and pre-existing-verified evidence (atomic).
  //    A binding already reconciled from a chain receipt (confirmed + txHash)
  //    must not be downgraded to preExistingVerified.
  for (const { expected } of verified) {
    const existing = (record.bindings || []).find(
      (candidate) => candidate && candidate.token && String(candidate.token).toLowerCase() === String(expected.token).toLowerCase()
    );
    if (existing && existing.status === 'confirmed' && existing.txHash) continue;
    upsertBinding(record, expectedBindingEntry(expected));
  }
  if (pendingReconciled > 0 || verified.length > 0) {
    record.updatedAt = new Date().toISOString();
    recordIo.write(recordFile, record);
  }

  // 9. Execute only the outstanding bindings, each with its proven gas
  //    ceiling, persisting pending immediately after send and confirmed
  //    after a validated receipt.
  const bindGasPlan = preflight.bindGasPlan || {};
  let sentCount = 0;
  for (const { call, expected } of outstanding) {
    const gasLimit = bindGasPlan[call.label];
    if (gasLimit === undefined) {
      throw new Error(`no bind gas plan was produced for ${call.label}; refusing to sign a transaction without a proven ceiling`);
    }
    const params = [
      expected.token,
      call.tokenKind,
      call.nativeKind,
      call.nativeId,
      call.nativeDecimals,
      call.evmDecimals,
      config.nativeAccountHash,
    ];
    sentCount += 1;
    const tx = await bindSender(params, {
      gasLimit,
      onSent: (txHash) => {
        const pendingEntry = { ...expectedBindingEntry(expected), txHash, status: 'pending' };
        upsertBinding(record, pendingEntry);
        record.updatedAt = new Date().toISOString();
        recordIo.write(recordFile, record);
      },
    });
    const receipt = await tx.wait();
    validateReceipt(tx.hash, receipt);
    const entry = expectedBindingEntry({ ...expected, txHash: tx.hash, blockNumber: receipt.blockNumber });
    upsertBinding(record, entry);
    record.updatedAt = new Date().toISOString();
    recordIo.write(recordFile, record);
    stdout.write(
      `${call.label}: bound ${expected.token} -> nativeKind ${call.nativeKind}, nativeId ${call.nativeId}, conversionFactor ${entry.conversionFactor}, tx ${tx.hash}\n`
    );
  }

  // 10. Registry count as the final read; a failure here is reported
  //     fail-closed (bindings are already persisted, rerun reconciles).
  let bindingCount;
  try {
    bindingCount = Number(await registryViews.bindingCount());
  } catch (error) {
    throw new Error(`reading the registry binding count failed: ${error.message}`);
  }
  stdout.write(`\nregistry binding count ${bindingCount}\n`);
  stdout.write('next: npm run verify:deployment\n');
  return { record, preflight, sentCount, verifiedCount: verified.length, reconciledCount: pendingReconciled };
  } finally {
    lock.release();
  }
}

async function main() {
  const hre = require('hardhat');
  const networkName = hre.network.name;
  const [signer] = await hre.ethers.getSigners();
  if (!signer) {
    throw new Error('no signer available - set PORTALDOT_DEPLOYER_PRIVATE_KEY or configure the network accounts');
  }
  const provider = hre.ethers.provider;
  const wsUrl = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';

  // Read-only pre-scan so the registry contract can be wired from the
  // recorded evidence before the injected flow takes over.
  const recordFile = path.join(root, 'deployments', `${networkName}.json`);
  const initial = readJsonRecord(recordFile);
  if (initial.status === 'missing') {
    throw new Error(`deployment file not found: ${recordFile}. Run the deployment phase first.`);
  }
  if (initial.status === 'malformed') {
    throw new Error(
      `deployment file is malformed (${recordFile}): ${initial.error}. Fix or replace the file; binding refuses to run against an unreadable record.`
    );
  }
  let record;
  try {
    record = validateDeploymentRecord(initial.data);
  } catch (error) {
    throw new Error(`deployment file is not a valid release record (${recordFile}): ${error.message}`);
  }
  const registryEntry = record.contracts.PotRegistry;
  if (!registryEntry || typeof registryEntry.address !== 'string') {
    throw new Error('the deployment record has no PotRegistry entry; run the deployment phase first.');
  }
  const registryAddress = validateEvmAddress(registryEntry.address, 'PotRegistry address');

  const registry = new hre.ethers.Contract(registryAddress, requireRegistryArtifact().abi, signer);
  const tokenAddresses = {};
  for (const key of ['erc20', 'erc721']) {
    const token = record.tokens ? record.tokens[key] : null;
    if (!token || typeof token.address !== 'string') {
      throw new Error(
        `the deployment record is missing the ${key} token entry; the deployment phase did not complete on the named network. Binding never proceeds on a partial record.`
      );
    }
    tokenAddresses[key] = validateEvmAddress(token.address, `${key} token address`);
  }
  const registryViews = {
    isBound: (token) => registry.isBound(token),
    bindingOfToken: (token) => registry.bindingOfToken(token),
    bindingCount: () => registry.bindingCount(),
  };
  const bindSender = async (params, { gasLimit, onSent } = {}) => {
    const data = registry.interface.encodeFunctionData('bind', [
      params.token,
      BigInt(params.tokenKind),
      BigInt(params.nativeKind),
      BigInt(params.nativeId),
      BigInt(params.nativeDecimals),
      BigInt(params.evmDecimals),
      params.nativeAccountHash,
    ]);
    const network = await provider.getNetwork();
    const nonce = await provider.getTransactionCount(signer.address, 'pending');
    const tx = {
      to: registryAddress,
      data,
      from: signer.address,
      gasLimit,
      chainId: Number(network.chainId),
      nonce,
    };
    // Sign locally: derives the transaction hash without broadcasting.
    const signed = await signer.signTransaction(tx);
    const parsed = Transaction.from(signed);
    const txHash = parsed.hash;
    // Persist the exact signed raw transaction BEFORE broadcasting. If the
    // process crashes now, the journaled signed bytes allow a retry to
    // rebroadcast the exact same transaction (same nonce, same txHash)
    // without risking a duplicate.
    const pendingEntry = {
      schemaVersion: 1,
      operationId: require('node:crypto').randomUUID(),
      operation: 'bind',
      contract: 'PotRegistry',
      txHash,
      signed,
      expectedSender: signer.address,
      chainId: Number(network.chainId),
      nonce: nonce,
      expectedTo: registryAddress,
      expectedValue: '0',
      expectedData: data,
      params: {
        token: params.token,
        tokenKind: params.tokenKind,
        nativeKind: params.nativeKind,
        nativeId: params.nativeId,
        nativeDecimals: params.nativeDecimals,
        evmDecimals: params.evmDecimals,
        nativeAccountHash: params.nativeAccountHash,
      },
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: 'pending',
    };
    persistPendingEntry(recordFile, pendingEntry);
    // Notify the caller (runBinding) so it can update the in-memory record.
    if (onSent) onSent(txHash, signed);
    return provider.broadcastTransaction(signed);
  };
  const encodeBind = (params) =>
    registry.interface.encodeFunctionData('bind', [
      params.token,
      BigInt(params.tokenKind),
      BigInt(params.nativeKind),
      BigInt(params.nativeId),
      BigInt(params.nativeDecimals),
      BigInt(params.evmDecimals),
      params.nativeAccountHash,
    ]);

  const rebroadcastBindTx = async (signed) => {
    // Full validation is performed by runBinding before calling this helper.
    const broadcast = await provider.broadcastTransaction(signed);
    const receipt = await broadcast.wait();
    return { receipt, address: broadcast.contractAddress };
  };

  await runBinding({
    env: process.env,
    recordIo: { read: readJsonRecord, write: writeJsonAtomic, archive: archiveRecord },
    probes: buildLiveProbes({ provider: hre.ethers.provider, wsUrl, from: signer.address }),
    recordFile,
    networkName,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    signerAddress: signer.address,
    registryViews,
    bindSender,
    encodeBind,
    registryAddress,
    tokenAddresses: {
      erc20: tokenAddresses.erc20,
      erc721: tokenAddresses.erc721,
    },
    rebroadcastTx,
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPreflightConfig,
  runBinding,
  expectedBindingEntry,
  upsertBinding,
  resolveCommitmentIdentity,
};
