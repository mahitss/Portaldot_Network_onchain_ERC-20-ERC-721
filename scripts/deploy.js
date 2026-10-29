// Release deployment for the Portaldot V3 testnet.
//
// IMPORTANT: this script broadcasts transactions. Everything that can fail
// is validated by runReleasePreflight BEFORE the first transaction memo is
// signed. If any preflight check fails, the deployment aborts with a clear
// report and nothing is broadcast.

const fs = require('node:fs');
const path = require('node:path');
const { validateReceipt } = require('./lib/validation.cjs');
const { runReleasePreflight } = require('./lib/preflight.cjs');
const { buildLiveProbes } = require('./lib/probes.cjs');
const { loadSharedMapping } = require('./lib/shared-loader.cjs');
const {
  CHAIN_ID,
  MAX_CODE_SIZE_BYTES,
  parseRequiredTpot,
  validateNativeId,
  validateEvmAddress,
} = require('./lib/validation.cjs');

const root = path.resolve(__dirname, '..');

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

  return {
    expectedChainId: CHAIN_ID,
    deployerEvm,
    nativeAccount: { hex: account.hex, ss58: account.ss58 },
    nativeAccountHash,
    commitmentSource,
    requiredTpot: parseRequiredTpot(env.POT_REQUIRED_TPOT),
    nativeObjects,
    requireDualCounterparts: true,
    artifacts: [
      { name: 'PotERC20', file: path.join(root, 'artifacts', 'contracts', 'PotERC20.sol', 'PotERC20.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES, args: [erc20Name, erc20Symbol, deployerEvm] },
      { name: 'PotERC721', file: path.join(root, 'artifacts', 'contracts', 'PotERC721.sol', 'PotERC721.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES, args: [erc721Name, erc721Symbol, deployerEvm] },
      { name: 'PotRegistry', file: path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'), maxSizeBytes: MAX_CODE_SIZE_BYTES, args: [] },
    ],
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

async function main() {
  const hre = require('hardhat');
  const networkName = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error('no deployer signer available - set PORTALDOT_DEPLOYER_PRIVATE_KEY or configure the network accounts');
  }
  const wsUrl = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';

  // 1. Build configuration and run the full release preflight. Nothing is
  //    signed, sent, or broadcast yet.
  const config = await buildPreflightConfig({ env: process.env, deployerAddress: deployer.address, wsUrl });
  const probes = buildLiveProbes({ provider: hre.ethers.provider, wsUrl, from: deployer.address });
  const preflight = await runReleasePreflight(config, probes);

  process.stdout.write(`${JSON.stringify(preflight.checks, null, 2)}\n`);
  if (!preflight.ok) {
    throw new Error(
      `release preflight failed: ${preflight.failures.join('; ')}. No transaction was broadcast.`
    );
  }
  process.stdout.write(`\nrelease preflight: all checks passed; broadcasting up to 3 deployment transactions\n\n`);

  const contracts = {};

  for (const artifact of config.artifacts) {
    const factory = await hre.ethers.getContractFactory(artifact.name);
    const gasLimit = preflight.gasPlan[artifact.name];
    const overrides = { gasLimit };
    const contract = await factory.deploy(...artifact.args, overrides);
    const tx = contract.deploymentTransaction();
    if (!tx) throw new Error('contract deployment did not return a transaction');
    const receipt = await tx.wait();
    // Belt and braces: the receipt is validated the same way the verifier does.
    validateReceipt(tx.hash, receipt);
    contracts[artifact.name] = {
      address: await contract.getAddress(),
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasLimit: gasLimit.toString(),
    };
    process.stdout.write(`${artifact.name.padEnd(11)} ${contracts[artifact.name].address} ${tx.hash}\n`);
  }

  const deployments = {
    network: networkName,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    requiredTPOT: preflight.assessment ? config.requiredTpot.toString() : null,
    contracts,
    tokens: {
      erc20: {
        address: contracts.PotERC20.address,
        name: config.tokenConfig.erc20Name,
        symbol: config.tokenConfig.erc20Symbol,
        decimals: 18,
      },
      erc721: {
        address: contracts.PotERC721.address,
        name: config.tokenConfig.erc721Name,
        symbol: config.tokenConfig.erc721Symbol,
      },
    },
    bindings: [],
  };

  const directory = path.join(root, 'deployments');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${networkName}.json`);
  fs.writeFileSync(target, `${JSON.stringify(deployments, null, 2)}\n`);
  process.stdout.write(`\nwrote ${path.relative(root, target)}\n`);
  process.stdout.write('next: npm run bind:testnet (native objects were verified in the preflight), then npm run verify:deployment\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildPreflightConfig, loadArtifact };
