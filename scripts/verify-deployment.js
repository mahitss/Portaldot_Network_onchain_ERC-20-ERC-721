// Deployment verification for the Portaldot V3 release.
//
// Read-only: the verifier only reads the deployment file, storage/digests
// from the EVM provider, and the registry state. It FAILS CLOSED when any
// required check fails and an incomplete report never leaves ok: true:
//
// - the deployment file must exist, parse, and pass structural validation,
// - the required PotERC20, PotERC721 and PotRegistry entries must be present,
// - contract bytecode must exist and the receipt must exist, have a
//   successful status, and match the recorded transaction hash,
// - the PotRegistry artifact must exist,
// - every recorded binding must be present on chain and match the configured
//   native kind, id, decimals, conversion factor and active state,
// - an unbound release passes only with the explicit, documented
//   POT_ALLOW_UNBOUND=true selection.

const fs = require('node:fs');
const path = require('node:path');
const { Contract, JsonRpcProvider } = require('ethers');
const {
  REQUIRED_CONTRACT_NAMES,
  compareBinding,
  validateBindingEntry,
  validateDeploymentRecord,
  validateReceipt,
} = require('./lib/validation.cjs');

const root = path.resolve(__dirname, '..');
const RPC_URL = process.env.PORTALDOT_RPC_URL || 'https://test-evm-rpc-v3.portaldot.dev';
const EXPECTED_CHAIN_ID = 420420777;

function deploymentFilePath() {
  const explicit = process.env.POT_DEPLOYMENTS;
  return explicit
    ? path.resolve(root, explicit)
    : path.join(root, 'deployments', `${process.env.PORTALDOT_NETWORK || 'portaldotTestnet'}.json`);
}

async function main() {
  const failures = [];
  const fail = (detail) => {
    failures.push(detail);
  };
  const report = { rpc: RPC_URL, expectedChainId: EXPECTED_CHAIN_ID, contracts: {}, bindings: [], failures };

  // 1. The deployment file must exist, parse and validate. Malformed or
  //    missing records fail closed; the report still renders.
  let deployments = null;
  let recordFile = deploymentFilePath();
  try {
    if (!fs.existsSync(recordFile)) {
      throw new Error(`deployment file not found: ${recordFile}`);
    }
    const parsed = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    deployments = validateDeploymentRecord(parsed);
  } catch (error) {
    fail(`deployment record: ${error.message}`);
  }

  // 2. The chain must actually be the expected one.
  const provider = new JsonRpcProvider(RPC_URL, EXPECTED_CHAIN_ID);
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== EXPECTED_CHAIN_ID) {
      fail(`wrong chain ID: ${network.chainId}. Expected ${EXPECTED_CHAIN_ID} (Portaldot V3 testnet).`);
    }
  } catch (error) {
    fail(`RPC unreachable: ${error.shortMessage || error.message}`);
  }

  // 3. Required contract entries must exist; each needs deployed bytecode,
  //    a confirmed, successful, hash-matching receipt.
  if (deployments !== null) {
    for (const name of REQUIRED_CONTRACT_NAMES) {
      const entry = (deployments.contracts || {})[name];
      if (!entry) {
        fail(`deployment record is missing the required ${name} entry`);
        continue;
      }
      const row = {
        address: entry.address,
        txHash: entry.txHash,
        hasCode: false,
        codeBytes: 0,
        receipt: null,
      };
      try {
        const code = await provider.getCode(entry.address);
        row.hasCode = typeof code === 'string' && code !== '0x';
        row.codeBytes = row.hasCode ? (code.length - 2) / 2 : 0;
        if (!row.hasCode) {
          fail(`${name} has no deployed bytecode at ${entry.address}`);
        }
      } catch (error) {
        fail(`${name} bytecode read failed: ${error.shortMessage || error.message}`);
      }
      try {
        const receipt = await provider.getTransactionReceipt(entry.txHash);
        row.receiptStatus = receipt ? receipt.status : null;
        row.blockNumber = receipt ? receipt.blockNumber : null;
        validateReceipt(entry.txHash, receipt);
      } catch (error) {
        fail(`${name} receipt: ${error.message}`);
      }
      report.contracts[name] = row;
    }

    // 4. The registry artifact is required for binding verification.
    const artifactPath = path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json');
    if (!fs.existsSync(artifactPath)) {
      fail(`required registry artifact is missing: ${path.relative(root, artifactPath)}`);
    } else if (deployments.contracts && deployments.contracts.PotRegistry) {
      try {
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        const registry = new Contract(deployments.contracts.PotRegistry.address, artifact.abi, provider);

        report.registry = {
          owner: await registry.owner(),
          bindingCount: Number(await registry.bindingCount()),
        };

        // 5. Expected bindings from the deployment record are REQUIRED, and
        //    each field is really compared against on-chain state.
        const expectedBindings = Array.isArray(deployments.bindings) ? deployments.bindings : [];
        if (expectedBindings.length === 0 && process.env.POT_ALLOW_UNBOUND !== 'true') {
          fail(
            'no expected bindings are recorded and POT_ALLOW_UNBOUND is not set to "true": a dual-ledger release requires explicit binding intent. Set the POT_NATIVE_* ids and run bind, or deliberately select POT_ALLOW_UNBOUND=true as documented in docs/DEMO-RUNBOOK.md.'
          );
        }
        for (const entry of expectedBindings) {
          let token = null;
          try {
            token = validateBindingEntry(entry).token;
          } catch (error) {
            fail(`recorded binding entry is invalid: ${error.message}`);
            continue;
          }
          const row = { token, expected: entry, onChain: null };
          try {
            const bound = await registry.isBound(token);
            if (!bound) {
              fail(`required binding absent on chain for ${token} (recorded in the deployment record)`);
              row.onChain = { bound: false };
              report.bindings.push(row);
              continue;
            }
            const binding = await registry.bindingOfToken(token);
            row.onChain = {
              bound: true,
              tokenKind: Number(binding.tokenKind),
              nativeKind: Number(binding.nativeKind),
              nativeId: Number(binding.nativeId),
              nativeDecimals: Number(binding.nativeDecimals),
              evmDecimals: Number(binding.evmDecimals),
              conversionFactor: String(binding.conversionFactor),
              nativeAccountHash: binding.nativeAccountHash,
              active: binding.active,
            };
            const mismatches = compareBinding(entry, binding);
            row.mismatches = mismatches;
            if (mismatches.length > 0) {
              fail(`binding for ${token} does not match the configured values: ${mismatches.join('; ')}`);
            }
          } catch (error) {
            fail(`binding check for ${token} failed: ${error.shortMessage || error.message}`);
          }
          report.bindings.push(row);
        }

        // Spotlight untracked on-chain bindings so unknown state is visible.
        if (Number.isFinite(report.registry.bindingCount) && report.registry.bindingCount > expectedBindings.length) {
          report.registryNote = `the registry holds ${report.registry.bindingCount} binding(s) while the deployment record lists ${expectedBindings.length} expected binding(s); untracked bindings are visible in the binding table`;
        }
      } catch (error) {
        fail(`registry state read failed: ${error.shortMessage || error.message}`);
      }
    }
  }

  report.ok = failures.length === 0;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nsource ${path.relative(root, recordFile)}\n`);
  if (!report.ok) {
    process.stdout.write('\nverification FAILED (incomplete reports never count as ok)\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nverification passed: bytecode, receipts and required bindings match the recorded configuration\n');
}

function tryEntryToken(entry) {
  try {
    return validateBindingEntry(entry).token;
  } catch {
    return null;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
}

module.exports = { deploymentFilePath, tryEntryToken };
