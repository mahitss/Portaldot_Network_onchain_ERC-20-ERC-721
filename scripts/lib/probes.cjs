// Live dependency-injection probes for the release preflight and flows.
// Providers and artifacts come from Hardhat/ethers; the preflight itself
// stays offline-testable because tests inject fakes instead of these.

const { ContractFactory } = require('ethers');
const { queryNativeObject, readNativeFreeBalance } = require('./native-runtime.cjs');

function buildLiveProbes({ provider, wsUrl, from }) {
  return {
    async chainId() {
      const network = await provider.getNetwork();
      return network.chainId;
    },
    async evmBalance(address) {
      return provider.getBalance(address);
    },
    async gasPrice() {
      const feeData = await provider.getFeeData();
      if (feeData === null || feeData === undefined || feeData.gasPrice === null || feeData.gasPrice === undefined) {
        throw new Error('the RPC provided no gas price (fee unavailable); the release budget cannot be computed fail-closed');
      }
      return BigInt(feeData.gasPrice);
    },
    async blockGasLimit() {
      const block = await provider.getBlock('latest');
      if (!block) {
        throw new Error('the latest block could not be read from the RPC');
      }
      return block.gasLimit;
    },
    async estimateCreationGas(artifact) {
      try {
        const factory = new ContractFactory(artifact.abi, artifact.bytecode, provider);
        const tx = await factory.getDeployTransaction(...(artifact.args || []));
        return await provider.estimateGas({ from, data: tx.data });
      } catch (error) {
        throw new Error(
          `eth_estimateGas failed for ${artifact.name}: ${error.shortMessage || error.message}. Without a working creation estimate the configured gas limit cannot be proven sufficient, so the release fails closed.`
        );
      }
    },
    // Live re-estimate of an arbitrary call (bind-mode budgeting). Read-only:
    // estimateGas never broadcasts.
    async estimateCall({ to, data, from: callFrom }) {
      if (typeof to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
        throw new Error(`estimateCall received an invalid target address: ${to}`);
      }
      try {
        return await provider.estimateGas({ to, data, from: callFrom });
      } catch (error) {
        throw new Error(
          `eth_estimateGas failed for the call to ${to}: ${error.shortMessage || error.message}. Without a working call estimate the remaining-transaction budget cannot be proven sufficient, so the stage fails closed.`
        );
      }
    },
    // Deployed bytecode at an address ('' when none). Never interprets a
    // failed read as an absence proof: read errors propagate.
    async code(address) {
      try {
        return await provider.getCode(address);
      } catch (error) {
        throw new Error(`eth_getCode failed for ${address}: ${error.shortMessage || error.message}`);
      }
    },
    async receipt(txHash) {
      if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error(`receipt probe received an invalid transaction hash: ${txHash}`);
      }
      return provider.getTransactionReceipt(txHash);
    },
    async transaction(txHash) {
      if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error(`transaction probe received an invalid transaction hash: ${txHash}`);
      }
      return provider.getTransaction(txHash);
    },
    async nativeFreeBalance(ss58) {
      return readNativeFreeBalance({ wsUrl, ss58 });
    },
    async nativeObject(kind, id) {
      return queryNativeObject({ wsUrl, kind, id });
    },
  };
}

module.exports = { buildLiveProbes };
