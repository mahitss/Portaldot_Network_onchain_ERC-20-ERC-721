const fs = require('node:fs');
const path = require('node:path');
const { Wallet, JsonRpcProvider } = require('ethers');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const WS_URL = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';
const REQUIRED_TPOT = BigInt(process.env.POT_REQUIRED_TPOT || 1050);

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
    if (entry.startsWith('PORTALDOT_DEPLOYER_PRIVATE_KEY=')) {
      return entry.slice('PORTALDOT_DEPLOYER_PRIVATE_KEY='.length).trim();
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

  const report = {
    evmAddress: wallet.address,
    nativeSs58: account.ss58,
    requiredTPOT: Number(REQUIRED_TPOT),
    evm: {},
    native: {},
  };

  const provider = new JsonRpcProvider(RPC_URL, 420420777);
  const balance = await provider.getBalance(wallet.address);
  report.evm.balanceWei = balance.toString();
  report.evm.balanceTPOT = Number(balance) / 1e18;

  try {
    report.native = await readNativeBalance(account.ss58);
    report.native.balanceTPOT = Number(report.native.free) / 1e18;
  } catch (error) {
    report.native.error = error.message;
  }

  const funded = report.evm.balanceTPOT >= Number(REQUIRED_TPOT);
  report.funded = funded;

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    funded
      ? `\nready to deploy with npm run release:testnet\n`
      : `\nnot funded yet: ${report.evm.balanceTPOT.toFixed(2)} of ${Number(REQUIRED_TPOT)} tPOT, ask for the top up of ${account.ss58}\n`
  );
  if (!funded) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
