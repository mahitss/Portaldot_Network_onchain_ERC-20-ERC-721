const fs = require('node:fs');
const path = require('node:path');
const { JsonRpcProvider } = require('ethers');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const CHAIN_ID = 420420777;

function deploymentsPath() {
  return path.join(root, 'deployments', `${process.env.PORTALDOT_NETWORK || 'portaldotTestnet'}.json`);
}

async function main() {
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  const nodeVersion = process.versions.node;
  record('node runtime', Number(nodeVersion.split('.')[0]) >= 20, `node ${nodeVersion}`);

  const artifactsDir = path.join(root, 'artifacts', 'contracts');
  record(
    'contracts compiled',
    fs.existsSync(path.join(artifactsDir, 'PotRegistry.sol', 'PotRegistry.json')),
    artifactsDir
  );

  const abiPath = path.join(root, 'sdk', 'abi.generated.mjs');
  record('sdk abi generated', fs.existsSync(abiPath), path.relative(root, abiPath));

  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID);
  try {
    const network = await provider.getNetwork();
    const blockNumber = await provider.getBlockNumber();
    record('rpc reachable', true, `${RPC_URL} block ${blockNumber}`);
    record('chain id', Number(network.chainId) === CHAIN_ID, String(network.chainId));

    const file = deploymentsPath();
    if (fs.existsSync(file)) {
      const deployments = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [name, entry] of Object.entries(deployments.contracts || {})) {
        const code = await provider.getCode(entry.address);
        record(`${name} bytecode`, code !== '0x', `${entry.address} (${code.length / 2 - 1} bytes)`);
      }
    } else {
      record('deployment file', false, `missing ${path.relative(root, file)}`);
    }
  } catch (error) {
    record('rpc reachable', false, error.message);
  }

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(24)} ${check.detail}\n`);
  }
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}
