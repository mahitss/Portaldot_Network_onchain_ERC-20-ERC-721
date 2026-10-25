const fs = require('node:fs');
const path = require('node:path');

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

  const assetId = Number(process.env.POT_NATIVE_ASSET_ID || 1);
  const nftId = Number(process.env.POT_NATIVE_NFT_ID || 1);
  const nativeAccount = process.env.POT_NATIVE_ACCOUNT || deployments.deployer;
  const hash = process.env.POT_NATIVE_ACCOUNT_HASH || (await nativeAccountHash(nativeAccount));

  if (assetId > 0) {
    const token = deployments.tokens.erc20.address;
    if (await registry.isBound(token)) {
      process.stdout.write(`erc20 already bound: ${token}\n`);
    } else {
      const tx = await registry.bind(token, 0, 1, assetId, 14, 18, hash);
      await tx.wait();
      process.stdout.write(`erc20 bound to native asset ${assetId} in ${tx.hash}\n`);
    }
  }

  if (nftId > 0) {
    const token = deployments.tokens.erc721.address;
    if (await registry.isBound(token)) {
      process.stdout.write(`erc721 already bound: ${token}\n`);
    } else {
      const tx = await registry.bind(token, 1, 2, nftId, 0, 0, hash);
      await tx.wait();
      process.stdout.write(`erc721 bound to native nft collection ${nftId} in ${tx.hash}\n`);
    }
  }

  if (assetId === 0 && nftId === 0) {
    process.stdout.write('set POT_NATIVE_ASSET_ID and/or POT_NATIVE_NFT_ID to bind\n');
  }

  const bindingCount = Number(await registry.bindingCount());
  process.stdout.write(`registry binding count ${bindingCount}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
