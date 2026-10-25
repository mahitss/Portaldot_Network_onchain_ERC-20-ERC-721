const fs = require('node:fs');
const path = require('node:path');
const { JsonRpcProvider } = require('ethers');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const WS_URL = process.env.PORTALDOT_WS_URL || 'wss://test-node-v3.portaldot.dev';

async function readNative(ss58, assetId, nftCollectionId) {
  const result = { ss58, connected: false, account: null, assets: null, nfts: null, errors: [] };
  let api;
  try {
    const { ApiPromise, WsProvider } = await import('@polkadot/api');
    const provider = new WsProvider(WS_URL, 2000);
    api = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws timeout')), 15000);
      ApiPromise.create({ provider })
        .then((instance) => {
          clearTimeout(timer);
          resolve(instance);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
    result.connected = true;

    if (api.query.system?.account) {
      const info = await api.query.system.account(ss58);
      result.account = {
        nonce: info.nonce.toString(),
        free: info.data.free.toString(),
        reserved: info.data.reserved.toString(),
      };
    }

    if (assetId && api.query.assets?.account) {
      const asset = await api.query.assets.asset(assetId);
      const account = await api.query.assets.account(assetId, ss58);
      result.assets = {
        id: Number(assetId),
        details: asset.toString(),
        balance: account.toString(),
      };
    }

    if (nftCollectionId && api.query.nfts?.collection) {
      const collection = await api.query.nfts.collection(nftCollectionId);
      result.nfts = {
        id: Number(nftCollectionId),
        details: collection.toString(),
      };
    }
  } catch (error) {
    result.errors.push(error.message);
  } finally {
    if (api) {
      await api.disconnect();
    }
  }
  return result;
}

async function main() {
  const deploymentsFile = path.join(
    root,
    'deployments',
    `${process.env.PORTALDOT_NETWORK || 'portaldotTestnet'}.json`
  );
  const deployments = fs.existsSync(deploymentsFile)
    ? JSON.parse(fs.readFileSync(deploymentsFile, 'utf8'))
    : null;

  const evmAddress = process.argv[2] || deployments?.deployer || null;
  const ss58 = process.argv[3] || null;
  const assetId = process.argv[4] || process.env.POT_NATIVE_ASSET_ID || null;
  const nftCollectionId = process.argv[5] || process.env.POT_NATIVE_NFT_ID || null;

  const { nativeAccountToEvmAddress, evmAddressToNativeAccount } = await import(
    `file://${path.join(root, 'shared', 'portaldot.mjs').replace(/\\/g, '/')}`
  );

  const provider = new JsonRpcProvider(RPC_URL, deployments?.chainId);
  const report = { rpc: RPC_URL, ws: WS_URL, evm: {}, native: {}, mapping: {} };

  if (evmAddress) {
    report.evm.address = evmAddress;
    report.evm.balance = (await provider.getBalance(evmAddress)).toString();
    report.evm.nonce = await provider.getTransactionCount(evmAddress);
    report.evm.blockNumber = await provider.getBlockNumber();
    const derived = evmAddressToNativeAccount(evmAddress);
    report.mapping.derivedSs58 = derived.ss58;
    report.mapping.accountHex = derived.hex;
    report.mapping.matchesInput = ss58 ? derived.ss58 === ss58 : null;
    if (ss58) {
      try {
        report.mapping.roundTrip = nativeAccountToEvmAddress(ss58).toLowerCase() === evmAddress.toLowerCase();
      } catch (error) {
        report.mapping.roundTrip = `invalid SS58: ${error.message}`;
      }
    }
  }

  if (ss58) {
    report.native = await readNative(ss58, assetId, nftCollectionId);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
