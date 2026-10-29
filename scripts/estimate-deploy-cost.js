const fs = require('node:fs');
const path = require('node:path');
const { ContractFactory, JsonRpcProvider } = require('ethers');
const { assessReleaseBudget, formatUnits, parseFeeMarginPercent, parseRequiredTpot, ceilDiv, EVM_DECIMALS, NATIVE_DECIMALS } = require('./lib/validation.cjs');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const CHAIN_ID = 420420777;
const EVM_DEC = 18;
const REFERENCE_FROM = '0xf7eC65d11e35375A250e474059a917B537804142';
const OUTSTANDING_BINDINGS = 2;

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
  const estimates = [];
  let registryEstimate = null;

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
      estimates.push({ name: target.name, gas: BigInt(gas) });
      if (target.name === 'PotRegistry') registryEstimate = BigInt(gas);
      report.contracts.push({
        name: target.name,
        creationBytes,
        runtimeBytes,
        gas: gas.toString(),
        costWei: cost.toString(),
        costTPOT: formatUnits(cost, EVM_DECIMALS),
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
  // Exact BigInt-derived strings: tPOT values here exceed Number precision.
  report.totalCostTPOT = formatUnits(totalCost, EVM_DECIMALS);
  report.totalCostTPOTApproximate = Number(totalCost) / 1e18;
  report.totalCostTPOTApproximateNote = 'approximate floating-point rendering for glanceability only; costWei/costTPOT above are exact';

  // Whole-release budget: creation subtotal + a binding reserve (the
  // registry creation estimate per outstanding binding is the heaviest
  // MEASURED registry transaction; no bind-call figure exists in the
  // evidence docs) + the configured fee margin. Fail-closed: if any
  // estimate failed, the budget cannot be claimed.
  if (estimates.length === targets.length && registryEstimate !== null && !!gasPrice) {
    const feeMarginPercent = parseFeeMarginPercent(process.env.POT_RELEASE_FEE_MARGIN_PCT);
    const requiredTpotFloor = parseRequiredTpot(process.env.POT_REQUIRED_TPOT);
    const budget = assessReleaseBudget({
      creationEstimatesGas: estimates.map((row) => row.gas),
      bindingEstimateGas: registryEstimate,
      outstandingBindings: OUTSTANDING_BINDINGS,
      gasPriceWei: gasPrice,
      feeMarginPercent,
      requiredTpotFloor,
    });
    const recommendedTpot = ceilDiv(ceilDiv(budget.requiredEvmWei, 10n ** BigInt(EVM_DECIMALS)), 50n) * 50n;
    report.wholeReleaseBudget = {
      label: 'whole-release recommended funding (deployment estimate + binding reserve + margin; not a fee guarantee)',
      feeMarginPercent,
      floorTPOT: requiredTpotFloor.toString(),
      floorApplied: budget.floorApplied,
      deploymentCostWei: budget.deploymentBudgetWei.toString(),
      deploymentCostTPOT: formatUnits(budget.deploymentBudgetWei, EVM_DECIMALS),
      bindingReserve: {
        basis: 'PotRegistry creation estimate per outstanding binding (heaviest measured registry transaction; the actual bind cost is re-measured live in the binding preflight)',
        perBindingGas: registryEstimate.toString(),
        outstandingBindings: OUTSTANDING_BINDINGS,
        costWei: budget.bindingBudgetWei.toString(),
        costTPOT: formatUnits(budget.bindingBudgetWei, EVM_DECIMALS),
      },
      subtotalWei: budget.subtotalWei.toString(),
      marginWei: budget.marginWei.toString(),
      requiredEvmWei: budget.requiredEvmWei.toString(),
      requiredTPOT: formatUnits(budget.requiredEvmWei, EVM_DECIMALS),
      requiredNativeUnits: budget.requiredNativeUnits.toString(),
      requiredNativeTPOT: formatUnits(budget.requiredNativeUnits, NATIVE_DECIMALS),
      recommendedFundingTPOT: recommendedTpot.toString(),
      recommendedBasis: 'ceil(required tPOT) rounded up to a 50 tPOT block',
    };
  } else {
    report.wholeReleaseBudget = {
      unavailable: true,
      blocker: 'a whole-release budget cannot be claimed: one or more creation estimates failed or no gas price was available (fail-closed)',
    };
  }
  report.note =
    'Costs are read-only estimates (creation gas x live gas price), not a guarantee of the next deployment cost. Binding costs are bounded by the registry creation estimate until the live binding preflight re-measures the actual bind calls.';

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}
