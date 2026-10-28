const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const NATIVE_DECIMALS = 14;
const EVM_DECIMALS = 18;
const MAX_UINT32 = (1n << 32n) - 1n;

export function validateNativeId(id, name = 'native ID') {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > Number(MAX_UINT32)) {
    throw new Error(`invalid ${name}: ${id}. Must be an integer in [0, 4294967295].`);
  }
  return parsed;
}

async function main() {
  const hre = require('hardhat');
  const networkName = hre.network.name;
  const deploymentsFile = path.join(
    path.resolve(__dirname, '..'),
    'deployments',
    `${networkName}.json`
  );
  if (!fs.existsSync(deploymentsFile)) {
    throw new Error(`deployment file not found: ${deploymentsFile}`);
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsFile, 'utf8'));
  const [signer] = await hre.ethers.getSigners();

  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(path.resolve(__dirname, '..'), 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json'),
      'utf8'
    )
  );
  const registry = new hre.ethers.Contract(deployments.contracts.PotRegistry.address, artifact.abi, signer);

  const { nativeAccountHash } = await import(
    `file://${path.join(path.resolve(__dirname, '..'), 'shared', 'portaldot.mjs').replace(/\\/g, '/')}`
  );

  // --- Parse and validate native IDs (strict, no defaults) ---
  const assetIdStr = process.env.POT_NATIVE_ASSET_ID;
  const nftIdStr = process.env.POT_NATIVE_NFT_ID;

  let assetId = null;
  let nftId = null;

  if (assetIdStr !== undefined && assetIdStr !== '') {
    assetId = validateNativeId(assetIdStr, 'POT_NATIVE_ASSET_ID');
  }

  if (nftIdStr !== undefined && nftIdStr !== '') {
    nftId = validateNativeId(nftIdStr, 'POT_NATIVE_NFT_ID');
  }

  if (assetId === null && nftId === null) {
    throw new Error(
      'set POT_NATIVE_ASSET_ID and/or POT_NATIVE_NFT_ID to bind. Neither was provided.'
    );
  }

  // --- Native preflight: verify configured native objects exist ---
  const { ApiPromise, WsProvider } = await import('@polkadot/api');
  const WS_URL = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';
  const wsProvider = new WsProvider(WS_URL, 20000);
  const api = await ApiPromise.create({ provider: wsProvider });

  try {
    if (assetId !== null) {
      const asset = await api.query.assets.asset(assetId);
      if (asset === null || asset === undefined) {
        throw new Error(`native asset ${assetId} does not exist on chain`);
      }
      process.stdout.write(`native asset ${assetId} exists: ${asset.toString()}\n`);
    }

    if (nftId !== null) {
      const collection = await api.query.nfts.collection(nftId);
      if (collection === null || collection === undefined) {
        throw new Error(`native NFT collection ${nftId} does not exist on chain`);
      }
      process.stdout.write(`native NFT collection ${nftId} exists: ${collection.toString()}\n`);
    }
  } finally {
    await api.disconnect();
  }

  // --- Native account hash ---
  const nativeAccount = process.env.POT_NATIVE_ACCOUNT || deployments.deployer;
  const hash = process.env.POT_NATIVE_ACCOUNT_HASH || (await nativeAccountHash(nativeAccount));

  if (assetId !== null) {
    const token = deployments.tokens.erc20.address;
    if (await registry.isBound(token)) {
      process.stdout.write(`erc20 already bound: ${token}\n`);
    } else {
      const tx = await registry.bind(token, 0, 1, assetId, 14, 18, hash);
      await tx.wait();
      process.stdout.write(`erc20 bound to native asset ${assetId} in ${tx.hash}\n`);
    }
  }

  if (nftId !== null) {
    const token = deployments.tokens.erc721.address;
    if (await registry.isBound(token)) {
      process.stdout.write(`erc721 already bound: ${token}\n`);
    } else {
      const tx = await registry.bind(token, 1, 2, nftId, 0, 0, hash);
      await tx.wait();
      process.stdout.write(`erc721 bound to native nft collection ${nftId} in ${tx.hash}\n`);
    }
  }

  const bindingCount = Number(await registry.bindingCount());
  process.stdout.write(`registry binding count ${bindingCount}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
