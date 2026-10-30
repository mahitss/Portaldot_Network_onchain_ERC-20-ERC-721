# PotToken Suite for Portaldot V3

On-chain ERC-20 and ERC-721 tokens for the Portaldot V3 testnet, plus a registry that binds each
token to its native `assets` or `nfts` counterpart, stores both decimal bases, and stores a
SHA-256 commitment to the native account derived from the EVM identity.

The suite is deployed once per network and shared by every user. A Portaldot V3 contract deploy
costs hundreds of tPOT (see the read-only estimates below), so per-user contracts are not viable;
one shared deployment with a binding registry keeps the cost fixed while still giving every holder
a verifiable native link.

## Components

| Contract | Purpose |
| --- | --- |
| `PotERC20` | Fungible token with issuer-gated minting, holder/issuer/owner burns, approvals, transfers, and owner pause control. |
| `PotERC721` | NFT collection with sequential ids, metadata URIs, approvals, operator approvals, safe transfers with receiver checks, and burns. |
| `PotRegistry` | Binds a token address to a native `assets` id or `nfts` collection id, records both decimal bases, derives the conversion factor, stores a SHA-256 native-account commitment, and checks commitment equality on chain. |

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

### Commitment semantics

The registry stores `SHA-256(account bytes)` as a commitment and `verifyNativeAccount`
checks that a supplied hash equals the stored commitment. This is a commitment-equality
check only: it proves the registrant recorded a specific hash, not that the caller
controls the native account or that the native asset is linked to the EVM token. An
independently verified native-ledger relationship is outside the scope of this contract.

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

`deploy:testnet` runs the stage-aware release preflight before broadcasting: chain id 420420777,
deployer identity and mapped native account, the whole-release funding requirement (measured
creation estimates for all outstanding contracts, a binding reserve for the outstanding registry
bindings, and a documented fee-fluctuation margin) on both ledgers in their own units, explicit
configured native counterparts and their existence on the native runtime, artifact byte sizes, and
the gas plan (see `scripts/lib/preflight.cjs`). If any check fails, nothing is signed. On success
it writes `deployments/portaldotTestnet.json` with the contract addresses, deployment transaction
hashes, block numbers, and token metadata. Bind the deployed tokens to their native counterparts
afterwards:

```bash
export POT_NATIVE_ASSET_ID=1
export POT_NATIVE_NFT_ID=1
npm run bind:testnet
```

`bind:testnet` is stage-aware too: because deployment has already spent its funds, its preflight
budgets **only the remaining binding transactions** (each re-estimated live with `eth_estimateGas`)
and never demands the original deployment balance again. It revalidates the deployment record
identity and live bytecode, compares an already-bound token against the intended configuration
instead of blindly accepting it, and aborts on any mismatch. A pending binding entry is reconciled
from its chain receipt instead of sending a duplicate transaction. `POT_NATIVE_ACCOUNT_EVM`
optionally overrides the EVM address whose mapped native account commitment is stored (the legacy
name `POT_NATIVE_ACCOUNT` is still accepted), and `POT_NATIVE_ACCOUNT_HASH` accepts a precomputed
commitment.

The deployment flow is resumable and idempotent: each confirmed contract is persisted immediately
after it is sent, and rerunning `deploy:testnet` reuses confirmed contracts instead of redeploying
them, so a rerun never deploys duplicates or overwrites recorded evidence. A malformed or mismatched
deployment record is never silently overwritten; replacing it requires the explicit
`POT_FORCE_FRESH_RELEASE=1` operation, which archives the old record first.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run compile` | Compile the contracts with solc 0.8.24, cancun evm version, optimizer 200 runs. |
| `npm run abi` | Regenerate `sdk/abi.generated.mjs` from the compiled artifacts. |
| `npm test` | Run the Hardhat contract test suite. |
| `npm run test:sdk` | Run the shared primitive tests with the Node test runner. |
| `npm run test:release` | Run the offline release-safety tests (funding units, native Option handling, preflight ordering, gas plan, verification, lifecycle/recovery). |
| `npm run check` | Compile, regenerate ABIs, and run all three test suites plus the app build. |
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
| `POT_GAS_LIMIT` | Optional fixed gas limit for deployment transactions, in the chain's gas units (BigInt-safe). If set, the preflight requires it to be a positive integer at or above the RPC's own creation estimate and at or below the block gas limit. If unset, the limit per contract is the creation estimate plus a 20 percent margin. |
| `POT_GAS_PRICE` | Gas price used by the cost estimator, defaults to the live base fee. |
| `POT_REQUIRED_TPOT` | Manual whole-release funding floor in whole tPOT (defaults to 1350). The preflight computes the whole-release requirement from live estimates and only raises it if this floor is higher; the floor never lowers the computed requirement. |
| `POT_RELEASE_FEE_MARGIN_PCT` | Fee-fluctuation margin applied to the whole-release budget, an integer percent 0–100 (defaults to 20; observed base-fee swing was ≈ +19%). |
| `POT_FORCE_FRESH_RELEASE` | Set to `1` to deliberately replace the existing deployment record. The old record is archived (never deleted) before restarting; without it a malformed or mismatched record aborts the release. |
| `POT_NATIVE_ASSET_ID` | Native asset id for the ERC-20 binding; required for the dual-ledger release and must exist on the native runtime. |
| `POT_NATIVE_NFT_ID` | Native NFT collection id for the ERC-721 binding; required for the dual-ledger release and must exist on the native runtime. |
| `POT_NATIVE_ACCOUNT_EVM` | EVM address whose native account commitment is stored; the legacy name `POT_NATIVE_ACCOUNT` is still accepted. SS58 addresses are always rejected here. |
| `POT_NATIVE_ACCOUNT_HASH` | Precomputed SHA-256 commitment. |
| `POT_ALLOW_UNBOUND` | Explicit opt-out allowing `verify:deployment` to pass with zero recorded bindings (`true` only). |

## Deployment cost

The deployment cost is dominated by the code deposit, so the suite is compiled with solc 0.8.24,
cancun evm version and optimizer 200 runs (no viaIR). Measured on the live testnet with
`eth_estimateGas` at the 31,000 wei base fee:

| Contract | Creation bytes | Runtime bytes | Cost |
| --- | --- | --- | --- |
| `PotERC20` | 4,431 | 3,258 | ≈ 287.48 tPOT |
| `PotERC721` | 6,569 | 5,391 | ≈ 457.07 tPOT |
| `PotRegistry` | 5,636 | 5,545 | ≈ 460.56 tPOT |
| **Total** | 16,636 | 14,194 | **≈ 1,205.11 tPOT** |

Per-contract runtime is under the 10,240 byte Revive limit. The three clearly labeled release
budgets (BigInt throughout; costs exceed 2^53 gas units):

| Budget | Label | Value (measured 2026-10-29 at ≈ 27,440 wei) |
| --- | --- | --- |
| **Minimum deployment budget** | deployment estimates only, not the total release cost | ≈ 1,209.9 tPOT |
| **Remaining binding budget** | reserve for the 2 registry bindings, bounded by the registry creation estimate (heaviest measured registry transaction) | ≈ 913.7 tPOT |
| **Whole-release recommended balance** | minimum deployment budget + binding reserve + 20% fee margin | ≥ **2,549 tPOT** |

The legacy 1,350 tPOT recommendation covered only the deployment estimate and is **insufficient for
the whole release** — do not rely on it as the final funding target. Base fees vary (measured
between 29,790 and 32,580 wei), so the 20% margin is applied on top of the measured subtotal.
`npm run estimate:deploy` refreshes the numbers against the live base fee, and the release
preflight recomputes the whole-release requirement live before the first transaction, failing
closed if either ledger's balance is insufficient (native balances use 14 decimals, EVM balances
use 18 decimals; both compared in BigInt).

### Gas units on this chain

These are Substrate/PolkaVM-scale gas numbers, not 12-million-EVM-scale numbers: a read-only probe
(2026-10-29) returned a block gas limit of `18446744073709551615` (`u64::MAX`) and per-contract
creation estimates between `1.06e16` and `1.69e16` gas units, which exceed JavaScript's safe
integer range, so they are handled as `BigInt` end to end. A fixed `POT_GAS_LIMIT` of `5,000,000`
cannot succeed here. The release therefore never guesses: without the variable, each contract gets
its RPC creation estimate plus a 20 percent margin; with it, the configured value must cover the
estimate and fit within the block limit or the preflight refuses to broadcast.

## Platform facts

- Chain id `420420777`, EVM RPC `https://test-evm-rpc-v3.portaldot.dev`, native WebSocket
  `wss://test-node-v3.portaldot.dev`
- Runtime `portaldot-v3` with `pallet-revive`, `pallet_contracts`, `pallet-assets`, and `pallet-nfts`
- Contract code size limit 10240 bytes; the deployed suite is roughly 3.3 kB, 5.4 kB, and 5.5 kB
- One shared deployment of this suite costs about 1,205 tPOT at the measured base fee (deployment estimate only — the whole-release recommended balance is ≥ 2,549 tPOT including the binding reserve and fee margin); a light call about 0.0153 tPOT, and a storage-heavy call about 58.94 tPOT

The full evidence trail is in `docs/PORTALDOT_PREFLIGHT.md`, and the product decision record is in
`docs/decisions/002-product-lock-revision.md`.

## Status

The contract suite, SDK, shared primitives, scripts, and console app are implemented and tested.
Deployment to the public Portaldot V3 testnet is waiting on a funded native deployer account; once
`deployments/portaldotTestnet.json` exists it is committed with the contract addresses and
transaction hashes.

## License

MIT
