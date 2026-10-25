const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

async function main() {
  const hre = require('hardhat');
  const networkName = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  const gasLimit = Number(process.env.POT_GAS_LIMIT || 5000000);
  const overrides = { gasLimit };

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  process.stdout.write(`network   ${networkName}\n`);
  process.stdout.write(`deployer  ${deployer.address}\n`);
  process.stdout.write(`balance   ${hre.ethers.formatEther(balance)} native units\n`);
  if (balance === 0n) {
    throw new Error('deployer has no native balance, fund the native account first');
  }

  const contracts = {};

  const erc20 = await (await hre.ethers.getContractFactory('PotERC20')).deploy(
    process.env.POT_ERC20_NAME || 'Portaldot Pot Token',
    process.env.POT_ERC20_SYMBOL || 'POT',
    deployer.address,
    overrides
  );
  const erc20Receipt = await erc20.deploymentTransaction().wait();
  contracts.PotERC20 = {
    address: await erc20.getAddress(),
    txHash: erc20.deploymentTransaction().hash,
    blockNumber: erc20Receipt.blockNumber,
  };
  process.stdout.write(`PotERC20   ${contracts.PotERC20.address} ${contracts.PotERC20.txHash}\n`);

  const erc721 = await (await hre.ethers.getContractFactory('PotERC721')).deploy(
    process.env.POT_ERC721_NAME || 'Portaldot Pot Collectibles',
    process.env.POT_ERC721_SYMBOL || 'POTC',
    deployer.address,
    overrides
  );
  const erc721Receipt = await erc721.deploymentTransaction().wait();
  contracts.PotERC721 = {
    address: await erc721.getAddress(),
    txHash: erc721.deploymentTransaction().hash,
    blockNumber: erc721Receipt.blockNumber,
  };
  process.stdout.write(`PotERC721  ${contracts.PotERC721.address} ${contracts.PotERC721.txHash}\n`);

  const registry = await (await hre.ethers.getContractFactory('PotRegistry')).deploy(overrides);
  const registryReceipt = await registry.deploymentTransaction().wait();
  contracts.PotRegistry = {
    address: await registry.getAddress(),
    txHash: registry.deploymentTransaction().hash,
    blockNumber: registryReceipt.blockNumber,
  };
  process.stdout.write(`PotRegistry ${contracts.PotRegistry.address} ${contracts.PotRegistry.txHash}\n`);

  const deployments = {
    network: networkName,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts,
    tokens: {
      erc20: {
        address: contracts.PotERC20.address,
        name: process.env.POT_ERC20_NAME || 'Portaldot Pot Token',
        symbol: process.env.POT_ERC20_SYMBOL || 'POT',
        decimals: 18,
      },
      erc721: {
        address: contracts.PotERC721.address,
        name: process.env.POT_ERC721_NAME || 'Portaldot Pot Collectibles',
        symbol: process.env.POT_ERC721_SYMBOL || 'POTC',
      },
    },
    bindings: [],
  };

  const directory = path.join(root, 'deployments');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${networkName}.json`);
  fs.writeFileSync(target, `${JSON.stringify(deployments, null, 2)}\n`);
  process.stdout.write(`\nwrote ${path.relative(root, target)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
