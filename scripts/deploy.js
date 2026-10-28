const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const REQUIRED_TPOT = 1350n;
const NATIVE_DECIMALS = 14;
const MAX_CODE_SIZE_BYTES = 10240;

const requiredNativeUnits = REQUIRED_TPOT * 10n ** BigInt(NATIVE_DECIMALS);

export function validateContractArtifact(artifactPath, maxSizeBytes) {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
  if (runtimeBytes > maxSizeBytes) {
    throw new Error(
      `runtime bytecode is ${runtimeBytes} bytes, exceeds limit of ${maxSizeBytes} bytes`
    );
  }
  return runtimeBytes;
}

export function validateChainId(chainId, expectedChainId) {
  if (Number(chainId) !== expectedChainId) {
    throw new Error(
      `wrong chain ID: ${chainId}. Expected ${expectedChainId} (Portaldot V3 testnet).`
    );
  }
}

async function main() {
  const hre = require('hardhat');
  const networkName = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  const gasLimit = Number(process.env.POT_GAS_LIMIT || 5000000);
  const overrides = { gasLimit };

  // --- Pre-flight checks (read-only, before any transaction) ---

  // 1. Validate chain ID
  const network = await hre.ethers.provider.getNetwork();
  validateChainId(network.chainId, 420420777);

  // 2. Validate artifacts exist and each contract's runtime bytecode is within the Revive limit
  const contractsToDeploy = [
    { name: 'PotERC20', file: 'contracts/PotERC20.sol/PotERC20.json' },
    { name: 'PotERC721', file: 'contracts/PotERC721.sol/PotERC721.json' },
    { name: 'PotRegistry', file: 'contracts/PotRegistry.sol/PotRegistry.json' },
  ];

  for (const target of contractsToDeploy) {
    validateContractArtifact(path.join(root, 'artifacts', target.file), MAX_CODE_SIZE_BYTES);
  }

  // 3. Validate deployer balance against required threshold
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  if (balance < requiredNativeUnits) {
    throw new Error(
      `deployer has insufficient native balance: ${balance.toString()} wei (${(balance / 10n ** BigInt(NATIVE_DECIMALS)).toString()} tPOT), need at least ${requiredNativeUnits.toString()} wei (${REQUIRED_TPOT.toString()} tPOT)`
    );
  }

  process.stdout.write(`network   ${networkName}\n`);
  process.stdout.write(`deployer  ${deployer.address}\n`);
  process.stdout.write(`balance   ${hre.ethers.formatEther(balance)} native units\n`);

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
