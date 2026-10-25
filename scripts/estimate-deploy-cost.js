const fs = require('node:fs');
const path = require('node:path');
const { ContractFactory, JsonRpcProvider } = require('ethers');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const CHAIN_ID = 420420777;
const REFERENCE_FROM = '0xf7eC65d11e35375A250e474059a917B537804142';

const targets = [
  {
    name: 'PotERC20',
    file: 'contracts/PotERC20.sol/PotERC20.json',
    args: ['PotToken', 'POT', REFERENCE_FROM],
  },
  {
    name: 'PotERC721',
    file: 'contracts/PotERC721.sol/PotERC721.json',
    args: ['PotToken Collectibles', 'POTC', REFERENCE_FROM],
  },
  {
    name: 'PotRegistry',
    file: 'contracts/PotRegistry.sol/PotRegistry.json',
    args: [],
  },
];

async function main() {
  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
  const feeData = await provider.getFeeData();
  const gasPrice = process.env.POT_GAS_PRICE ? BigInt(process.env.POT_GAS_PRICE) : feeData.gasPrice;
  const from = process.env.POT_ESTIMATE_FROM || REFERENCE_FROM;

  const report = {
    rpc: RPC_URL,
    chainId: Number((await provider.getNetwork()).chainId),
    from,
    gasPrice: gasPrice ? gasPrice.toString() : 'unknown',
    contracts: [],
  };

  let totalGas = 0n;
  let totalCost = 0n;

  for (const target of targets) {
    const artifactPath = path.join(root, 'artifacts', target.file);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`artifact missing: ${target.file}. run npm run compile first`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, provider);
    const data = (await factory.getDeployTransaction(...target.args)).data;
    const creationBytes = (data.length - 2) / 2;
    const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;

    try {
      const gas = await provider.estimateGas({ from, data, gasPrice });
      const cost = gas * gasPrice;
      totalGas += gas;
      totalCost += cost;
      report.contracts.push({
        name: target.name,
        creationBytes,
        runtimeBytes,
        gas: gas.toString(),
        costWei: cost.toString(),
        costTPOT: Number(cost) / 1e18,
      });
    } catch (error) {
      report.contracts.push({
        name: target.name,
        creationBytes,
        runtimeBytes,
        estimateError: error.shortMessage || error.message,
      });
    }
  }

  report.totalGas = totalGas.toString();
  report.totalCostWei = totalCost.toString();
  report.totalCostTPOT = Number(totalCost) / 1e18;
  report.recommendedFundingTPOT = Math.ceil((report.totalCostTPOT * 1.1) / 50) * 50;

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
