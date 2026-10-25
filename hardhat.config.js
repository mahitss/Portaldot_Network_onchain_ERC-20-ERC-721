require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-network-helpers');
require('@nomicfoundation/hardhat-chai-matchers');

const PORTALDOT_TESTNET_EVM_RPC = 'https://test-evm-rpc-v3.portaldot.dev';
const PORTALDOT_TESTNET_NODE_WS = 'wss://test-node-v3.portaldot.dev';
const PORTALDOT_V3_CHAIN_ID = 420420777;

const deployerKey = process.env.PORTALDOT_DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      evmVersion: 'cancun',
    },
  },
  networks: {
    hardhat: {
      chainId: PORTALDOT_V3_CHAIN_ID,
      allowUnlimitedContractSize: false,
    },
    portaldotTestnet: {
      url: process.env.PORTALDOT_EVM_RPC || PORTALDOT_TESTNET_EVM_RPC,
      chainId: PORTALDOT_V3_CHAIN_ID,
      accounts: deployerKey ? [deployerKey] : [],
    },
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
  mocha: {
    timeout: 120000,
  },
  portaldot: {
    testnet: {
      evmRpc: PORTALDOT_TESTNET_EVM_RPC,
      nodeWs: PORTALDOT_TESTNET_NODE_WS,
      chainId: PORTALDOT_V3_CHAIN_ID,
    },
  },
};
