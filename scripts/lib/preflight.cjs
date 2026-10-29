// Reusable release preflight. Every condition that must hold before the
// first broadcast is validated here, sequentially, with injected probes so
// the whole runner can be exercised offline in tests.
//
// Deploy (before any deployment transaction) and bind (before any binding
// transaction) call runReleasePreflight with live probes. A testnet release
// fails closed: if any check does not pass, no transaction method is reached.

const { createHash } = require('node:crypto');
const {
  validateChainId,
  validateGasLimit,
  validateNativeId,
  validateEvmAddress,
  validateNativeAccountHash,
  validateContractArtifact,
  assessFunding,
  formatUnits,
  NATIVE_DECIMALS,
  EVM_DECIMALS,
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

async function runReleasePreflight(config, probes) {
  const checks = [];
  const failures = [];
  const record = (name, pass, detail) => {
    checks.push({ name, pass, detail: String(detail) });
    if (!pass) failures.push(name);
  };

  // 1. Connected EVM chain ID is exactly the expected one.
  try {
    const chainId = await probes.chainId();
    validateChainId(chainId, config.expectedChainId);
    record('chain id', true, chainId.toString());
  } catch (error) {
    record('chain id', false, error.message);
  }

  // 2. The configured deployer address and its native mapping are valid. The
  //    stored commitment is SHA-256 of the 32-byte account unless an explicit
  //    override was selected (status: 'override'); either way it must be a
  //    32-byte, non-zero hash. An SS58-derived commitment never passes.
  try {
    const evm = validateEvmAddress(config.deployerEvm, 'deployer EVM address');
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

  // 3. Funding threshold met on BOTH ledgers, in each ledger's own units.
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
  let assessment = null;
  try {
    assessment = assessFunding({
      requiredTpot: config.requiredTpot,
      evmBalanceWei,
      nativeFreeUnits,
      evmReadError,
      nativeReadError,
    });
    record(
      `funding (EVM ledger, ${EVM_DECIMALS} decimals)`,
      assessment.evmFunded,
      evmReadError !== null
        ? `read failed: ${evmReadError}`
        : `balance ${formatUnits(evmBalanceWei, EVM_DECIMALS)} tPOT, required ${formatUnits(assessment.requiredEvmWei, EVM_DECIMALS)} tPOT` +
          (assessment.evmShortfallWei > 0n ? `, short ${formatUnits(assessment.evmShortfallWei, EVM_DECIMALS)} tPOT` : '')
    );
    record(
      `funding (native ledger, ${NATIVE_DECIMALS} decimals)`,
      assessment.nativeFunded,
      nativeReadError !== null
        ? `read failed: ${nativeReadError}`
        : `balance ${formatUnits(nativeFreeUnits, NATIVE_DECIMALS)} tPOT, required ${formatUnits(assessment.requiredNativeUnits, NATIVE_DECIMALS)} tPOT` +
          (assessment.nativeShortfallUnits > 0n ? `, short ${formatUnits(assessment.nativeShortfallUnits, NATIVE_DECIMALS)} tPOT` : '')
    );
  } catch (error) {
    // assessFunding input-shape problems (read errors already excluded above)
    record('funding (both ledgers)', false, error.message);
  }

  // 4. Both intended native counterparts are explicitly configured.
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

  // 5. The configured asset and NFT collection exist on the native runtime
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

  // 6. Compiled artifacts exist and runtime bytecode is within the limit.
  for (const artifact of config.artifacts || []) {
    try {
      const bytes = validateContractArtifact(artifact.file, artifact.maxSizeBytes);
      record(`artifact ${artifact.name}`, true, `${artifact.file} (${bytes} runtime bytes)`);
    } catch (error) {
      record(`artifact ${artifact.name}`, false, error.message);
    }
  }

  // 7. Gas plan: the configured limit (or estimate-derived per-contract
  //    limit) must cover the RPC's own creation estimate and stay within
  //    the block gas limit. Gas numbers are BigInt - they exceed 2^53 here.
  const gasPlan = {};
  let blockGasLimit = null;
  let blockGasLimitError = null;
  try {
    blockGasLimit = BigInt(await probes.blockGasLimit());
  } catch (error) {
    blockGasLimitError = error.message;
  }
  for (const artifact of config.artifacts || []) {
    const providedOrDerived = [];
    try {
      if (blockGasLimit === null) {
        throw new Error(
          `the block gas limit could not be read (${blockGasLimitError}); the configured gas limit cannot be proven safe`
        );
      }
      const estimate = BigInt(await probes.estimateCreationGas(artifact));
      const marginPercent = config.gasMarginPercent === undefined ? DEFAULT_GAS_MARGIN_PERCENT : config.gasMarginPercent;
      const derived = (estimate * BigInt(100 + marginPercent)) / 100n;
      const limit = config.gasLimitRaw ? validateGasLimit(config.gasLimitRaw) : derived;
      providedOrDerived.push(config.gasLimitRaw ? 'POT_GAS_LIMIT' : `estimate + ${marginPercent}%`);
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
        `limit ${limit} (${providedOrDerived[0]}), RPC estimate ${estimate}, block limit ${blockGasLimit}`
      );
    } catch (error) {
      record(`gas plan (${artifact.name})`, false, error.message);
    }
  }

  // 8. All remaining configuration and registry argument sources validated
  //    before any signing (the ids are validated in step 4; token metadata
  //    below must be sensible strings, never empty).
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

  const ok = failures.length === 0;
  return { ok, checks, failures, gasPlan, assessment };
}

module.exports = { runReleasePreflight, DEFAULT_GAS_MARGIN_PERCENT };
