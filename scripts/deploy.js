// Release deployment for the Portaldot V3 testnet.
//
// IMPORTANT: this script broadcasts transactions. Everything that can fail
// is validated by the mode-aware preflight BEFORE the first transaction memo
// is signed. If any preflight check fails, the deployment aborts with a
// clear report and nothing is broadcast.
//
// The flow is resumable and idempotent:
// - the whole-release budget (outstanding creations + binding reserve +
//   fee margin, in BOTH ledger units) is computed before the first send;
// - every deployment transaction is persisted as a PENDING record entry
//   immediately after it is sent (atomic file replacement), and confirmed
//   only after a validated receipt;
// - on rerun, confirmed record entries are verified against on-chain
//   bytecode and reused; PENDING entries are reconciled from the chain
//   receipt instead of redeploying; ambiguous outcomes abort fail-closed;
// - a malformed or mismatched record is never silently overwritten.
//   Replacing it is ONLY possible through the explicit, archiving
//   POT_FORCE_FRESH_RELEASE operation, which copies the old record aside.

const fs = require('node:fs');
const path = require('node:path');
const { Transaction } = require('ethers');
const {
  CHAIN_ID,
  MAX_CODE_SIZE_BYTES,
  parseRequiredTpot,
  parseFeeMarginPercent,
  validateDeploymentRecord,
  validateEvmAddress,
  validateNativeAccountHash,
  validateNativeId,
  validateReceipt,
  formatUnits,
  EVM_DECIMALS,
  NATIVE_DECIMALS,
  ceilDiv,
} = require('./lib/validation.cjs');
const { runPreflight } = require('./lib/preflight.cjs');
const { buildLiveProbes } = require('./lib/probes.cjs');
const { readJsonRecord, writeJsonAtomic, archiveRecord } = require('./lib/persistence.cjs');
const { loadSharedMapping } = require('./lib/shared-loader.cjs');

const root = path.resolve(__dirname, '..');

// The dual-ledger release binds exactly two native counterparts.
const BINDING_TOTAL = 2;

// Defaults mirrored from buildPreflightConfig so the frozen release plan can
// be validated against the environment on retry without guessing historical
// settings.
const DEFAULT_TOKEN_CONFIG = {
  erc20Name: 'Portaldot Pot Token',
  erc20Symbol: 'POT',
  erc721Name: 'Portaldot Pot Collectibles',
  erc721Symbol: 'POTC',
};
const RELEASE_PLAN_VERSION = 1;

// Builds the preflight configuration from the environment. Exported so tests
// can exercise it offline (it performs no network operations of its own).
//
// When `frozenPlan` is provided (a resume against an existing record that
// carries an immutable release plan), the plan is the authoritative source
// for token metadata, native binding targets and constructor arguments. The
// environment is NOT allowed to drift the plan: callers must validate env
// against the plan before calling this function.
async function buildPreflightConfig({ env, deployerAddress, wsUrl, frozenPlan }) {
  if (!env) {
    throw new Error('environment variables are required');
  }
  const shared = await loadSharedMapping(root);
  const deployerEvm = validateEvmAddress(deployerAddress, 'deployer EVM address');
  // Pure derivation of the mapped native account from the EVM identity
  // (20-byte H160 + twelve 0xEE bytes, SS58 prefix 42). No network involved.
  const account = shared.evmAddressToNativeAccount(deployerEvm);

  let tokenConfig;
  let nativeObjects;
  let nativeAccountHash;
  let commitmentSource;
  let deployer;

  if (frozenPlan) {
    // Resume: the frozen release plan is authoritative. Never re-derive
    // metadata from the environment, which could silently drift a recorded
    // deployment.
    if (!frozenPlan || frozenPlan.version !== RELEASE_PLAN_VERSION) {
      throw new Error(
        `the release plan is missing or uses an unsupported version (${frozenPlan && frozenPlan.version}). Cannot safely resume without guessing historical settings. Use POT_FORCE_FRESH_RELEASE=1 to archive and start a new release.`
      );
    }
    deployer = validateEvmAddress(frozenPlan.deployer, 'release plan deployer');
    if (!frozenPlan.tokenConfig || typeof frozenPlan.tokenConfig !== 'object') {
      throw new Error('the release plan is missing its token configuration');
    }
    tokenConfig = {
      erc20Name: frozenPlan.tokenConfig.erc20Name,
      erc20Symbol: frozenPlan.tokenConfig.erc20Symbol,
      erc721Name: frozenPlan.tokenConfig.erc721Name,
      erc721Symbol: frozenPlan.tokenConfig.erc721Symbol,
    };
    for (const [field, value] of Object.entries(tokenConfig)) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
        throw new Error(`the release plan token config field ${field} is invalid`);
      }
    }
    if (!Array.isArray(frozenPlan.nativeObjects)) {
      throw new Error('the release plan is missing its native binding configuration');
    }
    nativeObjects = frozenPlan.nativeObjects.map((object) => ({
      kind: object.kind,
      id: validateNativeId(object.id, `${object.kind} release plan id`),
    }));
    nativeAccountHash = validateNativeAccountHash(frozenPlan.nativeAccountHash, 'release plan native account hash');
    commitmentSource = frozenPlan.commitmentSource;
    if (commitmentSource !== 'derived' && commitmentSource !== 'override') {
      throw new Error(`the release plan commitment source is invalid: ${commitmentSource}`);
    }
  } else {
    // Fresh: derive everything from the environment.
    const hashOverride = env.POT_NATIVE_ACCOUNT_HASH;
    if (hashOverride !== undefined && hashOverride !== '') {
      nativeAccountHash = hashOverride;
      commitmentSource = 'override';
    } else {
      nativeAccountHash = await shared.nativeAccountHash(deployerEvm);
      commitmentSource = 'derived';
    }

    // Both native counterparts must be explicitly configured. A missing value
    // is never a silent opt-out from the dual-ledger release.
    const assetIdRaw = env.POT_NATIVE_ASSET_ID;
    const nftIdRaw = env.POT_NATIVE_NFT_ID;
    const missing = [];
    if (assetIdRaw === undefined || assetIdRaw === '') missing.push('POT_NATIVE_ASSET_ID');
    if (nftIdRaw === undefined || nftIdRaw === '') missing.push('POT_NATIVE_NFT_ID');
    if (missing.length > 0) {
      throw new Error(
        `the dual-ledger release requires both native counterparts explicitly configured; missing ${missing.join(' and ')}. A missing id is never treated as a silent opt-out.`
      );
    }
    nativeObjects = [
      { kind: 'asset', id: validateNativeId(assetIdRaw, 'POT_NATIVE_ASSET_ID') },
      { kind: 'nft_collection', id: validateNativeId(nftIdRaw, 'POT_NATIVE_NFT_ID') },
    ];

    tokenConfig = {
      erc20Name: env.POT_ERC20_NAME || DEFAULT_TOKEN_CONFIG.erc20Name,
      erc20Symbol: env.POT_ERC20_SYMBOL || DEFAULT_TOKEN_CONFIG.erc20Symbol,
      erc721Name: env.POT_ERC721_NAME || DEFAULT_TOKEN_CONFIG.erc721Name,
      erc721Symbol: env.POT_ERC721_SYMBOL || DEFAULT_TOKEN_CONFIG.erc721Symbol,
    };
    deployer = deployerEvm;
  }

  const artifacts = [
    { name: 'PotERC20', file: path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES, args: [tokenConfig.erc20Name, tokenConfig.erc20Symbol, deployer] },
    { name: 'PotERC721', file: path.join(root, 'artifacts', 'contracts', 'PotERC721.sol', 'PotERC721.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES, args: [tokenConfig.erc721Name, tokenConfig.erc721Symbol, deployer] },
    { name: 'PotRegistry', file: path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES, args: [] },
  ];

  return {
    mode: 'deploy',
    expectedChainId: CHAIN_ID,
    deployerEvm,
    nativeAccount: { hex: account.hex, ss58: account.ss58 },
    nativeAccountHash,
    commitmentSource,
    // POT_REQUIRED_TPOT is a manual whole-release FLOOR: the computed budget
    // (creations + binding reserve + margin) is never lowered below it.
    requiredTpot: parseRequiredTpot(env.POT_REQUIRED_TPOT),
    feeMarginPercent: parseFeeMarginPercent(env.POT_RELEASE_FEE_MARGIN_PCT),
    nativeObjects,
    requireDualCounterparts: true,
    artifacts,
    outstandingArtifacts: artifacts,
    // The binding reserve: every outstanding binding is bounded by the
    // registry creation estimate, the heaviest MEASURED registry
    // transaction (no bind-call figure exists in the evidence docs; the
    // actual bind cost is re-measured live during the binding preflight).
    bindingReserveCount: BINDING_TOTAL,
    bindingReserveArtifact: artifacts.find((artifact) => artifact.name === 'PotRegistry'),
    gasLimitRaw: env.POT_GAS_LIMIT ? String(env.POT_GAS_LIMIT) : null,
    tokenConfig,
  };
}

// Validates that the current environment does not drift the frozen release
// plan. Throws on any conflict so the release aborts before any broadcast
// and the original record is preserved.
function assertReleasePlanMatchesEnv(plan, env) {
  if (!plan || !plan.tokenConfig) {
    throw new Error('cannot validate environment against a missing release plan');
  }
  const tc = plan.tokenConfig;
  const envDefaults = {
    erc20Name: [env.POT_ERC20_NAME, DEFAULT_TOKEN_CONFIG.erc20Name],
    erc20Symbol: [env.POT_ERC20_SYMBOL, DEFAULT_TOKEN_CONFIG.erc20Symbol],
    erc721Name: [env.POT_ERC721_NAME, DEFAULT_TOKEN_CONFIG.erc721Name],
    erc721Symbol: [env.POT_ERC721_SYMBOL, DEFAULT_TOKEN_CONFIG.erc721Symbol],
  };
  for (const [field, [envVal, defaultVal]] of Object.entries(envDefaults)) {
    const effectiveEnv = envVal === undefined || envVal === '' ? defaultVal : envVal;
    if (tc[field] !== effectiveEnv) {
      throw new Error(
        `release plan ${field} (${tc[field]}) conflicts with the configured environment value (${effectiveEnv}). ` +
          'Refusing to drift the recorded deployment configuration. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.'
      );
    }
  }
  const planKinds = new Set((plan.nativeObjects || []).map((object) => object.kind));
  const envKinds = new Set();
  if (env.POT_NATIVE_ASSET_ID !== undefined && env.POT_NATIVE_ASSET_ID !== '') envKinds.add('asset');
  if (env.POT_NATIVE_NFT_ID !== undefined && env.POT_NATIVE_NFT_ID !== '') envKinds.add('nft_collection');
  for (const kind of ['asset', 'nft_collection']) {
    const planned = (plan.nativeObjects || []).find((object) => object.kind === kind);
    const configured = envKinds.has(kind);
    if (planned && !configured) {
      throw new Error(
        `release plan binds native ${kind} id ${planned.id} but the environment does not configure POT_NATIVE_${kind === 'asset' ? 'ASSET' : 'NFT'}_ID. ` +
          'Refusing to drift the recorded deployment configuration. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.'
      );
    }
    if (configured && !planned) {
      throw new Error(
        `the environment configures POT_NATIVE_${kind === 'asset' ? 'ASSET' : 'NFT'}_ID but the release plan does not bind a ${kind}. ` +
          'Refusing to drift the recorded deployment configuration. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.'
      );
    }
    if (planned && configured) {
      const envIdRaw = kind === 'asset' ? env.POT_NATIVE_ASSET_ID : env.POT_NATIVE_NFT_ID;
      const envId = validateNativeId(envIdRaw, `POT_NATIVE_${kind === 'asset' ? 'ASSET' : 'NFT'}_ID`);
      if (planned.id !== envId) {
        throw new Error(
          `release plan binds native ${kind} id ${planned.id} but the environment configures ${envId}. ` +
            'Refusing to drift the recorded deployment configuration. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.'
        );
      }
    }
  }
  // Always compare the native account hash: if the environment uses a derived
  // commitment, recompute it and compare; if an override is set, compare directly.
  let envAccountHash;
  if (env.POT_NATIVE_ACCOUNT_HASH !== undefined && env.POT_NATIVE_ACCOUNT_HASH !== '') {
    envAccountHash = env.POT_NATIVE_ACCOUNT_HASH;
  } else {
    // Derived commitment: SHA-256 of the 32-byte native account (H160 + 12x0xEE).
    // The deployer EVM address from the plan is used since the signer identity
    // must agree with the record deployer (checked separately).
    const { createHash } = require('node:crypto');
    envAccountHash = `0x${createHash('sha256').update(Buffer.from(`${plan.deployer.slice(2)}${'ee'.repeat(12)}`, 'hex')).digest('hex')}`;
  }
  if (envAccountHash !== plan.nativeAccountHash) {
    throw new Error(
      `native account commitment conflicts with the release plan. Expected ${plan.nativeAccountHash}, computed ${envAccountHash}. ` +
        'Refusing to drift the recorded deployment configuration. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.'
    );
  }
}

// Builds the immutable release plan from a validated preflight config.
// The plan is the authoritative source for token metadata, native binding
// targets and constructor arguments on every retry. It must be constructed
// before the first transaction is signed or broadcast and persisted atomically
// in the deployment record.
function buildReleasePlan({ config, networkName, chainId }) {
  if (!config || !config.tokenConfig || !config.nativeObjects) {
    throw new Error('cannot build release plan: config is missing tokenConfig or nativeObjects');
  }
  const assetObject = config.nativeObjects.find((object) => object.kind === 'asset');
  const nftObject = config.nativeObjects.find((object) => object.kind === 'nft_collection');
  if (!assetObject || !nftObject) {
    throw new Error('cannot build release plan: config is missing asset or nft_collection native object');
  }
  return {
    version: RELEASE_PLAN_VERSION,
    network: networkName,
    chainId: Number(chainId),
    deployer: config.deployerEvm,
    tokenConfig: {
      erc20Name: config.tokenConfig.erc20Name,
      erc20Symbol: config.tokenConfig.erc20Symbol,
      erc721Name: config.tokenConfig.erc721Name,
      erc721Symbol: config.tokenConfig.erc721Symbol,
    },
    nativeObjects: [
      { kind: 'asset', id: assetObject.id },
      { kind: 'nft_collection', id: nftObject.id },
    ],
    nativeAccountHash: config.nativeAccountHash,
    commitmentSource: config.commitmentSource,
  };
}

// Validates that a persisted release plan contains all required fields and
// that they are well-formed. Throws on any missing or malformed entry so the
// release fails closed instead of guessing historical settings.
function validateReleasePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('release plan is missing or not an object. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.');
  }
  if (typeof plan.version !== 'number' || plan.version !== RELEASE_PLAN_VERSION) {
    throw new Error(`release plan version is missing or unsupported (${plan && plan.version}). Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.`);
  }
  if (typeof plan.network !== 'string' || plan.network.length === 0) {
    throw new Error('release plan has no network name. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.');
  }
  if (typeof plan.chainId !== 'number' || Number(plan.chainId) !== CHAIN_ID) {
    throw new Error(`release plan chainId is missing or invalid (${JSON.stringify(plan && plan.chainId)}). Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.`);
  }
  if (typeof plan.deployer !== 'string') {
    throw new Error('release plan has no deployer. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.');
  }
  validateEvmAddress(plan.deployer, 'release plan deployer');
  if (!plan.tokenConfig || typeof plan.tokenConfig !== 'object') {
    throw new Error('release plan is missing token configuration. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.');
  }
  for (const field of ['erc20Name', 'erc20Symbol', 'erc721Name', 'erc721Symbol']) {
    if (typeof plan.tokenConfig[field] !== 'string' || plan.tokenConfig[field].length === 0) {
      throw new Error(`release plan tokenConfig.${field} is missing or empty. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.`);
    }
  }
  if (!Array.isArray(plan.nativeObjects) || plan.nativeObjects.length !== 2) {
    throw new Error('release plan has invalid nativeObjects. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.');
  }
  const kinds = new Set(plan.nativeObjects.map((object) => object.kind));
  if (!kinds.has('asset') || !kinds.has('nft_collection')) {
    throw new Error('release plan nativeObjects must include both asset and nft_collection. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.');
  }
  for (const object of plan.nativeObjects) {
    validateNativeId(object.id, `release plan nativeObjects ${object.kind} id`);
  }
  if (typeof plan.nativeAccountHash !== 'string') {
    throw new Error('release plan has no nativeAccountHash. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.');
  }
  validateNativeAccountHash(plan.nativeAccountHash, 'release plan nativeAccountHash');
  if (plan.commitmentSource !== 'derived' && plan.commitmentSource !== 'override') {
    throw new Error('release plan has invalid commitmentSource. Use POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.');
  }
  return plan;
}

function newRecord({ config, networkName, chainId, releasePlan }) {
  return {
    network: networkName,
    chainId: Number(chainId),
    deployer: config.deployerEvm,
    releasePlan: releasePlan || null,
    deployedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contracts: {},
    tokens: {},
    bindings: [],
  };
}

function loadArtifact(artifactFile) {
  try {
    return JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read contract artifact ${artifactFile}: ${error.message}. Run "npm run compile" first.`);
  }
}

// Keeps the tokens table in lockstep with confirmed contract entries; tokens
// only exist once their contract has a confirmed deployment.
function syncTokens(record, tokenConfig) {
  const tokens = {};
  if (record.contracts.PotERC20 && record.contracts.PotERC20.status === 'confirmed') {
    tokens.erc20 = {
      address: record.contracts.PotERC20.address,
      name: tokenConfig.erc20Name,
      symbol: tokenConfig.erc20Symbol,
      decimals: 18,
    };
  }
  if (record.contracts.PotERC721 && record.contracts.PotERC721.status === 'confirmed') {
    tokens.erc721 = {
      address: record.contracts.PotERC721.address,
      name: tokenConfig.erc721Name,
      symbol: tokenConfig.erc721Symbol,
    };
  }
  record.tokens = tokens;
}

// Entries whose binding evidence is already recorded and intended.
function recordedBindingCount(record) {
  if (!Array.isArray(record.bindings)) return 0;
  return record.bindings.filter(
    (entry) => entry && ((typeof entry.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(entry.txHash)) || entry.status === 'preExistingVerified')
  ).length;
}

// Reconciles a PENDING deployment entry from chain evidence. Throws on any
// ambiguous outcome; never invents an address.
async function reconcilePendingEntry(name, entry, probes) {
  const receipt = await probes.receipt(entry.txHash);
  if (receipt === null || receipt === undefined) {
    throw new Error(
      `cannot reconcile ${name}: transaction ${entry.txHash} has no receipt yet. Its outcome is ambiguous (still pending, dropped or unknown), so the release fails closed instead of redeploying. Rerun the release once the transaction is mined to reconcile it from the chain receipt; nothing was broadcast by this run.`
    );
  }
  validateReceipt(entry.txHash, receipt);
  // For a pending contract-creation transaction, the receipt MUST contain a
  // valid contractAddress. Never substitute a stored address: that would
  // permit reusing an unrelated contract.
  if (typeof receipt.contractAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(receipt.contractAddress)) {
    throw new Error(
      `cannot reconcile ${name}: the receipt for ${entry.txHash} does not contain a valid contract-creation address; the outcome is ambiguous, refusing to reuse or redeploy`
    );
  }
  // If the journal recorded an address, require it to match the receipt.
  if (typeof entry.address === 'string' && String(receipt.contractAddress).toLowerCase() !== String(entry.address).toLowerCase()) {
    throw new Error(
      `cannot reconcile ${name}: the receipt contract address ${receipt.contractAddress} does not match the journaled address ${entry.address}; refusing to reuse or redeploy`
    );
  }
  // Require a valid block number for both pending and confirmed entries.
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0) {
    throw new Error(
      `cannot reuse ${name}: the receipt for ${entry.txHash} has an invalid block number ${JSON.stringify(receipt.blockNumber)}; refusing to reuse or redeploy`
    );
  }
  const code = await probes.code(receipt.contractAddress);
  if (typeof code !== 'string' || code === '0x') {
    throw new Error(
      `cannot reconcile ${name}: the receipt reports success but no bytecode exists at ${receipt.contractAddress}; the outcome is ambiguous, refusing to reuse or redeploy`
    );
  }
  return {
    address: receipt.contractAddress,
    txHash: entry.txHash,
    blockNumber: receipt.blockNumber,
    gasLimit: entry.gasLimit,
    status: 'confirmed',
  };
}

// A confirmed record entry must still hold live bytecode before it is
// reused, and its recorded transaction evidence must reconcile with the
// chain: the receipt must exist, be successful, have a matching transaction
// hash, and (for contract creation) its contract address must match the
// recorded address. The record and the chain must agree, or the run aborts.
async function verifyConfirmedEntry(name, entry, probes) {
  const receipt = await probes.receipt(entry.txHash);
  if (receipt === null || receipt === undefined) {
    throw new Error(
      `cannot reuse ${name}: receipt for recorded transaction ${entry.txHash} is not available on chain. The transaction outcome cannot be proven, so the record is not reused and nothing is redeployed. Resolve deliberately or use POT_FORCE_FRESH_RELEASE=1.`
    );
  }
  validateReceipt(entry.txHash, receipt);
  if (
    typeof receipt.contractAddress !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(receipt.contractAddress)
  ) {
    throw new Error(
      `cannot reuse ${name}: the receipt for ${entry.txHash} does not contain a usable contract-creation address; the outcome is ambiguous, refusing to reuse or redeploy`
    );
  }
  if (String(receipt.contractAddress).toLowerCase() !== String(entry.address).toLowerCase()) {
    throw new Error(
      `cannot reuse ${name}: the receipt contract address ${receipt.contractAddress} does not match the recorded address ${entry.address}; the record and the chain disagree. Refusing to reuse or overwrite.`
    );
  }
  if (
    typeof entry.blockNumber === 'number' &&
    typeof receipt.blockNumber === 'number' &&
    entry.blockNumber !== receipt.blockNumber
  ) {
    throw new Error(
      `cannot reuse ${name}: the recorded block number ${entry.blockNumber} does not match the receipt block number ${receipt.blockNumber}; the record and the chain disagree.`
    );
  }
  // Require the receipt's block number to be present and valid.
  if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0) {
    throw new Error(
      `cannot reuse ${name}: the receipt for ${entry.txHash} has an invalid block number ${JSON.stringify(receipt.blockNumber)}; refusing to reuse or redeploy`
    );
  }
  const code = await probes.code(entry.address);
  if (typeof code !== 'string' || code === '0x') {
    throw new Error(
      `the record says ${name} is deployed at ${entry.address} but the chain has no bytecode there; the record and the chain disagree. The record is never silently overwritten - once the disagreement is resolved deliberately, replace the record only through the documented fresh-release operation (POT_FORCE_FRESH_RELEASE=1, which archives the existing file).`
    );
  }
}

// Read-only budget display for the human-facing footer.
function budgetFooter(budget) {
  const requiredTpot = formatUnits(ceilDiv(budget.requiredEvmWei, 10n ** BigInt(EVM_DECIMALS)), 0);
  return `whole-release requirement ${budget.requiredEvmWei} wei (${requiredTpot} whole tPOT at ceil; native requirement ${budget.requiredNativeUnits} units = ${formatUnits(budget.requiredNativeUnits, NATIVE_DECIMALS)} tPOT; margin ${budget.feeMarginPercent}%; floor ${budget.floorApplied ? 'applied' : 'not binding'})`;
}

// The dependency-injected release orchestration. All side effects enter
// through injected functions, so tests can run the actual flow offline:
// - recordIo: { read(file) -> {status, data, error}, write(file, value),
//   archive(file) -> archived path | null } (real: persistence.cjs)
// - probes: chain reads (chainId, balances, gas price, estimates, receipts,
//   bytecode, native runtime) — every read is fail-closed
// - deployContract(artifact, gasLimit, {onSent, onReceipt}) executes one
//   real deployment; onSent fires after the transaction is on its way so
//   the pending record entry is on disk before any await on the receipt.
// - forceFresh: the explicit, archiving fresh-release operation
//   (POT_FORCE_FRESH_RELEASE=1).
async function runRelease({
  env,
  deployerAddress,
  wsUrl,
  recordIo,
  probes,
  deployContract,
  recordFile,
  networkName,
  chainId,
  forceFresh = false,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  if (!env) throw new Error('environment variables are required');
  for (const [name, value] of Object.entries({ recordIo, probes, deployContract, recordFile, networkName, chainId })) {
    if (value === undefined) throw new Error(`runRelease: ${name} is required`);
  }

  // Build the preflight config from the environment first (no frozen plan).
  // This is needed for missing/malformed record branches below. When an
  // existing record carries an immutable release plan, the config is rebuilt
  // with that plan after the record is loaded and env-plan compatibility is
  // validated.
  const config = await buildPreflightConfig({ env, deployerAddress, wsUrl });

  // 1. Load the existing record. Malformed or mismatched records are never
  //    silently overwritten; the ONLY replacement is a deliberate fresh
  //    operation that first archives the old file.
  const loaded = recordIo.read(recordFile);
  let record = null;
  const archived = [];
  const reuseNotes = [];
  let frozenPlan = null;
  if (loaded.status === 'missing') {
    // Fresh release: construct the immutable release plan from the environment
    // before any transaction is signed or broadcast, and persist it in the
    // record. Never reconstruct historical settings from current defaults.
    const releasePlan = buildReleasePlan({ config, networkName, chainId });
    record = newRecord({ config, networkName, chainId, releasePlan });
  } else if (loaded.status === 'malformed') {
    if (!forceFresh) {
      throw new Error(
        `the existing deployment record at ${recordFile} is malformed (${loaded.error}). Refusing to overwrite it silently. To replace it deliberately (the old record is archived, never deleted), set POT_FORCE_FRESH_RELEASE=1.`
      );
    }
    archived.push(recordIo.archive(recordFile));
    const releasePlan = buildReleasePlan({ config, networkName, chainId });
    record = newRecord({ config, networkName, chainId, releasePlan });
    stderr.write(`fresh release: malformed record archived, starting a clean release\n`);
  } else {
    let data = null;
    try {
      data = validateDeploymentRecord(loaded.data);
    } catch (error) {
      if (!forceFresh) {
        throw new Error(
          `the existing deployment record at ${recordFile} is not a valid release record (${error.message}). Refusing to overwrite it silently. To replace it deliberately (the old record is archived, never deleted), set POT_FORCE_FRESH_RELEASE=1.`
        );
      }
      archived.push(recordIo.archive(recordFile));
      const releasePlan = buildReleasePlan({ config, networkName, chainId });
      record = newRecord({ config, networkName, chainId, releasePlan });
      stderr.write(`fresh release: invalid record archived, starting a clean release\n`);
    }
    if (data) {
      // A valid legacy record without a release plan cannot be resumed safely:
      // we cannot know the historical settings, so fail closed with clear
      // recovery instructions unless an explicit fresh release is requested.
      if (!data.releasePlan && !forceFresh) {
        throw new Error(
          `the deployment record at ${recordFile} was written before release plans were introduced and has no frozen plan. Refusing to resume without knowing the historical token names, symbols, native IDs and commitment. Set POT_FORCE_FRESH_RELEASE=1 to archive this record and start a new release.`
        );
      }
      if (data.network !== networkName) {
        throw new Error(
          `the deployment record belongs to network ${data.network}, this run targets ${networkName}. Refusing to mix releases; set POT_FORCE_FRESH_RELEASE=1 only after a deliberate review (it archives the old record).`
        );
      }
      if (Number(data.chainId) !== Number(chainId)) {
        throw new Error(
          `the deployment record chainId ${data.chainId} does not match the connected chain ${chainId}. Refusing to continue.`
        );
      }
      const recordedDeployer = validateEvmAddress(data.deployer, 'deployment record deployer');
      if (recordedDeployer !== config.deployerEvm) {
        throw new Error(
          `the deployment record belongs to a different deployer (${recordedDeployer}, this run signs as ${config.deployerEvm}). Refusing to continue; deployment with the wrong account would silently transfer ownership of the release.`
        );
      }
      record = data;
      // Validate the persisted release plan structurally before using it.
      if (record.releasePlan) {
        validateReleasePlan(record.releasePlan);
      }
      if (forceFresh) {
        archived.push(recordIo.archive(recordFile));
        const releasePlan = buildReleasePlan({ config, networkName, chainId });
        record = newRecord({ config, networkName, chainId, releasePlan });
        stderr.write(`fresh release: explicit fresh deployment archived the existing record, starting clean\n`);
      }
    }
  }

  // When resuming against an existing record that carries an immutable
  // release plan, validate the environment against the plan before deriving
  // the preflight config. The plan is authoritative; env drift aborts before
  // any broadcast and preserves the original record.
  if (record && record.releasePlan) {
    frozenPlan = record.releasePlan;
    assertReleasePlanMatchesEnv(frozenPlan, env);
    const planConfig = await buildPreflightConfig({ env, deployerAddress, wsUrl, frozenPlan });
    // Replace only the plan-derived fields; network/gas/env values stay.
    config.nativeObjects = planConfig.nativeObjects;
    config.tokenConfig = planConfig.tokenConfig;
    config.commitmentSource = planConfig.commitmentSource;
    config.nativeAccountHash = planConfig.nativeAccountHash;
  }

  // 2. Reconcile: pending entries are completed from the chain (post-crash
  //    recovery); confirmed entries are re-verified against live bytecode.
  //    Both are read-only chain queries; nothing is redeployed and nothing
  //    ambiguous silently converts into success.
  for (const [name, entry] of Object.entries(record.contracts)) {
    if (entry.status === 'pending') {
      record.contracts[name] = await reconcilePendingEntry(name, entry, probes);
      reuseNotes.push(`${name}: reconciled from chain receipt ${entry.txHash} (no new transaction)`);
      stderr.write(`\n${name}: reconciled from chain receipt ${entry.txHash}\n`);
    } else {
      await verifyConfirmedEntry(name, entry, probes);
      reuseNotes.push(`${name}: confirmed record entry reused (bytecode verified at ${entry.address})`);
    }
  }

  // 3. Determine the outstanding artifacts; everything confirmed (or just
  //    reconciled) is reused verbatim, so a rerun can never deploy a
  //    duplicate contract or overwrite recorded evidence.
  const outstandingArtifacts = config.artifacts.filter(
    (artifact) => !(record.contracts[artifact.name] && record.contracts[artifact.name].status === 'confirmed')
  );
  const bindingReserveCount = Math.max(0, BINDING_TOTAL - recordedBindingCount(record));

  // 4. The deploy-mode preflight with the ACTUAL outstanding set: the
  //    budget is the remaining whole-release requirement, not a fixed
  //    balance. Nothing is broadcast yet.
  const preflight = await runPreflight(
    { ...config, outstandingArtifacts, bindingReserveCount },
    probes
  );
  stdout.write(`${JSON.stringify(preflight.checks, null, 2)}\n`);
  if (!preflight.ok) {
    throw new Error(
      `release preflight failed: ${preflight.failures.join('; ')}. No transaction was broadcast.`
    );
  }
  if (preflight.budget) {
    stdout.write(`\n${budgetFooter(preflight.budget)}\n`);
  }

  // 5. Persist the record (with the budget evidence) BEFORE the first send.
  record.budget = preflight.budget
    ? {
        feeMarginPercent: preflight.budget.feeMarginPercent,
        gasPriceWei: preflight.budget.gasPriceWei.toString(),
        deploymentBudgetWei: preflight.budget.deploymentBudgetWei.toString(),
        bindingReserveGas: preflight.budget.bindingEstimateGas.toString(),
        bindingCount: preflight.budget.bindingCount.toString(),
        bindingBudgetWei: preflight.budget.bindingBudgetWei.toString(),
        subtotalWei: preflight.budget.subtotalWei.toString(),
        marginWei: preflight.budget.marginWei.toString(),
        requiredEvmWei: preflight.budget.requiredEvmWei.toString(),
        requiredNativeUnits: preflight.budget.requiredNativeUnits.toString(),
        requiredTPOT: formatUnits(ceilDiv(preflight.budget.requiredEvmWei, 10n ** BigInt(EVM_DECIMALS)), 0),
        floorApplied: preflight.budget.floorApplied,
      }
    : null;
  syncTokens(record, config.tokenConfig);
  record.updatedAt = new Date().toISOString();
  recordIo.write(recordFile, record);
  stdout.write(`\nrecord: ${path.relative(root, recordFile) || recordFile}\n`);
  for (const note of reuseNotes) {
    stdout.write(`  ${note}\n`);
  }

  // 6. Execute only the outstanding deployments. Each transaction is
  //    persisted as pending the moment it is sent (before any await on the
  //    receipt), then confirmed atomically after a validated receipt.
  let sentCount = 0;
  for (const artifact of outstandingArtifacts) {
    const gasLimit = preflight.gasPlan[artifact.name];
    if (gasLimit === undefined) {
      throw new Error(`no gas plan was produced for ${artifact.name}; refusing to sign a transaction without a proven ceiling`);
    }
    sentCount += 1;
    const result = await deployContract(artifact, gasLimit, {
      onSent: (txHash) => {
        record.contracts[artifact.name] = {
          txHash,
          gasLimit: gasLimit.toString(),
          status: 'pending',
        };
        syncTokens(record, config.tokenConfig);
        record.updatedAt = new Date().toISOString();
        recordIo.write(recordFile, record);
      },
      onReceipt: (receipt) => {
        if (receipt && Number(receipt.status) !== 1) {
          stderr.write(`${artifact.name}: transaction receipt reported failure (status ${receipt.status}); aborting\n`);
        }
      },
    });
    if (!result || typeof result.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result.txHash)) {
      throw new Error(`${artifact.name}: the deployment result contains no transaction hash`);
    }
    // Belt and braces: the receipt is validated the same way the verifier does.
    validateReceipt(result.txHash, result.receipt);
    const address = result.address !== undefined ? result.address : result.receipt.contractAddress;
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`${artifact.name}: no contract address is available after confirmation (tx ${result.txHash})`);
    }
    record.contracts[artifact.name] = {
      address,
      txHash: result.txHash,
      blockNumber: Number(result.receipt.blockNumber),
      gasLimit: gasLimit.toString(),
      status: 'confirmed',
    };
    syncTokens(record, config.tokenConfig);
    record.updatedAt = new Date().toISOString();
    recordIo.write(recordFile, record);
    stdout.write(`${artifact.name.padEnd(11)} ${address} ${result.txHash}\n`);
  }

  // 7. Human summary; success is only claimed with all three tables complete.
  const deployedNames = config.artifacts.map((artifact) => artifact.name);
  const complete = deployedNames.every((name) => record.contracts[name] && record.contracts[name].status === 'confirmed');
  stdout.write(`\ndeployment phase: ${sentCount} transaction(s) sent, ${deployedNames.length - outstandingArtifacts.length} reused\n`);
  if (!complete) {
    throw new Error('the deployment phase ended without every required contract confirmed; the record reflects exactly what succeeded and the run fails closed');
  }
  stdout.write('next: npm run bind:testnet (binding re-runs its own stage-aware preflight), then npm run verify:deployment\n');
  return { record, preflight, sentCount, reusedCount: deployedNames.length - outstandingArtifacts.length, archived };
}

async function main() {
  const hre = require('hardhat');
  const networkName = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error('no deployer signer available - set PORTALDOT_DEPLOYER_PRIVATE_KEY or configure the network accounts');
  }
  const wsUrl = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';

  const directory = path.join(root, 'deployments');
  fs.mkdirSync(directory, { recursive: true });
  const recordFile = path.join(directory, `${networkName}.json`);

  // Pre-broadcast journaling executor: each deployment transaction is signed
  // locally, its hash is derived, and the pending journal entry is persisted
  // (via hooks.onSent) BEFORE the exact signed transaction is broadcast.
  // This closes the broadcast-to-persistence gap: a crash between signing and
  // broadcasting leaves a journaled pending entry that can be reconciled from
  // its recorded transaction hash on retry, without generating a duplicate.
  // No private key or signing secret is ever written to the journal.
  const provider = hre.ethers.provider;
  const deployContract = async (artifact, gasLimit, hooks = {}) => {
    const factory = await hre.ethers.getContractFactory(artifact.name);
    const deployTx = await factory.getDeployTransaction(...artifact.args);
    const network = await provider.getNetwork();
    const nonce = await provider.getTransactionCount(deployer.address, 'pending');
    const tx = {
      data: deployTx.data,
      from: deployer.address,
      gasLimit,
      chainId: Number(network.chainId),
      nonce,
      ...(deployTx.maxFeePerGas !== undefined ? { maxFeePerGas: deployTx.maxFeePerGas } : {}),
      ...(deployTx.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: deployTx.maxPriorityFeePerGas } : {}),
      ...(deployTx.gasPrice !== undefined ? { gasPrice: deployTx.gasPrice } : {}),
    };
    // Sign locally: derives the transaction hash without broadcasting.
    const signed = await deployer.signTransaction(tx);
    const parsed = Transaction.from(signed);
    const txHash = parsed.hash;
    // Persist the pending journal entry BEFORE broadcasting the exact signed
    // transaction. If the process crashes now, the journaled txHash allows
    // reconciliation on retry without a duplicate broadcast.
    if (hooks.onSent) hooks.onSent(txHash);
    const broadcast = await provider.broadcastTransaction(signed);
    const receipt = await broadcast.wait();
    if (hooks.onReceipt) hooks.onReceipt(receipt);
    return { txHash, receipt, address: broadcast.contractAddress };
  };

  await runRelease({
    env: process.env,
    deployerAddress: deployer.address,
    wsUrl,
    recordIo: { read: readJsonRecord, write: writeJsonAtomic, archive: archiveRecord },
    probes: buildLiveProbes({ provider: hre.ethers.provider, wsUrl, from: deployer.address }),
    deployContract,
    recordFile,
    networkName,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    forceFresh: String(process.env.POT_FORCE_FRESH_RELEASE || '') === '1',
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
  loadArtifact,
  runRelease,
  BINDING_TOTAL,
  assertReleasePlanMatchesEnv,
  validateReleasePlan,
};
