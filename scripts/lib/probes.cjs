// Live dependency-injection probes for the release preflight.
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
    async nativeFreeBalance(ss58) {
      return readNativeFreeBalance({ wsUrl, ss58 });
    },
    async nativeObject(kind, id) {
      return queryNativeObject({ wsUrl, kind, id });
    },
  };
}

module.exports = { buildLiveProbes };
