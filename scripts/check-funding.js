// Funding preflight for the Portaldot V3 deployer account.
//
// The funding gate requires SUCCESSFUL reads of BOTH the mapped EVM balance
// and the corresponding native balance: a connection error or a failed
// native read is a failed preflight, never a passed one.
//
// Units are handled in each ledger's own scale, always as BigInt:
// - native tPOT balances use 14 decimals,
// - EVM balances use 18 decimals,
// - the required funding default is 1,350 tPOT and the threshold is
//   compared against the balance in the matching ledger's units.

const fs = require('node:fs');
const path = require('node:path');
const { Wallet, JsonRpcProvider } = require('ethers');
const { assessFunding, formatUnits, parseRequiredTpot, NATIVE_DECIMALS, EVM_DECIMALS } = require('./lib/validation.cjs');
const { readNativeFreeBalance } = require('./lib/native-runtime.cjs');
const { loadSharedMapping } = require('./lib/shared-loader.cjs');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const WS_URL = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';

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

async function main() {
  const wallet = new Wallet(readKey());
  const shared = await loadSharedMapping(root);
  const account = shared.evmAddressToNativeAccount(wallet.address);

  const requiredTpot = parseRequiredTpot(process.env.POT_REQUIRED_TPOT);

  const evmBalanceWei = await (async () => {
    try {
      const provider = new JsonRpcProvider(RPC_URL, 420420777);
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

  const assessment = assessFunding({
    requiredTpot,
    evmBalanceWei: evmBalanceWei.balance ?? null,
    nativeFreeUnits: nativeFreeUnits.free ?? null,
    evmReadError: evmBalanceWei.error ?? null,
    nativeReadError: nativeFreeUnits.error ?? null,
  });

  const report = {
    evmAddress: wallet.address,
    nativeSs58: account.ss58,
    requiredTPOT: requiredTpot.toString(),
    requiredNativeUnits: assessment.requiredNativeUnits.toString(),
    requiredEvmWei: assessment.requiredEvmWei.toString(),
    evm: {
      balanceWei: evmBalanceWei.error ? null : evmBalanceWei.balance.toString(),
      balanceTPOT: evmBalanceWei.error ? null : formatUnits(evmBalanceWei.balance, EVM_DECIMALS),
      ...(evmBalanceWei.error ? { readError: evmBalanceWei.error } : {}),
      funded: assessment.evmFunded,
    },
    native: {
      freeUnits: nativeFreeUnits.error ? null : nativeFreeUnits.free.toString(),
      freeTPOT: nativeFreeUnits.error ? null : formatUnits(nativeFreeUnits.free, NATIVE_DECIMALS),
      ...(nativeFreeUnits.error ? { readError: nativeFreeUnits.error } : {}),
      funded: assessment.nativeFunded,
    },
    funded: assessment.funded,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (assessment.funded) {
    process.stdout.write(`\nfunded: ready to deploy with npm run release:testnet (the release performs its own preflight before any transaction)\n`);
    return;
  }

  const parts = [];
  if (evmBalanceWei.error) {
    parts.push(`EVM balance read failed: ${evmBalanceWei.error}`);
  } else if (assessment.evmShortfallWei > 0n) {
    parts.push(
      `EVM ledger short by ${formatUnits(assessment.evmShortfallWei, EVM_DECIMALS)} tPOT (${assessment.evmShortfallWei} wei)`
    );
  }
  if (nativeFreeUnits.error) {
    parts.push(`native balance read failed: ${nativeFreeUnits.error}`);
  } else if (assessment.nativeShortfallUnits > 0n) {
    parts.push(
      `native ledger short by ${formatUnits(assessment.nativeShortfallUnits, NATIVE_DECIMALS)} tPOT (${assessment.nativeShortfallUnits} native units)`
    );
  }
  process.stdout.write(`\nnot funded yet: ${parts.join(' | ')}\n`);
  process.stdout.write(`current balance is ${formatUnits(evmBalanceWei.error ? 0n : evmBalanceWei.balance, EVM_DECIMALS)} tPOT of the required ${requiredTpot.toString()} tPOT (EVM, 18 decimals); the native ledger holds ${nativeFreeUnits.error ? 'unknown' : formatUnits(nativeFreeUnits.free, NATIVE_DECIMALS)} tPOT\n`);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readKey };
