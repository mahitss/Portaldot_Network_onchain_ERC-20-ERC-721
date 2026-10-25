# PotToken Suite for Portaldot V3

On-chain ERC-20 and ERC-721 tokens for the Portaldot V3 testnet, plus a registry that binds each
token to its native `assets` or `nfts` counterpart, stores both decimal bases, and exposes a
SHA-256 commitment to the native account that owns the EVM identity.

The suite is deployed once per network and shared by every user. A Portaldot V3 contract deploy
costs roughly 529.84 tPOT, so per-user contracts are not viable; one shared deployment with a
binding registry keeps the cost fixed while still giving every holder a verifiable native link.

## Components

| Contract | Purpose |
| --- | --- |
| `PotERC20` | Fungible token with issuer-gated minting, holder/issuer/owner burns, approvals, transfers, and owner pause control. |
| `PotERC721` | NFT collection with sequential ids, metadata URIs, approvals, operator approvals, safe transfers with receiver checks, and burns. |
| `PotRegistry` | Binds a token address to a native `assets` id or `nfts` collection id, records both decimal bases, derives the conversion factor, stores the native account commitment, and verifies it on chain. |

Supporting code:

| Path | Purpose |
| --- | --- |
| `shared/` | Browser-safe primitives: pure JS BLAKE2b-512, base58, SS58 encode/decode, the deterministic EVM to native account mapping, SHA-256 commitment helper, and unit conversions. |
| `sdk/` | `PotTokenSuite` client for Node and browsers, plus generated contract ABIs. |
| `scripts/` | Preflight, deployment, binding, deployment verification, dual-ledger reads, and a static server for the console app. |
| `app/` | Static dual-ledger console: chain status, contract state, native account mapping, unit conversion, balances, and registry bindings. |
| `test/` | Hardhat test suite for the three contracts. |
| `sdk/test/` | Node test runner suite for the shared primitives. |
| `docs/` | Preflight evidence and product decision records. |

## Unit model

Portaldot native balances use 14 decimals while the EVM side uses 18, so one native base unit
equals `10^4` EVM wei. `PotRegistry` stores both decimal bases per binding and derives the factor
as `10 ** (evmDecimals - nativeDecimals)`, which is `10000` for a native asset with 14 decimals and
an ERC-20 with 18 decimals. Conversions are available both on chain (`convertToNative`,
`convertToEvm`) and off chain (`shared/portaldot.mjs`).

## Native account mapping

Portaldot derives the native account of an EVM address as the 20-byte H160 followed by twelve
`0xEE` bytes. That 32-byte account is encoded as SS58 with prefix 42, and the registry stores
`SHA-256(account bytes)` as the commitment.

```text
EVM address 0xf7eC65d11e35375A250e474059a917B537804142
account     0xf7ec65d11e35375a250e474059a917b537804142eeeeeeeeeeeeeeeeeeeeeeee
SS58        5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8Y
```

The mapping, the SS58 encoding, and the BLAKE2b-512 implementation are covered by vectors in
`sdk/test/portaldot.test.mjs`, including the pairs published in the official Portaldot V3 guide.

## Requirements

- Node.js 20 or newer
- A funded Portaldot V3 native account for deployment

## Quickstart

```bash
npm install
npm run compile
npm test
npm run test:sdk
```

`npm run check` runs compile, ABI generation, contract tests, and SDK tests in one command.

## Console app

```bash
npm run app
```

The command bundles the browser app with esbuild and serves the repository at
`http://localhost:4173/`. The console reads the deployed contracts from
`deployments/portaldotTestnet.json`, shows chain and contract status, maps EVM addresses to native
SS58 accounts, converts between 14 and 18 decimal amounts, and lists registry bindings. If the
browser cannot reach the RPC endpoint, the mapping and conversion panels still work offline.

## Deploying to the Portaldot V3 testnet

The deployer needs a native Portaldot account, because testnet balances are handed out to native
SS58 addresses and the EVM address is derived from that key.

```bash
export PORTALDOT_DEPLOYER_PRIVATE_KEY=0x...
npm run deploy:testnet
npm run verify:deployment
```

`deploy:testnet` writes `deployments/portaldotTestnet.json` with the contract addresses, deployment
transaction hashes, block numbers, and token metadata. Bind the deployed tokens to their native
counterparts afterwards:

```bash
export POT_NATIVE_ASSET_ID=1
export POT_NATIVE_NFT_ID=1
npm run bind:testnet
```

`POT_NATIVE_ACCOUNT` optionally overrides the account whose commitment is stored, and
`POT_NATIVE_ACCOUNT_HASH` accepts a precomputed commitment.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run compile` | Compile the contracts with solc 0.8.24, cancun evm version, viaIR pipeline, optimizer 1 run. |
| `npm run abi` | Regenerate `sdk/abi.generated.mjs` from the compiled artifacts. |
| `npm test` | Run the Hardhat contract test suite. |
| `npm run test:sdk` | Run the shared primitive tests with the Node test runner. |
| `npm run check` | Compile, regenerate ABIs, and run both test suites. |
| `npm run preflight` | Check the runtime, artifacts, RPC reachability, chain id, and deployed bytecode. |
| `npm run deploy:testnet` | Deploy the three contracts to Portaldot V3 and write the deployment file. |
| `npm run estimate:deploy` | Estimate the deployment cost of the three contracts on the live testnet through `eth_estimateGas`, without needing funds. |
| `npm run bind:testnet` | Bind deployed tokens to native asset or NFT ids. |
| `npm run verify:deployment` | Confirm bytecode, deployment receipts, registry state, and bindings. |
| `npm run dual:read` | Read the same identity from both ledgers, the EVM side over JSON-RPC and the native side over the Substrate WebSocket. |
| `npm run app` | Build and serve the static console app. |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PORTALDOT_DEPLOYER_PRIVATE_KEY` | Deployer key for the testnet network. |
| `PORTALDOT_EVM_RPC` | EVM JSON-RPC endpoint, defaults to `https://test-evm-rpc-v3.portaldot.dev`. |
| `PORTALDOT_RPC_URL` | Endpoint used by the standalone scripts. |
| `PORTALDOT_WS_URL` | Native WebSocket endpoint, defaults to `wss://test-node-v3.portaldot.dev`. |
| `PORTALDOT_NETWORK` | Deployment file name, defaults to `portaldotTestnet`. |
| `POT_DEPLOYMENTS` | Path to a deployment file for the verification script. |
| `POT_GAS_LIMIT` | Gas limit used for deployment transactions, defaults to 5000000. |
| `POT_GAS_PRICE` | Gas price used by the cost estimator, defaults to the live base fee. |
| `POT_NATIVE_ASSET_ID` | Native asset id for the ERC-20 binding. |
| `POT_NATIVE_NFT_ID` | Native NFT collection id for the ERC-721 binding. |
| `POT_NATIVE_ACCOUNT` | EVM address whose native account commitment is stored. |
| `POT_NATIVE_ACCOUNT_HASH` | Precomputed SHA-256 commitment. |

## Deployment cost

The deployment cost is dominated by the code deposit, so the suite is compiled with the viaIR
pipeline and a single optimizer run to keep the runtime bytecode small. Measured on the live
testnet with `eth_estimateGas` at the 31,270 wei base fee:

| Contract | Creation bytes | Runtime bytes | Cost |
| --- | --- | --- | --- |
| `PotERC20` | 4,058 | 2,775 | ≈ 249.18 tPOT |
| `PotERC721` | 5,799 | 4,517 | ≈ 391.25 tPOT |
| `PotRegistry` | 3,284 | 3,201 | ≈ 271.14 tPOT |
| **Total** | 13,141 | 10,493 | **≈ 911.57 tPOT** |

Request at least **1,050 tPOT** for the deployer account. The same estimates at the 32,580 wei
price seen earlier in the chain history come to ≈ 949.76 tPOT. `npm run estimate:deploy` refreshes
the numbers against the live base fee.

## Platform facts

- Chain id `420420777`, EVM RPC `https://test-evm-rpc-v3.portaldot.dev`, native WebSocket
  `wss://test-node-v3.portaldot.dev`
- Runtime `portaldot-v3` with `pallet-revive`, `pallet_contracts`, `pallet-assets`, and `pallet-nfts`
- Contract code size limit 10240 bytes; the deployed suite is roughly 2.8 kB, 4.5 kB, and 3.2 kB
- One shared deployment of this suite costs about 911.57 tPOT at the live base fee, a light call
  about 0.0153 tPOT, and a storage-heavy call about 58.94 tPOT

The full evidence trail is in `docs/PORTALDOT_PREFLIGHT.md`, and the product decision record is in
`docs/decisions/002-product-lock-revision.md`.

## Status

The contract suite, SDK, shared primitives, scripts, and console app are implemented and tested.
Deployment to the public Portaldot V3 testnet is waiting on a funded native deployer account; once
`deployments/portaldotTestnet.json` exists it is committed with the contract addresses and
transaction hashes.

## License

MIT
