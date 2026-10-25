require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-network-helpers');
require('@nomicfoundation/hardhat-chai-matchers');

const fs = require('node:fs');
const path = require('node:path');

const envFile = path.resolve(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) {
      continue;
    }
    const separator = entry.indexOf('=');
    if (separator < 0) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const PORTALDOT_TESTNET_EVM_RPC = 'https://test-evm-rpc-v3.portaldot.dev';
const PORTALDOT_TESTNET_NODE_WS = 'wss://test-node-v3.portaldot.dev';
const PORTALDOT_V3_CHAIN_ID = 420420777;

const deployerKey = process.env.PORTALDOT_DEPLOYER_PRIVATE_KEY;

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
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
