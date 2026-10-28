const fs = require('node:fs');
const path = require('node:path');
const { Wallet, JsonRpcProvider } = require('ethers');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const WS_URL = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';

// Default required funding: 1,350 tPOT
export const DEFAULT_REQUIRED_TPOT = 1350n;
export const NATIVE_DECIMALS = 14;
export const EVM_DECIMALS = 18;

export function parseRequiredTpot(value) {
  if (value === undefined || value === '') {
    return DEFAULT_REQUIRED_TPOT;
  }
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`invalid POT_REQUIRED_TPOT: ${value}. Must be a non-negative integer amount of tPOT.`);
  }
  return BigInt(trimmed);
}

export function tpotToUnits(amountTpot, decimals) {
  return amountTpot * 10n ** BigInt(decimals);
}

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
    if (!entry || entry.startsWith('#')) {
      continue;
    }
    const separator = entry.indexOf('=');
    if (separator < 0) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (key === 'PORTALDOT_DEPLOYER_PRIVATE_KEY') {
      return value;
    }
  }
  throw new Error('no deployer key found in .env, run npm run init:deployer');
}

async function readNativeBalance(ss58) {
  const { ApiPromise, WsProvider } = await import('@polkadot/api');
  const provider = new WsProvider(WS_URL, 2000);
  const api = await ApiPromise.create({ provider });
  try {
    const account = await api.query.system.account(ss58);
    return { free: account.data.free.toString(), nonce: account.nonce.toString() };
  } finally {
    await api.disconnect();
  }
}

async function main() {
  const wallet = new Wallet(readKey());
  const { evmAddressToNativeAccount } = await import(
    `file://${path.join(root, 'shared', 'portaldot.mjs').replace(/\\/g, '/')}`
  );
  const account = evmAddressToNativeAccount(wallet.address);

  const requiredTpott = parseRequiredTpot(process.env.POT_REQUIRED_TPOT);
  const requiredNativeUnits = tpotToUnits(requiredTpott, NATIVE_DECIMALS);
  const requiredEvmUnits = tpotToUnits(requiredTpott, EVM_DECIMALS);

  const report = {
    evmAddress: wallet.address,
    nativeSs58: account.ss58,
    requiredTPOT: requiredTpott.toString(),
    requiredNativeUnits: requiredNativeUnits.toString(),
    requiredEvmUnits: requiredEvmUnits.toString(),
    evm: {},
    native: {},
  };

  const provider = new JsonRpcProvider(RPC_URL, 420420777);

  // Read EVM balance (18 decimals)
  const evmBalance = await provider.getBalance(wallet.address);
  report.evm.balanceWei = evmBalance.toString();
  report.evm.balanceTPOT = (evmBalance / 10n ** EVM_DECIMALS).toString();

  // Read native balance (14 decimals) - must succeed
  let nativeReadError = null;
  let nativeBalance = null;
  try {
    const accountInfo = await readNativeBalance(account.ss58);
    nativeBalance = accountInfo.free;
    report.native = {
      free: nativeBalance,
      nonce: accountInfo.nonce,
    };
  } catch (error) {
    nativeReadError = error.message;
    report.native = { error: error.message };
  }

  // Determine funding status: both ledgers must be readable and both must meet threshold
  const evmFunded = evmBalance >= requiredEvmUnits;
  const nativeFunded = nativeReadError === null && BigInt(nativeBalance) >= requiredNativeUnits;
  const funded = evmFunded && nativeFunded;

  report.funded = funded;
  report.evm.funded = evmFunded;
  report.native.funded = nativeFunded;

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (funded) {
    process.stdout.write(`\nready to deploy with npm run release:testnet\n`);
  } else {
    const missingNative = nativeReadError
      ? `native read failed: ${nativeReadError}`
      : `short by ${(requiredNativeUnits - BigInt(nativeBalance || 0n)).toString()} native units`;
    const missingEvm = evmFunded ? '' : ` EVM short by ${(requiredEvmUnits - evmBalance).toString()} wei`;
    process.stdout.write(
      `\nnot funded yet: ${(BigInt(evmBalance) / requiredEvmUnits).toString()} of ${requiredTpott.toString()} tPOT. ${missingNative}${missingEvm}\n`
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}
