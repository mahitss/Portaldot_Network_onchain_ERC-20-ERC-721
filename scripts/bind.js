// Registry binding for the Portaldot V3 testnet.
//
// bind.js broadcasts binding transactions. Every input is revalidated by the
// shared release preflight before the first transaction is signed, so direct
// invocation is exactly as safe as the deploy step of the release:
// - both native counterparts must be explicitly configured and must exist
//   (Option::Some) on the native runtime,
// - the funding thresholds must be met on both ledgers,
// - the deployment record must be structurally valid,
// - an already-bound token is compared against the intended configuration
//   and the run ABORTS on any mismatch - "already bound" is never copied
//   into success,
// - every new binding's configuration and receipt evidence is persisted to
//   the deployment record in the documented format.

const fs = require('node:fs');
const path = require('node:path');
const {
  KIND_ERC20,
  KIND_ERC721,
  NATIVE_ASSETS,
  NATIVE_NFTS,
  CHAIN_ID,
  MAX_CODE_SIZE_BYTES,
  compareBinding,
  parseRequiredTpot,
  validateDeploymentRecord,
  validateNativeId,
  validateEvmAddress,
  validateReceipt,
} = require('./lib/validation.cjs');
const { runReleasePreflight } = require('./lib/preflight.cjs');
const { buildLiveProbes } = require('./lib/probes.cjs');
const { loadSharedMapping } = require('./lib/shared-loader.cjs');

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

// Builds the preflight configuration for the binding run. Pure with respect
// to network state; exported so tests can exercise the strict-input rules.
async function buildPreflightConfig({ env, signerAddress, deploymentDeployer }) {
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
    expectedChainId: CHAIN_ID,
    deployerEvm: validateEvmAddress(signerAddress, 'signer EVM address'),
    nativeAccount: { hex: account.hex, ss58: account.ss58 },
    nativeAccountHash,
    commitmentSource,
    requiredTpot: parseRequiredTpot(env.POT_REQUIRED_TPOT),
    nativeObjects: [
      { kind: 'asset', id: validateNativeId(assetIdRaw, 'POT_NATIVE_ASSET_ID') },
      { kind: 'nft_collection', id: validateNativeId(nftIdRaw, 'POT_NATIVE_NFT_ID') },
    ],
    requireDualCounterparts: true,
    artifacts: [
      { name: 'PotRegistry', file: path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES },
    ],
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

async function main() {
  const hre = require('hardhat');
  const networkName = hre.network.name;
  const [signer] = await hre.ethers.getSigners();
  if (!signer) {
    throw new Error('no signer available - set PORTALDOT_DEPLOYER_PRIVATE_KEY or configure the network accounts');
  }
  const wsUrl = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';

  const deploymentsFile = path.join(root, 'deployments', `${networkName}.json`);
  if (!fs.existsSync(deploymentsFile)) {
    throw new Error(`deployment file not found: ${deploymentsFile}`);
  }
  let deployments;
  try {
    deployments = JSON.parse(fs.readFileSync(deploymentsFile, 'utf8'));
  } catch (error) {
    throw new Error(
      `deployment file is malformed (${deploymentsFile}): ${error.message}. Fix or replace the file; binding refuses to run against an unreadable record.`
    );
  }
  try {
    validateDeploymentRecord(deployments);
  } catch (error) {
    throw new Error(`deployment file is not a valid release record (${deploymentsFile}): ${error.message}`);
  }

  const registryArtifact = requireRegistryArtifact();
  const registry = new hre.ethers.Contract(
    validateEvmAddress(deployments.contracts.PotRegistry.address, 'PotRegistry address'),
    registryArtifact.abi,
    signer
  );
  const tokenAddresses = {
    erc20: validateEvmAddress(deployments.tokens.erc20.address, 'ERC-20 token address'),
    erc721: validateEvmAddress(deployments.tokens.erc721.address, 'ERC-721 token address'),
  };

  // --- Full preflight revalidation; no binding transaction is signed yet ---
  const config = await buildPreflightConfig({
    env: process.env,
    signerAddress: signer.address,
    deploymentDeployer: deployments.deployer,
  });
  const probes = buildLiveProbes({ provider: hre.ethers.provider, wsUrl, from: signer.address });
  const preflight = await runReleasePreflight(config, probes);
  process.stdout.write(`${JSON.stringify(preflight.checks, null, 2)}\n`);
  if (!preflight.ok) {
    throw new Error(
      `binding preflight failed: ${preflight.failures.join('; ')}. No binding transaction was signed.`
    );
  }

  const calls = [
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

  for (const call of calls) {
    const token = tokenAddresses[call.tokens];
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

    if (await registry.isBound(token)) {
      const actual = await registry.bindingOfToken(token);
      const mismatches = compareBinding(expected, actual);
      if (mismatches.length > 0) {
        process.stderr.write(`\nthe existing binding for ${token} does not match the intended configuration:\n`);
        for (const mismatch of mismatches) {
          process.stderr.write(`  mismatch: ${mismatch}\n`);
        }
        throw new Error(
          `aborting before any transaction: the on-chain binding for ${call.label} (${token}) does not match the requested configuration. If matching the existing binding was intended, bind with the values shown above instead of silently accepting the mismatch.`
        );
      }
      process.stdout.write(`${call.label}: already bound and consistent with the intended configuration (${token} -> nativeId ${call.nativeId})\n`);
      upsertBinding(deployments, expectedBindingEntry(expected));
      writeDeploymentRecordSafe(deploymentsFile, deployments);
      continue;
    }

    // --- Only here is a binding transaction signed ---
    const tx = await registry.bind(
      token,
      call.tokenKind,
      call.nativeKind,
      call.nativeId,
      call.nativeDecimals,
      call.evmDecimals,
      config.nativeAccountHash
    );
    const receipt = await tx.wait();
    // Same validation the verifier applies: confirmed status plus hash match.
    validateReceipt(tx.hash, receipt);
    const entry = expectedBindingEntry({ ...expected, txHash: tx.hash, blockNumber: receipt.blockNumber });
    upsertBinding(deployments, entry);
    writeDeploymentRecordSafe(deploymentsFile, deployments);
    process.stdout.write(
      `${call.label}: bound ${token} -> nativeKind ${call.nativeKind}, nativeId ${call.nativeId}, conversionFactor ${entry.conversionFactor}, tx ${tx.hash}\n`
    );
  }

  let bindingCount;
  try {
    bindingCount = Number(await registry.bindingCount());
  } catch (error) {
    throw new Error(`reading the registry binding count failed: ${error.message}`);
  }
  process.stdout.write(`\nregistry binding count ${bindingCount}\n`);
  process.stdout.write('next: npm run verify:deployment\n');
}

function writeDeploymentRecordSafe(deploymentsFile, deployments) {
  fs.writeFileSync(deploymentsFile, `${JSON.stringify(deployments, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildPreflightConfig, expectedBindingEntry, upsertBinding, resolveCommitmentIdentity };
