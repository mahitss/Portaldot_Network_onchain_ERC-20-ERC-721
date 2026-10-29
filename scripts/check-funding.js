// Funding preflight for the Portaldot V3 deployer account.
//
// The gate is WHOLE-RELEASE aware: it computes the full remaining release
// cost before the first deployment transaction is signed - every measured
// creation estimate x the live gas price, the binding reserve (the registry
// creation estimate per outstanding binding is the heaviest MEASURED
// registry transaction; no bind-call figure exists in the evidence docs,
// and the actual bind cost is re-measured live during the binding
// preflight), plus the configured fee-fluctuation margin. The gate requires
// SUCCESSFUL reads of BOTH the mapped EVM balance and the corresponding
// native balance: a connection error or a failed native read is a failed
// preflight, never a passed one.
//
// Three clearly labeled numbers, all BigInt in each ledger's own units:
// - minimum deployment budget: measured creation-transaction estimate
//   (not the total release cost and not a fee guarantee),
// - remaining binding budget: the reserve for the outstanding bindings,
// - whole-release recommended balance: the requirement with margin, rounded
//   up to a 50 tPOT block for accounts that prefer a round target.
//
// Units are handled in each ledger's own scale, always as BigInt:
// - native tPOT balances use 14 decimals,
// - EVM balances use 18 decimals,
// - a manual POT_REQUIRED_TPOT floor can only RAISE the computed whole-
//   release requirement, never lower it.

const fs = require('node:fs');
const path = require('node:path');
const { Wallet, ContractFactory, JsonRpcProvider } = require('ethers');
const {
  assessReleaseBudget,
  formatUnits,
  parseFeeMarginPercent,
  parseRequiredTpot,
  ceilDiv,
  NATIVE_DECIMALS,
  EVM_DECIMALS,
} = require('./lib/validation.cjs');
const { readNativeFreeBalance } = require('./lib/native-runtime.cjs');
const { loadSharedMapping } = require('./lib/shared-loader.cjs');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const WS_URL = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';
const CHAIN_ID = 420420777;
const REFERENCE_FROM = '0xf7eC65d11e35375A250e474059a917B537804142';
const ARTIFACT_FILES = [
  { name: 'PotERC20', file: 'contracts/PotERC20.sol/PotERC20.json', args: ['PotToken', 'POT', REFERENCE_FROM] },
  { name: 'PotERC721', file: 'contracts/PotERC721.sol/PotERC721.json', args: ['PotToken Collectibles', 'POTC', REFERENCE_FROM] },
  { name: 'PotRegistry', file: 'contracts/PotRegistry.sol/PotRegistry.json', args: [] },
];
const OUTSTANDING_BINDINGS = 2;

function readKey() {
  if (process.env.PORTALDOT_DEPLOYER_PRIVATE_KEY) {
    return process.env.PORTALDOT_DEPLOYER_PRIVATE_KEY;
  }
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) {
    throw new Error('no deployer key found, run npm run init:deployer');
  }
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key === 'PORTALDOT_DEPLOYER_PRIVATE_KEY') return value;
  }
  throw new Error('no deployer key found in .env, run npm run init:deployer');
}

// Read-only creation estimates against the live RPC, carried out from the
// funded reference address (an unfunded account cannot fetch an estimate on
// this chain). BigInt only: the numbers exceed 2^53.
async function measureCreationEstimates({ provider, gasPrice }) {
  const rows = [];
  for (const target of ARTIFACT_FILES) {
    const artifactPath = path.join(root, 'artifacts', target.file);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`artifact missing: ${target.file}. run npm run compile first; a whole-release budget cannot be computed without measurements`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, provider);
    const data = (await factory.getDeployTransaction(...target.args)).data;
    const gas = await provider.estimateGas({ from: REFERENCE_FROM, data, gasPrice });
    rows.push({ name: target.name, gas: BigInt(gas) });
  }
  return rows;
}

async function main() {
  const wallet = new Wallet(readKey());
  const shared = await loadSharedMapping(root);
  const account = shared.evmAddressToNativeAccount(wallet.address);

  const requiredTpotFloor = parseRequiredTpot(process.env.POT_REQUIRED_TPOT);
  const feeMarginPercent = parseFeeMarginPercent(process.env.POT_RELEASE_FEE_MARGIN_PCT);

  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
  const feeData = await provider.getFeeData();
  const gasPrice = process.env.POT_GAS_PRICE ? BigInt(process.env.POT_GAS_PRICE) : (feeData.gasPrice ? BigInt(feeData.gasPrice) : null);
  if (gasPrice === null || gasPrice === undefined) {
    throw new Error('the RPC provided no gas price; a whole-release budget cannot be computed fail-closed (set POT_GAS_PRICE explicitly to skip the live fee read)');
  }

  const estimates = await measureCreationEstimates({ provider, gasPrice: process.env.POT_GAS_PRICE ? BigInt(process.env.POT_GAS_PRICE) : gasPrice });
  const registryEstimate = estimates.find((row) => row.name === 'PotRegistry').gas;

  const budget = assessReleaseBudget({
    creationEstimatesGas: estimates.map((row) => row.gas),
    bindingEstimateGas: registryEstimate,
    outstandingBindings: OUTSTANDING_BINDINGS,
    gasPriceWei: gasPrice,
    feeMarginPercent,
    requiredTpotFloor,
  });

  // The required amount, exactly converted into each ledger's units.
  const requiredNativeUnits = budget.requiredNativeUnits;
  const requiredEvmWei = budget.requiredEvmWei;
  // Recommended whole balance: required rounded up to a 50 tPOT block.
  const recommendedTpot = ceilDiv(ceilDiv(requiredEvmWei, 10n ** BigInt(EVM_DECIMALS)), 50n) * 50n;

  const evmBalanceWei = await (async () => {
    try {
      return { balance: BigInt(await provider.getBalance(wallet.address)) };
    } catch (error) {
      return { error: error.shortMessage || error.message };
    }
  })();

  const nativeFreeUnits = await (async () => {
    try {
      const free = await readNativeFreeBalance({ wsUrl: WS_URL, ss58: account.ss58 });
      return { free };
    } catch (error) {
      return { error: error.shortMessage || error.message };
    }
  })();

  const evmBalanceBigInt = evmBalanceWei.error ? null : evmBalanceWei.balance;
  const nativeBalanceUnits = nativeFreeUnits.error ? null : nativeFreeUnits.free;
  const evmFunded = evmBalanceWei.error === null && evmBalanceBigInt >= requiredEvmWei;
  const nativeFunded = nativeFreeUnits.error === null && nativeBalanceUnits >= requiredNativeUnits;

  const report = {
    evmAddress: wallet.address,
    nativeSs58: account.ss58,
    stageRequired: 'whole release (deploy + both bindings + fee margin)',
    budget: {
      feeMarginPercent,
      floorTPOT: requiredTpotFloor.toString(),
      floorApplied: budget.floorApplied,
      minimumDeployment: {
        label: 'measured deployment estimate (not the total release cost, not a fee guarantee)',
        gas: budget.deploymentGas.toString(),
        costWei: budget.deploymentBudgetWei.toString(),
        costTPOT: formatUnits(budget.deploymentBudgetWei, EVM_DECIMALS),
      },
      remainingBindings: {
        label: `reserve for ${OUTSTANDING_BINDINGS} binding(s): registry creation estimate as the heaviest measured registry transaction`,
        perBindingGas: registryEstimate.toString(),
        costWei: budget.bindingBudgetWei.toString(),
        costTPOT: formatUnits(budget.bindingBudgetWei, EVM_DECIMALS),
      },
      margin: {
        label: 'documented fee-fluctuation margin',
        percent: feeMarginPercent,
        wei: budget.marginWei.toString(),
      },
      wholeRelease: {
        requiredEvmWei: requiredEvmWei.toString(),
        requiredTPOT: formatUnits(requiredEvmWei, EVM_DECIMALS),
        requiredNativeUnits: requiredNativeUnits.toString(),
        recommendedTPOT: recommendedTpot.toString(),
        recommendedLabel: 'whole-release recommended balance, rounded up to a 50 tPOT block (recommended >= required)',
      },
      measuredAt: {
        gasPriceWei: gasPrice.toString(),
        note: 'costs are read-only estimates (gas x live gas price) measured from the funded reference account; fee spikes and future parameter changes are not covered by the measurements',
      },
    },
    perContract: estimates.map((row) => ({
      name: row.name,
      gas: row.gas.toString(),
      costWei: (row.gas * gasPrice).toString(),
      costTPOT: formatUnits(row.gas * gasPrice, EVM_DECIMALS),
    })),
    evm: {
      balanceWei: evmBalanceWei.error ? null : evmBalanceBigInt.toString(),
      balanceTPOT: evmBalanceWei.error ? null : formatUnits(evmBalanceBigInt, EVM_DECIMALS),
      ...(evmBalanceWei.error ? { readError: evmBalanceWei.error } : {}),
      requiredEvmWei: requiredEvmWei.toString(),
      funded: Boolean(evmFunded),
      ...(evmBalanceWei.error === null && evmBalanceBigInt < requiredEvmWei
        ? { shortfallWei: (requiredEvmWei - evmBalanceBigInt).toString() }
        : {}),
    },
    native: {
      freeUnits: nativeFreeUnits.error ? null : nativeBalanceUnits.toString(),
      freeTPOT: nativeFreeUnits.error ? null : formatUnits(nativeBalanceUnits, NATIVE_DECIMALS),
      ...(nativeFreeUnits.error ? { readError: nativeFreeUnits.error } : {}),
      requiredNativeUnits: requiredNativeUnits.toString(),
      funded: Boolean(nativeFunded),
      ...(nativeFreeUnits.error === null && nativeBalanceUnits < requiredNativeUnits
        ? { shortfallUnits: (requiredNativeUnits - nativeBalanceUnits).toString() }
        : {}),
    },
    funded: Boolean(evmFunded && nativeFunded),
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (report.funded) {
    process.stdout.write(`\nfunded: ready to deploy with npm run release:testnet (the release performs its own stage-aware preflight before any transaction)\n`);
    return;
  }

  const parts = [];
  if (evmBalanceWei.error) {
    parts.push(`EVM balance read failed: ${evmBalanceWei.error}`);
  } else if (!evmFunded) {
    parts.push(
      `EVM ledger short by ${formatUnits(requiredEvmWei - evmBalanceBigInt, EVM_DECIMALS)} tPOT (${requiredEvmWei - evmBalanceBigInt} wei) of the whole-release requirement ${formatUnits(requiredEvmWei, EVM_DECIMALS)} tPOT`
    );
  }
  if (nativeFreeUnits.error) {
    parts.push(`native balance read failed: ${nativeFreeUnits.error}`);
  } else if (!nativeFunded) {
    parts.push(
      `native ledger short by ${formatUnits(requiredNativeUnits - nativeBalanceUnits, NATIVE_DECIMALS)} tPOT (${requiredNativeUnits - nativeBalanceUnits} native units) of the whole-release requirement ${formatUnits(requiredNativeUnits, NATIVE_DECIMALS)} tPOT`
    );
  }
  process.stdout.write(`\nnot funded yet: ${parts.join(' | ')}\n`);
  process.stdout.write(`current balance is ${evmBalanceWei.error ? 'unknown' : formatUnits(evmBalanceBigInt, EVM_DECIMALS)} tPOT (EVM, 18 decimals); the whole-release requirement is ${formatUnits(requiredEvmWei, EVM_DECIMALS)} tPOT (recommended ${recommendedTpot.toString()} tPOT, rounded up to a 50 tPOT block); native ledger holds ${nativeFreeUnits.error ? 'unknown' : formatUnits(nativeBalanceUnits, NATIVE_DECIMALS)} tPOT\n`);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readKey };
