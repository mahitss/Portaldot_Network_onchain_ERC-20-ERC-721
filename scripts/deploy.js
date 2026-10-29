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
const {
  CHAIN_ID,
  MAX_CODE_SIZE_BYTES,
  parseRequiredTpot,
  parseFeeMarginPercent,
  validateDeploymentRecord,
  validateEvmAddress,
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

// Builds the preflight configuration from the environment. Exported so tests
// can exercise it offline (it performs no network operations of its own).
async function buildPreflightConfig({ env, deployerAddress, wsUrl }) {
  if (!env) {
    throw new Error('environment variables are required');
  }
  const shared = await loadSharedMapping(root);
  const deployerEvm = validateEvmAddress(deployerAddress, 'deployer EVM address');
  // Pure derivation of the mapped native account from the EVM identity
  // (20-byte H160 + twelve 0xEE bytes, SS58 prefix 42). No network involved.
  const account = shared.evmAddressToNativeAccount(deployerEvm);

  const hashOverride = env.POT_NATIVE_ACCOUNT_HASH;
  let nativeAccountHash;
  let commitmentSource;
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
  const nativeObjects = [
    { kind: 'asset', id: validateNativeId(assetIdRaw, 'POT_NATIVE_ASSET_ID') },
    { kind: 'nft_collection', id: validateNativeId(nftIdRaw, 'POT_NATIVE_NFT_ID') },
  ];

  const erc20Name = env.POT_ERC20_NAME || 'Portaldot Pot Token';
  const erc20Symbol = env.POT_ERC20_SYMBOL || 'POT';
  const erc721Name = env.POT_ERC721_NAME || 'Portaldot Pot Collectibles';
  const erc721Symbol = env.POT_ERC721_SYMBOL || 'POTC';

  const artifacts = [
    { name: 'PotERC20', file: path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES, args: [erc20Name, erc20Symbol, deployerEvm] },
    { name: 'PotERC721', file: path.join(root, 'artifacts', 'contracts', 'PotERC721.sol', 'PotERC721.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES, args: [erc721Name, erc721Symbol, deployerEvm] },
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
    tokenConfig: { erc20Name, erc20Symbol, erc721Name, erc721Symbol },
  };
}

function loadArtifact(artifactFile) {
  try {
    return JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read contract artifact ${artifactFile}: ${error.message}. Run "npm run compile" first.`);
  }
}

function newRecord({ config, networkName, chainId }) {
  return {
    network: networkName,
    chainId: Number(chainId),
    deployer: config.deployerEvm,
    deployedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contracts: {},
    tokens: {},
    bindings: [],
  };
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
  const address = typeof receipt.contractAddress === 'string' ? receipt.contractAddress : entry.address;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`cannot reconcile ${name}: the receipt for ${entry.txHash} does not contain a usable contract address`);
  }
  const code = await probes.code(address);
  if (typeof code !== 'string' || code === '0x') {
    throw new Error(
      `cannot reconcile ${name}: the receipt reports success but no bytecode exists at ${address}; the outcome is ambiguous, refusing to reuse or redeploy`
    );
  }
  return {
    address,
    txHash: entry.txHash,
    blockNumber: Number(receipt.blockNumber),
    gasLimit: entry.gasLimit,
    status: 'confirmed',
  };
}

// A confirmed record entry must still hold live bytecode before it is
// reused: the record and the chain must agree, or the run aborts.
async function verifyConfirmedEntry(name, entry, probes) {
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

  const config = await buildPreflightConfig({ env, deployerAddress, wsUrl });

  // 1. Load the existing record. Malformed or mismatched records are never
  //    silently overwritten; the ONLY replacement is a deliberate fresh
  //    operation that first archives the old file.
  const loaded = recordIo.read(recordFile);
  let record = null;
  const archived = [];
  const reuseNotes = [];
  if (loaded.status === 'missing') {
    record = newRecord({ config, networkName, chainId });
  } else if (loaded.status === 'malformed') {
    if (!forceFresh) {
      throw new Error(
        `the existing deployment record at ${recordFile} is malformed (${loaded.error}). Refusing to overwrite it silently. To replace it deliberately (the old record is archived, never deleted), set POT_FORCE_FRESH_RELEASE=1.`
      );
    }
    archived.push(recordIo.archive(recordFile));
    record = newRecord({ config, networkName, chainId });
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
      record = newRecord({ config, networkName, chainId });
      stderr.write(`fresh release: invalid record archived, starting a clean release\n`);
    }
    if (data) {
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
      if (forceFresh) {
        archived.push(recordIo.archive(recordFile));
        record = newRecord({ config, networkName, chainId });
        stderr.write(`fresh release: explicit fresh deployment archived the existing record, starting clean\n`);
      }
    }
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
        gasPriceWei: null,
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

  // The hardhat executor forwards the onSent hook so the pending record
  // entry is written before the receipt is awaited (crash-after-send
  // recovery) and captures the receipt for validation.
  const deployContract = async (artifact, gasLimit, hooks = {}) => {
    const factory = await hre.ethers.getContractFactory(artifact.name);
    const contract = await factory.deploy(...artifact.args, { gasLimit });
    const tx = contract.deploymentTransaction();
    if (!tx) throw new Error('contract deployment did not return a transaction');
    if (hooks.onSent) hooks.onSent(tx.hash);
    const receipt = await tx.wait();
    if (hooks.onReceipt) hooks.onReceipt(receipt);
    return { txHash: tx.hash, receipt, address: await contract.getAddress() };
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
};
