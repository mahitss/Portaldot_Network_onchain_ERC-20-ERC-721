const fs = require('node:fs');
const path = require('node:path');
const { Contract, JsonRpcProvider } = require('ethers');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const EXPECTED_CHAIN_ID = 420420777;

export function validateChainId(chainId, expectedChainId) {
  if (Number(chainId) !== expectedChainId) {
    throw new Error(
      `wrong chain ID: ${chainId}. Expected ${expectedChainId} (Portaldot V3 testnet).`
    );
  }
}

export function validateReceipt(txHash, receipt) {
  if (!receipt) {
    throw new Error(`transaction receipt not found for ${txHash}`);
  }
  if (receipt.status !== 1) {
    throw new Error(`transaction ${txHash} failed with status ${receipt.status}`);
  }
  if (receipt.transactionHash !== txHash) {
    throw new Error(
      `receipt transaction hash mismatch: expected ${txHash}, got ${receipt.transactionHash}`
    );
  }
  return receipt;
}

function loadDeployments() {
  const explicit = process.env.POT_DEPLOYMENTS;
  const file = explicit
    ? path.resolve(root, explicit)
    : path.join(root, 'deployments', `${process.env.PORTALDOT_NETWORK || 'portaldotTestnet'}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`deployment file not found: ${file}`);
  }
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

async function main() {
  const { file, data } = loadDeployments();
  const provider = new JsonRpcProvider(RPC_URL, data.chainId);
  const report = { network: data.network, chainId: data.chainId, contracts: {}, bindings: [], ok: true };

  // 1. Require expected chain ID
  const chainId = Number((await provider.getNetwork()).chainId);
  validateChainId(chainId, EXPECTED_CHAIN_ID);
  report.chainId = chainId;

  // 2. Check each expected contract has deployed bytecode and a confirmed receipt
  for (const [name, entry] of Object.entries(data.contracts || {})) {
    const code = await provider.getCode(entry.address);
    const receipt = await provider.getTransactionReceipt(entry.txHash);

    validateReceipt(entry.txHash, receipt);

    const hasCode = code !== '0x';
    const txConfirmed = Boolean(receipt);

    report.contracts[name] = {
      address: entry.address,
      hasCode,
      codeBytes: Math.max(0, code.length / 2 - 1),
      txConfirmed,
      txSuccessful: receipt ? receipt.status === 1 : false,
      txMatches: receipt ? receipt.transactionHash === entry.txHash : false,
      blockNumber: receipt ? receipt.blockNumber : null,
    };

    if (
      !report.contracts[name].hasCode ||
      !report.contracts[name].txConfirmed ||
      !report.contracts[name].txSuccessful ||
      !report.contracts[name].txMatches
    ) {
      report.ok = false;
    }
  }

  // 3. Validate registry bindings against expected configuration
  const registryAddress = data.contracts?.PotRegistry?.address;
  if (registryAddress) {
    const artifactPath = path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json');
    if (fs.existsSync(artifactPath)) {
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      const registry = new Contract(registryAddress, artifact.abi, provider);
      report.registry = {
        owner: await registry.owner(),
        bindingCount: Number(await registry.bindingCount()),
      };

      for (const token of Object.values(data.tokens || {})) {
        const bound = await registry.isBound(token.address);
        report.bindings.push({ token: token.address, bound });
        if (bound) {
          const binding = await registry.bindingOfToken(token.address);
          report.bindings[report.bindings.length - 1].binding = {
            tokenKind: Number(binding.tokenKind),
            nativeKind: Number(binding.nativeKind),
            nativeId: Number(binding.nativeId),
            nativeDecimals: Number(binding.nativeDecimals),
            evmDecimals: Number(binding.evmDecimals),
            conversionFactor: String(binding.conversionFactor),
            nativeAccountHash: binding.nativeAccountHash,
            active: binding.active,
          };
        }
      }
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nsource ${path.relative(root, file)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
