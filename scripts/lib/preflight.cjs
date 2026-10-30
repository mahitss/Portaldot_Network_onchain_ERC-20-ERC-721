// Reusable release preflight, MODE AWARE. Every condition that must hold
// before the first transaction of a stage is validated here, sequentially,
// with injected probes so the whole stage can be exercised offline in tests.
//
// Two explicitly separated funding stages:
// - mode 'deploy' (before the first deployment transaction of the whole
//   release): verifies the complete expected whole-release budget - every
//   outstanding creation estimate x the live gas price, a defensible binding
//   reserve for the outstanding bindings, and a documented fee-fluctuation
//   margin - in BOTH ledgers' own units. A manual floor (POT_REQUIRED_TPOT)
//   can only raise the computed requirement.
// - mode 'bind' (after deployment has already spent its funds): re-estimates
//   each OUTSTANDING binding call on chain (eth_estimateGas) and requires
//   only the remaining transactions' cost. It never demands the original
//   deployment balance again, and additionally verifies the deployment
//   record identity and the deployed bytecode before anything is signed.
//
// A testnet release fails closed: if any check does not pass, no transaction
// method is reached by the calling script.

const { createHash } = require('node:crypto');
const {
  validateChainId,
  validateGasLimit,
  validateNativeId,
  validateEvmAddress,
  validateNativeAccountHash,
  validateContractArtifact,
  assessReleaseBudget,
  formatUnits,
  ceilDiv,
  NATIVE_DECIMALS,
  EVM_DECIMALS,
  WEI_PER_NATIVE_UNIT,
  CHAIN_ID,
} = require('./validation.cjs');

const DEFAULT_GAS_MARGIN_PERCENT = 20;

function sha256Hex(bytes) {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeHex32(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`not a 32-byte hex value: ${hex}`);
  }
  return Buffer.from(hex.slice(2), 'hex');
}

async function runPreflight(config, probes) {
  const checks = [];
  const failures = [];
  const record = (name, pass, detail) => {
    checks.push({ name, pass, detail: String(detail) });
    if (!pass) failures.push(name);
  };
  const mode = config.mode === 'bind' ? 'bind' : 'deploy';

  // 1. Connected EVM chain ID is exactly the expected one.
  try {
    const chainId = await probes.chainId();
    validateChainId(chainId, config.expectedChainId);
    record('chain id', true, chainId.toString());
  } catch (error) {
    record('chain id', false, error.message);
  }

  // 2. The EVM identity whose mapped native account is committed is valid.
  //    The stored commitment is SHA-256 of the 32-byte account unless an
  //    explicit override was selected (status: 'override'); either way it
  //    must be a 32-byte, non-zero hash. An SS58-derived commitment never
  //    passes. (Deploy mode checks the deployer; bind mode the signer.)
  try {
    const evm = validateEvmAddress(config.deployerEvm, mode === 'bind' ? 'signer EVM address' : 'deployer EVM address');
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.nativeAccount.hex)) {
      throw new Error('the derived native account is not a 32-byte hex value');
    }
    if (typeof config.nativeAccount.ss58 !== 'string' || config.nativeAccount.ss58.length < 4) {
      throw new Error('the derived native SS58 account is missing');
    }
    if (
      /^\d+$/.test(config.nativeAccount.ss58) ||
      !/^[1-9A-HJ-NP-Za-km-z]+$/.test(config.nativeAccount.ss58)
    ) {
      throw new Error(
        `the derived native account does not look like an SS58 encoding: ${config.nativeAccount.ss58}. Never interpret an SS58 address as an EVM address or vice versa.`
      );
    }
    let commitment;
    if (config.commitmentSource === 'override') {
      commitment = validateNativeAccountHash(config.nativeAccountHash, 'POT_NATIVE_ACCOUNT_HASH');
    } else {
      const recomputed = sha256Hex(decodeHex32(config.nativeAccount.hex));
      commitment = validateNativeAccountHash(config.nativeAccountHash, 'native account commitment');
      if (recomputed !== commitment) {
        throw new Error(
          `the native account commitment ${config.nativeAccountHash} is not SHA-256 of the 32-byte account ${config.nativeAccount.hex} (computed ${recomputed})`
        );
      }
    }
    if (commitment === `0x${'00'.repeat(32)}`) {
      throw new Error('the native account commitment is the zero hash, which the registry rejects');
    }
    record('deployer identity and native mapping', true, `${evm} -> ${config.nativeAccount.ss58} (commitment ${commitment.slice(0, 10)}…${config.commitmentSource === 'override' ? ', explicit override' : ', sha256 of 32-byte account'})`);
  } catch (error) {
    record('deployer identity and native mapping', false, error.message);
  }

  // Artifacts: runtime bytecode must exist and stay within the limit.
  for (const artifact of config.artifacts || []) {
    try {
      const bytes = validateContractArtifact(artifact.file, artifact.maxSizeBytes);
      record(`artifact ${artifact.name}`, true, `${artifact.file} (${bytes} runtime bytes)`);
    } catch (error) {
      record(`artifact ${artifact.name}`, false, error.message);
    }
  }

  let gasPlan = {};
  let bindGasPlan = {};
  const estimates = {};
  let budget = null;

  if (mode === 'deploy') {
    // 3. Gas plan for every OUTSTANDING creation transaction: the configured
    //    limit (or estimate-derived per-contract limit) must cover the RPC's
    //    own creation estimate and stay within the block gas limit. Gas
    //    numbers are BigInt - they exceed 2^53 on this chain.
    let blockGasLimit = null;
    let blockGasLimitError = null;
    try {
      blockGasLimit = BigInt(await probes.blockGasLimit());
    } catch (error) {
      blockGasLimitError = error.message;
    }
    for (const artifact of config.outstandingArtifacts || config.artifacts || []) {
      try {
        if (blockGasLimit === null) {
          throw new Error(
            `the block gas limit could not be read (${blockGasLimitError}); the configured gas limit cannot be proven safe`
          );
        }
        const estimate = BigInt(await probes.estimateCreationGas(artifact));
        estimates[artifact.name] = estimate;
        const marginPercent = config.gasMarginPercent === undefined ? DEFAULT_GAS_MARGIN_PERCENT : config.gasMarginPercent;
        const derived = (estimate * BigInt(100 + marginPercent)) / 100n;
        const limit = config.gasLimitRaw ? validateGasLimit(config.gasLimitRaw) : derived;
        const source = config.gasLimitRaw ? 'POT_GAS_LIMIT' : `estimate + ${marginPercent}%`;
        if (limit < estimate) {
          throw new Error(
            `gas limit ${limit} is below the RPC's own creation estimate ${estimate} for ${artifact.name}. A transaction signed with this limit cannot succeed; refusing to broadcast.`
          );
        }
        if (limit > blockGasLimit) {
          throw new Error(
            `gas limit ${limit} exceeds the block gas limit ${blockGasLimit}; refusing to broadcast a doomed transaction for ${artifact.name}`
          );
        }
        gasPlan[artifact.name] = limit;
        record(
          `gas plan (${artifact.name})`,
          true,
          `limit ${limit} (${source}), RPC estimate ${estimate}, block limit ${blockGasLimit}`
        );
      } catch (error) {
        record(`gas plan (${artifact.name})`, false, error.message);
      }
    }

    // 4. Whole-release funding. The requirement is computed from measured
    //    creation estimates plus a defensible binding reserve (the registry
    //    creation estimate per outstanding binding is the heaviest measured
    //    registry transaction and bounds the bind cost before any registry
    //    exists on chain) plus the configured fee margin - never a fixed
    //    balance handed down unchanged from stage to stage.
    try {
      const gasPrice = BigInt(await probes.gasPrice());
      const outstanding = config.outstandingArtifacts || config.artifacts || [];
      const creationEstimatesGas = outstanding.map((artifact) => {
        const estimate = estimates[artifact.name];
        if (estimate === undefined) {
          throw new Error(`the creation estimate for ${artifact.name} is missing because its gas plan failed; the budget cannot be computed fail-closed`);
        }
        return estimate;
      });
      const reserveCount = config.bindingReserveCount === undefined ? 0 : config.bindingReserveCount;
      if (!Number.isSafeInteger(reserveCount) || reserveCount < 0) {
        throw new Error(`bindingReserveCount must be a non-negative safe integer, got ${JSON.stringify(config.bindingReserveCount)}`);
      }
      let bindingEstimateGas = 0n;
      if (reserveCount > 0) {
        if (!config.bindingReserveArtifact) {
          throw new Error('a binding reserve is required but no artifact was provided to bound it; refusing to fund the release with an unbounded binding reserve');
        }
        bindingEstimateGas = estimates[config.bindingReserveArtifact.name];
        if (bindingEstimateGas === undefined) {
          // The registry is already deployed: re-estimate its creation cost
          // anyway to keep the reserve bounded by the heaviest measured
          // registry transaction (estimateGas never broadcasts).
          bindingEstimateGas = BigInt(await probes.estimateCreationGas(config.bindingReserveArtifact));
        }
      }
      let evmBalanceWei = null;
      let evmReadError = null;
      let nativeFreeUnits = null;
      let nativeReadError = null;
      try {
        evmBalanceWei = BigInt(await probes.evmBalance(config.deployerEvm));
      } catch (error) {
        evmReadError = error.message;
      }
      try {
        nativeFreeUnits = await probes.nativeFreeBalance(config.nativeAccount.ss58);
      } catch (error) {
        nativeReadError = error.message;
      }
      budget = assessReleaseBudget({
        creationEstimatesGas,
        bindingEstimateGas,
        outstandingBindings: reserveCount,
        gasPriceWei: gasPrice,
        feeMarginPercent: config.feeMarginPercent === undefined ? 20 : config.feeMarginPercent,
        requiredTpotFloor: config.requiredTpot,
        evmBalanceWei,
        nativeFreeUnits,
        evmReadError,
        nativeReadError,
      });

      record(
        'release budget (whole release)',
        true,
        `deployment ${outstanding.length} tx = ${budget.deploymentGas} gas, binding reserve ${reserveCount} x ${bindingEstimateGas} gas (registry-creation upper bound), subtotal ${budget.subtotalWei} wei, +${budget.feeMarginPercent}% margin ${budget.marginWei} wei, required ${budget.requiredEvmWei} wei (${formatUnits(ceilDiv(budget.requiredEvmWei, 10n ** BigInt(EVM_DECIMALS)), 0)} whole tPOT at ceil), floor ${budget.requiredTpotFloor} tPOT ${budget.floorApplied ? '(applied)' : '(computed budget dominates)'}`
      );
      record(
        `funding (EVM ledger, ${EVM_DECIMALS} decimals)`,
        budget.evmFunded,
        evmReadError !== null
          ? `read failed: ${evmReadError}`
          : `balance ${formatUnits(evmBalanceWei, EVM_DECIMALS)} tPOT, whole-release requirement ${formatUnits(budget.requiredEvmWei, EVM_DECIMALS)} tPOT` +
            (budget.evmShortfallWei > 0n ? `, short ${formatUnits(budget.evmShortfallWei, EVM_DECIMALS)} tPOT` : '')
      );
      record(
        `funding (native ledger, ${NATIVE_DECIMALS} decimals)`,
        budget.nativeFunded,
        nativeReadError !== null
          ? `read failed: ${nativeReadError}`
          : `balance ${formatUnits(nativeFreeUnits, NATIVE_DECIMALS)} tPOT, whole-release requirement ${formatUnits(budget.requiredNativeUnits, NATIVE_DECIMALS)} tPOT` +
            (budget.nativeShortfallUnits > 0n ? `, short ${formatUnits(budget.nativeShortfallUnits, NATIVE_DECIMALS)} tPOT` : '')
      );
    } catch (error) {
      record('release budget (whole release)', false, error.message);
      record('funding (both ledgers)', false, 'the whole-release budget could not be computed; refusing to broadcast');
    }
  } else {
    // 3. The deployment record must belong to exactly this network, chain
    //    and identity. Binding never operates against a record from another
    //    release, and never re-deploys: it reuses recorded contracts only.
    try {
      const snapshot = config.record;
      if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('no validated deployment record was provided to the binding preflight');
      }
      if (typeof snapshot.network !== 'string' || snapshot.network.length === 0) {
        throw new Error('the deployment record has no network name');
      }
      if (snapshot.network !== config.networkName) {
        throw new Error(`the deployment record network is ${snapshot.network}, the connected network is ${config.networkName}`);
      }
      if (Number(snapshot.chainId) !== CHAIN_ID) {
        throw new Error(`the deployment record chainId is ${snapshot.chainId}, expected ${CHAIN_ID}`);
      }
      const recordDeployer = validateEvmAddress(snapshot.deployer, 'deployment record deployer');
      const identity = validateEvmAddress(config.identityEvm, 'binding identity (POT_NATIVE_ACCOUNT_EVM or record deployer)');
      if (recordDeployer !== identity) {
        throw new Error(
          `the deployment record deployer ${recordDeployer} does not match the binding identity ${identity}; binding with mismatched identities would commit an account hash the deployment never intended`
        );
      }
      record('deployment record identity (network, chainId, deployer)', true, `${snapshot.network} chainId ${snapshot.chainId} deployer ${recordDeployer}`);
    } catch (error) {
      record('deployment record identity (network, chainId, deployer)', false, error.message);
    }

    // 4. Deployed bytecode must actually exist at every recorded contract
    //    address the binding depends on. A record whose contracts vanished
    //    or were never deployed must never be signed against.
    const codeTargets = [
      ['PotRegistry', config.registryAddress],
      ['PotERC20', config.tokenAddresses ? config.tokenAddresses.erc20 : undefined],
      ['PotERC721', config.tokenAddresses ? config.tokenAddresses.erc721 : undefined],
    ];
    for (const [name, address] of codeTargets) {
      try {
        const code = await probes.code(address);
        if (typeof code !== 'string' || code === '0x' || code === '') {
          throw new Error(`no bytecode at ${address}`);
        }
        record(`${name} bytecode present`, true, `${(code.length - 2) / 2} runtime bytes at ${address}`);
      } catch (error) {
        record(`${name} bytecode present`, false, `bytecode check failed for ${name}: ${error.message}`);
      }
    }

    // 5. Remaining-binding budget: re-estimate every OUTSTANDING bind call
    //    on chain at binding time and require only the outstanding cost -
    //    never the original full deployment balance again. The gas plan per
    //    call must stay within the block gas limit (same doom-transaction
    //    discipline as the deploy mode).
    try {
      const gasPrice = BigInt(await probes.gasPrice());
      const calls = config.outstandingCalls || [];
      let blockGasLimit = null;
      try {
        blockGasLimit = BigInt(await probes.blockGasLimit());
      } catch {
        // handled per call below
      }
      if (calls.length > 0 && blockGasLimit === null) {
        throw new Error('the block gas limit could not be read; a bind transaction gas limit cannot be proven safe');
      }
      const callEstimates = [];
      let bindingBudgetWei = 0n;
      for (const call of calls) {
        const estimate = BigInt(await probes.estimateCall({ to: call.to, data: call.data, from: config.deployerEvm }));
        callEstimates.push({ label: call.label, estimate });
        const limit = (estimate * BigInt(100 + DEFAULT_GAS_MARGIN_PERCENT)) / 100n;
        if (limit > blockGasLimit) {
          throw new Error(`bind gas limit ${limit} exceeds the block gas limit ${blockGasLimit}; refusing to broadcast a doomed transaction for ${call.label}`);
        }
        bindGasPlan[call.label] = limit;
        record(
          `bind gas plan (${call.label})`,
          true,
          `estimate ${estimate}, limit ${limit} (estimate + ${DEFAULT_GAS_MARGIN_PERCENT}%), block limit ${blockGasLimit}`
        );
        bindingBudgetWei += estimate * gasPrice;
      }
      const feeMarginPercent = config.feeMarginPercent === undefined ? 20 : config.feeMarginPercent;
      const marginWei = ceilDiv(bindingBudgetWei * BigInt(feeMarginPercent), 100n);
      const requiredEvmWei = bindingBudgetWei + marginWei;
      const requiredNativeUnits = ceilDiv(requiredEvmWei, WEI_PER_NATIVE_UNIT);
      budget = {
        deploymentBudgetWei: 0n,
        bindingBudgetWei,
        feeMarginPercent,
        marginWei,
        requiredEvmWei,
        requiredNativeUnits,
        requiredTpotFloor: 0n,
        floorApplied: false,
      };

      let evmBalanceWei = null;
      let evmReadError = null;
      let nativeFreeUnits = null;
      let nativeReadError = null;
      try {
        evmBalanceWei = BigInt(await probes.evmBalance(config.deployerEvm));
      } catch (error) {
        evmReadError = error.message;
      }
      try {
        nativeFreeUnits = await probes.nativeFreeBalance(config.nativeAccount.ss58);
      } catch (error) {
        nativeReadError = error.message;
      }

      record(
        'binding budget (remaining phase)',
        true,
        `${calls.length} outstanding bind call(s); subtotal ${bindingBudgetWei} wei, +${feeMarginPercent}% margin ${marginWei} wei, required ${requiredEvmWei} wei (${formatUnits(ceilDiv(requiredEvmWei, 10n ** BigInt(EVM_DECIMALS)), 0)} whole tPOT at ceil)`
      );
      record(
        `funding (EVM ledger, ${EVM_DECIMALS} decimals)`,
        evmReadError === null && evmBalanceWei >= requiredEvmWei,
        evmReadError !== null
          ? `read failed: ${evmReadError}`
          : `balance ${formatUnits(evmBalanceWei, EVM_DECIMALS)} tPOT, remaining-binding requirement ${formatUnits(requiredEvmWei, EVM_DECIMALS)} tPOT` +
            (evmBalanceWei < requiredEvmWei ? `, short ${formatUnits(requiredEvmWei - evmBalanceWei, EVM_DECIMALS)} tPOT` : '')
      );
      record(
        `funding (native ledger, ${NATIVE_DECIMALS} decimals)`,
        nativeReadError === null && nativeFreeUnits >= requiredNativeUnits,
        nativeReadError !== null
          ? `read failed: ${nativeReadError}`
          : `balance ${formatUnits(nativeFreeUnits, NATIVE_DECIMALS)} tPOT, remaining-binding requirement ${formatUnits(requiredNativeUnits, NATIVE_DECIMALS)} tPOT` +
            (nativeFreeUnits < requiredNativeUnits ? `, short ${formatUnits(requiredNativeUnits - nativeFreeUnits, NATIVE_DECIMALS)} tPOT` : '')
      );
    } catch (error) {
      record('binding budget (remaining phase)', false, error.message);
      record('funding (both ledgers)', false, 'the remaining-binding budget could not be computed; refusing to sign');
    }
  }

  // 6. Intended native counterparts must be explicitly configured.
  try {
    const kinds = new Set((config.nativeObjects || []).map((object) => object.kind));
    const configured = [];
    for (const object of config.nativeObjects || []) {
      object.id = validateNativeId(object.id, `${object.kind} id`);
      configured.push(object.kind);
    }
    if (config.requireDualCounterparts) {
      if (!kinds.has('asset') || !kinds.has('nft_collection')) {
        throw new Error(
          'the dual-ledger release requires BOTH counterparts to be configured: set POT_NATIVE_ASSET_ID and POT_NATIVE_NFT_ID explicitly. Values are never guessed and a missing value aborts the release.'
        );
      }
    }
    if (configured.length === 0) {
      throw new Error('no native objects are configured for this release');
    }
    record('native counterparts configured', true, configured.join(', '));
  } catch (error) {
    record('native counterparts configured', false, error.message);
  }

  // 7. The configured asset and NFT collection exist on the native runtime
  //    (Option::Some; Option::None, unsupported queries, RPC failures and
  //    timeouts are all rejections from the runtime helper).
  for (const object of config.nativeObjects || []) {
    try {
      const result = await probes.nativeObject(object.kind, object.id);
      record(`${object.kind} ${object.id} exists on the native runtime`, true, result.details);
    } catch (error) {
      record(`${object.kind} ${object.id} exists on the native runtime`, false, error.message);
    }
  }

  // 8. All remaining configuration and registry argument sources validated
  //    before any signing (the ids are validated in step 6; token metadata
  //    must be sensible strings, never empty).
  if (config.tokenConfig) {
    try {
      const tokenConfig = config.tokenConfig || {};
      for (const [field, value] of Object.entries(tokenConfig)) {
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error(`${field} is empty`);
        }
        if (value.length > 64) {
          throw new Error(`${field} is longer than 64 characters`);
        }
      }
      record('token configuration', true, `${tokenConfig.erc20Name} / ${tokenConfig.erc721Name}`);
    } catch (error) {
      record('token configuration', false, error.message);
    }
  }

  const ok = failures.length === 0;
  return { ok, checks, failures, mode, gasPlan, bindGasPlan, budget: budget };
}

// Back-compatible deploy-stage entry point used by deploy.js and the 006.1
// tests. bind.js calls runPreflight with a mode:'bind' config instead.
function runReleasePreflight(config, probes) {
  return runPreflight({ ...config, mode: config.mode === 'bind' ? 'bind' : 'deploy' }, probes);
}

module.exports = { runPreflight, runReleasePreflight, DEFAULT_GAS_MARGIN_PERCENT };
