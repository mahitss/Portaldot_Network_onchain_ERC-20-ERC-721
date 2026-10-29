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
//
// The report additionally carries a release-phase classification
// (classifyReleasePhase) that distinguishes a complete dual-ledger release,
// a partial deployment, missing binding evidence, an unrecorded completed
// binding (record write or verification step failed), a configuration
// mismatch, an ambiguous/pending transaction outcome, and a deliberate
// unbound release. Partial progress is never labeled as a complete release.

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

// Pure release-phase classifier. Inputs are granular counts so offline tests
// can drive it without RPCs; the ordering below is the documented verdict
// precedence for the mission's lifecycle states.
//
//   unusable            no record / record malformed or structurally invalid
//   partialDeployment   not all required contracts are recorded (yet)
//   unconfirmed         a pending record entry, or receipt/bytecode checks
//                       could not confirm a recorded transaction (ambiguous
//                       outcome included)
//   configurationMismatch  a recorded binding mismatches the chain state
//   bindingNotRecorded  a binding exists on chain that the record does not
//                       document (its record write or subsequent verification
//                       step failed; rerunning bind reconciles it without a
//                       new transaction)
//   bindingsMissing     deployment verified but no binding intent recorded
//                       (or recorded bindings absent on chain)
//   deploymentOnly      a deliberate POT_ALLOW_UNBOUND=true release
//   complete            every contract verified and every binding verified
//                       against the recorded intent
//   degradedVerification otherwise complete, but unrelated preflight checks
//                       failed (see failures) - never ok: true
function classifyReleasePhase(state) {
  if (!state || typeof state !== 'object') {
    return { phase: 'unusable', phaseSummary: 'no verification state was provided' };
  }
  const {
    recordPresent = false,
    recordValid = false,
    contractsComplete = false,
    contractsPending = 0,
    contractsVerified = false,
    bindingsRecorded = 0,
    bindingsVerified = 0,
    bindingsMissingOnChain = 0,
    bindingsMismatched = 0,
    bindingsUntrackedOnChain = 0,
    unboundAcknowledged = false,
    otherFailures = 0,
  } = state;

  if (!recordPresent) {
    return { phase: 'unusable', phaseSummary: 'no deployment record was found' };
  }
  if (!recordValid) {
    return { phase: 'unusable', phaseSummary: 'the deployment record is malformed or structurally invalid' };
  }
  if (!contractsComplete) {
    return { phase: 'partialDeployment', phaseSummary: 'not every required contract is recorded yet; the missing phases can be resumed by rerunning the release' };
  }
  if (contractsPending > 0) {
    return { phase: 'unconfirmed', phaseSummary: `a deployment transaction is pending or its outcome could not be confirmed from the chain (${contractsPending} pending record entry)` };
  }
  if (!contractsVerified) {
    return { phase: 'unconfirmed', phaseSummary: 'contract bytecode or receipt checks failed on chain; the transaction outcome is ambiguous until reconciled' };
  }
  if (bindingsMismatched > 0) {
    return { phase: 'configurationMismatch', phaseSummary: 'a recorded binding exists on chain but does not match its configured values' };
  }
  if (bindingsUntrackedOnChain > 0) {
    return { phase: 'bindingNotRecorded', phaseSummary: 'a binding exists on chain that the record does not document (its record write or verification step failed); rerunning bind upserts it without a new transaction' };
  }
  if (bindingsRecorded === 0) {
    if (unboundAcknowledged) {
      return { phase: 'deploymentOnly', phaseSummary: 'a deliberate unbound release (POT_ALLOW_UNBOUND=true): deployment verified, no dual-ledger binding claims' };
    }
    return { phase: 'bindingsMissing', phaseSummary: 'the deployment is verified but no binding intent is recorded' };
  }
  if (bindingsMissingOnChain > 0 || bindingsVerified < bindingsRecorded) {
    return { phase: 'bindingsMissing', phaseSummary: 'recorded bindings are absent from the chain' };
  }
  if (otherFailures > 0) {
    return { phase: 'degradedVerification', phaseSummary: 'the lifecycle state is complete, but unrelated verification checks failed (see failures); treat as not ok' };
  }
  return { phase: 'complete', phaseSummary: 'a complete, verified dual-ledger release: all contracts and all bindings match the recorded intent' };
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
  let recordPresent = false;
  let recordValid = false;
  try {
    if (!fs.existsSync(recordFile)) {
      throw new Error(`deployment file not found: ${recordFile}`);
    }
    recordPresent = true;
    const parsed = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    deployments = validateDeploymentRecord(parsed);
    recordValid = true;
  } catch (error) {
    fail(`deployment record: ${error.message}`);
  }

  // 2. The chain must actually be the expected one.
  let otherFailures = 0;
  const provider = new JsonRpcProvider(RPC_URL, EXPECTED_CHAIN_ID);
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== EXPECTED_CHAIN_ID) {
      fail(`wrong chain ID: ${network.chainId}. Expected ${EXPECTED_CHAIN_ID} (Portaldot V3 testnet).`);
      otherFailures += 1;
    }
  } catch (error) {
    fail(`RPC unreachable: ${error.shortMessage || error.message}`);
    otherFailures += 1;
  }

  // 3. Required contract entries must exist; each needs deployed bytecode,
  //    a confirmed, successful, hash-matching receipt. Pending record
  //    entries are reported exactly as unconfirmed (never as success).
  let contractsComplete = true;
  let contractsPending = 0;
  let contractsVerified = true;
  let bindingsRecorded = 0;
  let bindingsVerified = 0;
  let bindingsMissingOnChain = 0;
  let bindingsMismatched = 0;
  let bindingsUntrackedOnChain = 0;
  if (deployments !== null) {
    for (const name of REQUIRED_CONTRACT_NAMES) {
      const entry = (deployments.contracts || {})[name];
      if (!entry) {
        fail(`deployment record is missing the required ${name} entry`);
        contractsComplete = false;
        continue;
      }
      if (entry.status === 'pending' || typeof entry.address !== 'string') {
        fail(
          `${name} has a pending or unconfirmed deployment entry (tx ${entry.txHash || 'unknown'}); the outcome is ambiguous until it is reconciled from the chain receipt, so the release is not complete`
        );
        contractsPending += 1;
        report.contracts[name] = { address: entry.address ?? null, txHash: entry.txHash ?? null, pending: true };
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
          contractsVerified = false;
        }
      } catch (error) {
        fail(`${name} bytecode read failed: ${error.shortMessage || error.message}`);
        contractsVerified = false;
      }
      try {
        const receipt = await provider.getTransactionReceipt(entry.txHash);
        row.receiptStatus = receipt ? receipt.status : null;
        row.blockNumber = receipt ? receipt.blockNumber : null;
        validateReceipt(entry.txHash, receipt);
      } catch (error) {
        fail(`${name} receipt: ${error.message}`);
        contractsVerified = false;
      }
      report.contracts[name] = row;
    }

    // 4. The registry artifact is required for binding verification.
    const artifactPath = path.join(root, 'artifacts', 'contracts', 'PotRegistry.sol', 'PotRegistry.json');
    if (!fs.existsSync(artifactPath)) {
      fail(`required registry artifact is missing: ${path.relative(root, artifactPath)}`);
      otherFailures += 1;
    } else if (deployments.contracts && deployments.contracts.PotRegistry && deployments.contracts.PotRegistry.status !== 'pending') {
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
        for (const entry of expectedBindings) {
          let token = null;
          try {
            token = validateBindingEntry(entry).token;
          } catch (error) {
            fail(`recorded binding entry is invalid: ${error.message}`);
            otherFailures += 1;
            continue;
          }
          bindingsRecorded += 1;
          const row = { token, expected: entry, onChain: null };
          try {
            const bound = await registry.isBound(token);
            if (!bound) {
              fail(`required binding absent on chain for ${token} (recorded in the deployment record)`);
              bindingsMissingOnChain += 1;
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
              bindingsMismatched += 1;
            } else {
              bindingsVerified += 1;
            }
          } catch (error) {
            fail(`binding check for ${token} failed: ${error.shortMessage || error.message}`);
            otherFailures += 1;
          }
          report.bindings.push(row);
        }

        // Spotlight untracked on-chain bindings: a completed binding whose
        // record write (or subsequent verification) failed is a missing
        // evidence state, recoverable by rerunning bind - never a success.
        if (Number.isFinite(report.registry.bindingCount) && report.registry.bindingCount > bindingsRecorded) {
          bindingsUntrackedOnChain = report.registry.bindingCount - bindingsRecorded;
          report.registryNote = `the registry holds ${report.registry.bindingCount} binding(s) while the deployment record lists ${bindingsRecorded} expected binding(s); untracked bindings are visible in the binding table`;
          fail(`the registry holds ${report.registry.bindingCount} binding(s) but only ${bindingsRecorded} are recorded with matching configuration; a completed binding is missing from the record (rerun npm run bind:testnet to reconcile it without a new transaction)`);
        }

        const unboundAcknowledged = process.env.POT_ALLOW_UNBOUND === 'true';
        if (bindingsRecorded === 0 && !unboundAcknowledged) {
          fail(
            'no expected bindings are recorded and POT_ALLOW_UNBOUND is not set to "true": a dual-ledger release requires explicit binding intent. Set the POT_NATIVE_* ids and run bind, or deliberately select POT_ALLOW_UNBOUND=true as documented in docs/DEMO-RUNBOOK.md.'
          );
        }
      } catch (error) {
        fail(`registry state read failed: ${error.shortMessage || error.message}`);
        otherFailures += 1;
      }
    }
  }

  // 6. Release-phase classification; partial progress is never labeled as
  //    a complete release and ok stays false accordingly.
  const phase = classifyReleasePhase({
    recordPresent,
    recordValid,
    contractsComplete,
    contractsPending,
    contractsVerified,
    bindingsRecorded,
    bindingsVerified,
    bindingsMissingOnChain,
    bindingsMismatched,
    bindingsUntrackedOnChain,
    unboundAcknowledged: process.env.POT_ALLOW_UNBOUND === 'true',
    otherFailures,
  });
  report.phase = phase.phase;
  report.phaseSummary = phase.phaseSummary;

  report.ok = failures.length === 0;
  if (report.ok && !report.phase) {
    // Defensive: an ok report without a computed phase is a bug - fail
    // closed rather than emit an unclassified success.
    report.ok = false;
    report.phase = 'unusable';
    report.phaseSummary = 'internal error: ok verification could not be classified';
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nsource ${path.relative(root, recordFile)}\n`);
  if (report.phase) {
    process.stdout.write(`\nrelease phase: ${report.phase} - ${report.phaseSummary}\n`);
  }
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

module.exports = { deploymentFilePath, tryEntryToken, classifyReleasePhase };
