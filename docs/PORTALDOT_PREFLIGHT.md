# Portaldot V3 Preflight — verified platform and workspace state

**Date:** 2026-10-25 (IST, UTC+05:30) · **Author:** engineering execution agent (Codex)
**Mission:** PORTALDOT REAL-PRODUCT FOUNDATION — Phase 1–3 (verify), Phase 5–6 (contract, docs)
**Method constraint:** read-only. **No transaction was sent** by this agent. No secret, seed phrase, or private key was read or printed. No dependency was installed; no lockfile was created or changed.

---

## 1. Repository starting state

| Item | Observed |
|---|---|
| Workspace | `C:\Users\pc\OneDrive\Desktop\portal house hack` |
| Directory entries (incl. hidden) | **0** — verified with `Get-ChildItem -Force -Recurse | Measure-Object` → `Count : 0` |
| Git repository | **No.** `git status --short --branch` → `fatal: not a git repository`; `git rev-parse HEAD` → same; `Test-Path .git` → `False` |
| Current commit SHA | **None** (no commits, no remotes, no branches) |
| Package manifests / lockfiles | **None** |
| `.env` files, secrets, keys | **None present** (nothing to redact; none printed) |
| Backend services, DB schema, migrations | **None** |
| Deployment config | **None** |
| Existing tests | **None** |
| Existing functionality to preserve | **None** — greenfield |

The parent `Desktop` contains many unrelated sibling projects (not part of this workspace); none is a Portaldot project. The workspace itself is empty, so no second application was created beside an existing one and nothing was reset, cleaned, or overwritten.

**Conclusion:** starting state is a blank workspace, not an existing codebase. This mission therefore produces evidence + a build contract only; no application code is created yet.

## 2. Local environment

| Tool | Version |
|---|---|
| OS / Shell | Windows 11, PowerShell 5.1.26100.9711 |
| Node.js | v24.11.0 (npm 11.6.1) |
| Python | 3.13.5 |
| Rust | cargo/rustc 1.99.0 |
| Git | 2.52.0.windows.1 |
| curl | 8.21.0 (Schannel TLS; supports `ws`/`wss`) |
| **Absent** | `forge` (Foundry), `solc`, `wscat` — no EVM/WASM contract toolchain is installed locally |

## 3. Connectivity results (Phase 2)

All probes run from this machine, 2026-10-25 13:30–13:40 IST.

### 3.1 DNS — PASS

| Host | A records | AAAA | TTL |
|---|---|---|---|
| `test-evm-rpc-v3.portaldot.dev` | 104.21.11.196, 172.67.150.59 | 2606:4700:3031::6815:bc4, ::ac43:963b | 299 |
| `test-node-v3.portaldot.dev` | 104.21.11.196, 172.67.150.59 | same | 300 |
| `node-console.portaldot.dev` | 104.21.11.196, 172.67.150.59 | same | 300 |

All three resolve via Cloudflare. No DNS failure occurred.

### 3.2 EVM JSON-RPC over HTTPS — PASS

Endpoint `https://test-evm-rpc-v3.portaldot.dev`, `Content-Type: application/json`, HTTP 200 throughout.

| Call | Result |
|---|---|
| `eth_chainId` | `0x190f1ca9` = **420420777** — equals expected chain ID ✔ |
| `net_version` | `420420777` ✔ |
| `eth_blockNumber` (13:30:03) | `0x2d789` = 186,249 |
| `eth_getBlockByNumber("latest", true)` | number `0x2d793` = 186,259, hash `0xb526b440…eae5`, parentHash `0xef1fe441…23b4`, timestamp `0x6addb73c` = 1,792,915,260 (2026-10-25 08:01:00 UTC — coherent with wall clock) |
| `web3_clientVersion` | `eth-rpc/main-fddd431/x86_64-unknown-linux-gnu/rustc1.98.0` |
| `eth_gasPrice` / block `baseFeePerGas` | `0x7a99` = 31,385 wei |
| `eth_maxPriorityFeePerGas` | `0x0` |
| `eth_accounts` | `[]` (no unlocked accounts — expected) |
| `eth_syncing` | `false` |
| `eth_getBalance(0x…01)` | `0x1` |
| `eth_getCode(unmapped addr)` | `0x` |
| `eth_call` / `eth_estimateGas` / `eth_getLogs` | respond correctly (`0x`, `0x5cc3f9901a`, `[]`) |
| `eth_getTransactionReceipt(unknown hash)` | `null` (clean negative, no error) |

Block coherence: numbers increase monotonically, parent hashes link, timestamps advance with wall clock, hashes are distinct 32-byte values. Block cadence measured as **10 blocks in 64 s ≈ 6.4 s/block**, consistent with the 6000 ms median independently reported by a V3 participant.

### 3.3 Native WebSocket — PASS (Substrate JSON-RPC), EVM namespace absent

`wss://test-node-v3.portaldot.dev` opens successfully (TLS + JSON-RPC frames, close code 1005 normal).

| Method | Result |
|---|---|
| `system_chain` | `PortaldotV3 Test` |
| `system_health` | `{"peers":1,"isSyncing":false,"shouldHavePeers":true}` |
| `system_properties` | `{"ss58Format":42,"tokenDecimals":14,"tokenSymbol":"tPOT"}` |
| `system_version` | `3.0.0-dev-fddd43141f2` |
| `system_chainType` | `Live` |
| `chain_getRuntimeVersion` / `state_getRuntimeVersion` | specName `portaldot-v3`, implName `portaldot-v3-node`, authoringVersion 10, **specVersion 3002**, transactionVersion 2 |
| `chain_getBlockHash`, `chain_getFinalizedHead`, `chain_getBlock` | work; finalized head lagged best head by ~3 blocks (best `0x2d800`, finalized `0x2d7fd`) |
| `rpc_methods` | **135 methods** (author_*, chain_*, state_*, system_*, payment_*, childstate_*, archive_*, offchain_*, beefy_*, grandpa_*, mmr_*, statement_*) |
| `state_getMetadata` | 561,916 bytes (decoded below) |
| `eth_chainId`, `eth_blockNumber`, `net_version`, `chainHead` (as `chain_head_v1`) over WS | **`-32601 Method not found`** |
| `author_submitExtrinsic` | `-32602 Invalid params: No more params` → method recognised |

**Key architectural fact:** the HTTPS endpoint serves the **EVM (revive) namespace**; the WebSocket endpoint serves the **Substrate namespace**. They are different RPC surfaces on the same chain, not one merged surface.

### 3.4 Explorer / receipt lookup

* `https://node-console.portaldot.dev/` → HTTP 200, React SPA ("Portaldot Node Console"), Cloudflare-served. `env-config.js` returns `index.html` (SPA fallback). Every probed path (`/robots.txt`, `/api-docs`, `/openapi.json`, `/api/v1/blocks/latest`) returns **HTML, not JSON** → **no public REST API and no confirmed deep-link format** for tx hash / address / block.
* The explorer is a **manual-configured WS client** (bundle contains `apiUrl`, `ws://`/`wss://` validation) — the user must paste a node URL.
* Receipt lookup **does work** via the EVM RPC: `eth_getTransactionReceipt` returns full receipts for real transactions (§6).
* Community indexer **Pindex / PortalIndex** (`https://portalindex-98f0.onrender.com`, repo `youthisguy/portalIndex`) exposes an unauthenticated JSON API and is actively indexing V3:
  * `GET /contracts` → `[{slug,name,address,created_at}, …]`
  * `GET /indexer_cursor` → `{"chain_key":"0xd4f9acbc…","last_block":186472,"updated_at":"2026-10-25T08:22:31Z"}` (block height consistent with the live chain)
  * `GET /indexer_gaps` → JSON; `GET /c/{address}` → `{"error":"Unknown contract."}` for unindexed addresses
  * Unauthenticated (no API key required for these routes). Community-run on a free Render tier → **not a dependency we may rely on for production**.

## 4. Runtime capability envelope (from `state_getMetadata`, V3 spec 3002)

Pallet names decoded from the metadata hex: **System, Balances, Assets, Uniques/Nfts, Contracts (pallet_contracts), Revive (pallet_revive), PolkaVM, TransactionStorage, Multisig, Utility, Treasury, Staking, Identity, Lottery, Proxy, Scheduler, Bounties, Vesting, Timestamp, TransactionPayment, Offences, Session, Grandpa, Babe, ImOnline, Oracle, Technical, Recovery, Preimage, Beefy, Mmr, Statement, DelegatedStaking**.

Runtime APIs confirmed to exist (probe = method name resolves in the runtime vs. `Exported method … is not found`):

| Runtime API | Status | Evidence |
|---|---|---|
| `Core_version` | exists | returned `portaldot-v3`, spec 3002 |
| **`ReviveApi_call`** | exists | panics on bad args (i.e. method reached) — used by the official guide for contract reads/dry-runs |
| **`ReviveApi_eth_transact`** | exists | panics on bad args |
| `ReviveApi_balance` | exists | panics on bad args |
| `ReviveApi_block_author` | exists | returned a value |
| **`ReviveApi_account_id`** | exists | panics on bad args (official H160→AccountId mapping entry point) |
| **`ContractsApi_call`** | exists | panics on bad args → **ink!/WASM contract call path is live** |
| `AssetConversionApi` | present in runtime metadata | exact method names not yet resolved |

## 5. EVM compatibility — PASS (independent, read-only)

V3 executes Ethereum bytecode through **pallet-revive (Revm)**, exposed by an `eth-rpc` front-end.

Independent verification of two third-party live deployments (no writes by us):

| Item | Makhzan (`MohammedSoliman10/…-makhzan-soliman`) | Reachpot (`lazydevpro/reachpot`) |
|---|---|---|
| Contract | `0x60481DFcFCA34A8F095939D9675eC715127B2e44` | `0xcfcdb8ccac9b95534aedbbe9c90e49a6a1d493cf` |
| `eth_getCode` | returns full runtime bytecode (Solidity `via_ir` build) | returns full runtime bytecode |
| Deploy receipt (`0xf29a52c5…e3e7`) | `status: 0x1`, `contractAddress` = contract above, `blockNumber 0x29d2c` = 171,308, `gasUsed 0x39c6fe93bae3ac` = 16,262,870,374,998,956, `effectiveGasPrice 0x7f44` = 32,580, `type 0x2` | — |
| Claim receipt (`0x48a306f4…415b`) | `status 0x1`, `gasUsed 0x6dca727f6a` = 472,610,888,170, price `0x7ee0` = 32,480 | — |
| State-changing receipt (`0x44c41e75…09b1`) | `status 0x1`, `gasUsed 0x1436ab225079b` = 1,813,673,628,914,843, price `0x7ef4` = 32,500 | — |

Additional EVM facts: EIP-1559 typed transactions work (`type 0x2`, `maxFeePerGas 0x98b8` = 39,096, `maxPriorityFeePerGas 0x0`); `eth_getTransactionByHash` returns `chainId 0x190f1ca9`; `eth_logs` are **empty even for successful contract events** (Revive emits `ContractEmitted` as Substrate events, not as EVM logs) → indexers must read the Substrate event stream, not `eth_getLogs`.

### 5.1 Cost model (derived from real receipts)

With `1 tPOT = 1e18 EVM wei` (see §7):

| Action | gasUsed | price (wei) | cost (EVM wei) | cost (tPOT) |
|---|---|---|---|---|
| Contract **deployment** | 1.6263e16 | 32,580 | 5.2984e20 | **≈ 529.84 tPOT** |
| Storage-heavy contract call (`createDeal`) | 1.8137e15 | 32,500 | 5.8944e19 | ≈ 58.94 tPOT |
| Light contract call (`claim`, `resolve`) | 4.7261e11 | 32,480 | 1.5350e16 | ≈ 0.0153 tPOT |

The deploy figure is independently corroborated: Makhzan's recorded balance delta after deployment was 529.844316817465986480 tPOT, matching the receipt math to 6 significant figures. Deployment cost is dominated by the **code deposit** (Revive code-size limit ~10,240 B; Makhzan's 6,566 B runtime / 7,154 B creation fit under it).

**Engineering consequence:** one shared contract is affordable; **per-user contract deployment is not** (each deploy ≈ 530 tPOT, roughly one participant's entire test-token grant). Per-user state must live in a shared contract or in native pallets.

## 6. WASM / ink! compatibility — PASS for existence, BLOCKED for cross-composition

* `pallet_contracts` is present in the V3 runtime metadata (`Contracts`, `pallet_contracts`, `seal_call`, `seal_delegate_call`, `seal_random`, `seal_deposit_events`, `seal_terminate`) and the `ContractsApi_call` runtime API resolves → **ink!/WASM contracts are callable on V3**.
* `pallet_revive` is simultaneously present, with `PolkaVM` types and `allow_unlimited_contract_size` config tokens → the runtime can host **both** execution models; PolkaVM/RVM is configured but **not proven to run** (the one participant who probed `resolc` recorded "compiler probe only").
* Official guidance (Portaldot FAQ, updated 2026-10-07) states ink!↔Solidity synchronous composability is **"awaiting confirmation"** and that no cross-module account workflow (EVM ↔ contracts ↔ assets ↔ nfts) is documented. The official guide documents Solidity via `revive` only; `pallet-contracts` appears only as a runtime module, with no published ink! toolchain version.
* Local toolchain gap: `cargo`/`rustc` 1.99 present, but no `wasm32-unknown-unknown` target, no `cargo-contract`, no `ink!` CLI. A published ink! version compatible with this runtime is unknown.
* Verdict: **EVM = PASS. WASM = PASS for existence, BLOCKED as a primary target.** Build on Solidity/revive; treat ink! as optional.

## 7. Account-model finding (decisive, locally reproducible)

Portaldot V3 uses **two representations of one account**:

* native side: SS58 `AccountId32`, prefix 42, token **tPOT** with **14 decimals**;
* EVM side: H160 (20 bytes) with the same token denominated in **18 decimals** (1 tPOT = 1e18 EVM wei).

The mapping is **deterministic and offline-computable**:

```
native_account_bytes = H160 (20 bytes) ‖ 0xEE × 12      → SS58(prefix 42)
```

Verified locally (independent SS58 encoder, itself validated against `//Alice` = `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`):

| H160 | computed SS58 | published SS58 | result |
|---|---|---|---|
| `0xf7eC65d11e35375A250e474059a917B537804142` (official guide example) | `5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8Y` | same | **MATCH** |
| `0x60481DFcFCA34A8F095939D9675eC715127B2e44` (Makhzan contract, via Pindex) | `5EEwsqgiEVZNUdUHdmsEMqBQzJjNy5PULPBYoo5yF2GX45DZ` | same | **MATCH** |
| same, with suffix `0x00` / `0xEF` | — | — | no match (suffix is exactly `0xEE`) |

Consequences (all confirmed by official docs):
1. Funding an EVM identity means sending tPOT to the **mapped SS58**, not to a "raw" H160; the official guide and FAQ both state this.
2. The H160 derived from a seed on Portaldot **differs from the Ethereum/BSC H160** for the same seed (official guide) — users importing a MetaMask key land on a different address than on Ethereum.
3. If native tPOT is sent to an unmapped H160 representation, the official FAQ defines **no recovery procedure**.
4. The decimal discrepancy (14 vs 18) is a silent, 10⁴-scale financial bug class for any app that converts amounts.

## 8. Development support reality (Phase 3)

| Item | Finding |
|---|---|
| `@portaldot/sdk` on npm | **Does not exist** — `npm view @portaldot/sdk` → `npm error 404 Not Found` (registry search for `scope:portaldot` → 0 results) |
| npm packages mentioning portaldot | `portaldot-mcp` 0.1.1 (34 on-chain tools, community), `portaldot-pdk-ts` 0.2.0-alpha.7 (community TS companion to the Python `pdk`), `@fabianferno/portalflow-sdk` 0.1.0 (community), `portaldot-pns` 0.1.0 (community), `@potdrive/sdk` 0.1.0 (community). **All community-authored, none official.** |
| Official SDK | Python **`substrate-interface`** (per official docs: `pip install substrate-interface`, `SubstrateInterface(url="wss://…", ss58_format=42)`) + `scalecodec`; `substrate-interface` PyPI package is generic upstream. The Python package named `pdk` on PyPI is **unrelated** (`pdk.ocelerate.org`, "Python Developer's Kit", v0.95) |
| Official docs | `https://portaldot-dev.readthedocs.io` (mainnet-oriented: `wss://mainnet.portaldot.io`, POT 14 dp) and the **V3 testnet guide** `github.com/ItsCogumellum/portaldot-v3-testnet-guide` ("provided by the Portaldot team") + `FAQ.md` (dated 2026-10-07) |
| Solidity compiler | **`0.8.24`**, `evmVersion: cancun`, optimizer on/runs 200 — in the official Hardhat snippet and in a live participant's `foundry.toml`/`hardhat.config.js` |
| Deployment method (official) | Remix + MetaMask (injected) **or** Hardhat against `https://test-evm-rpc-v3.portaldot.dev` / chainId 420420777. Native-side path: `Revive.call` extrinsic after a dry-run for `weight_limit` + `storage_deposit_limit` |
| Foundry | **Not documented/tested officially** ("awaiting confirmation"), but used successfully in practice by participants (Foundry 1.8.5 + `forge build --sizes` + live deploy) |
| Transaction signing | Standard EVM: EIP-1559 typed tx (`type 0x2`), `eth_sendRawTransaction`; native side: `author_submitExtrinsic` with SCALE-encoded signed extrinsic |
| Dual-side interaction | Official guide §3.4: read state via EVM tooling **or** via `Developer → Runtime calls → reviveApi → call`; native dry-run then `Revive.call` extrinsic for writes |
| Mainnet docs vs V3 | The official readthedocs set describes **mainnet (spec 1002)**; V3 is spec **3002** and the FAQ explicitly warns mainnet/testnet configuration must not be conflated. A participant project (Plumbline) exists specifically to diff documented calls against the V3 runtime and has reported drift verdicts — treat mainnet docs as **non-authoritative for V3** |
| ERC-20/ERC-721 in `revive` vs native `assets`/`nfts` | **No automatic representation** (official FAQ) — a token minted natively is not an ERC-20 and vice-versa |
| `iBridge` (cross-chain) | Listed for V3.0, **launch status unconfirmed**; no supported networks, custody model, limits, or registration process published |

## 9. REST endpoints advertised in the brief ("world" / "asset")

**Not found.** Evidence:

* `portaldot.dev`, `docs.portaldot.dev`, `faucet.portaldot.dev`, `explorer.portaldot.dev`, `api.portaldot.dev`, `world.portaldot.dev`, `assets.portaldot.dev`, `testnet.portaldot.dev`, `api-v3.portaldot.dev`, `indexer.portaldot.dev`, `world-api.portaldot.dev` → **NXDOMAIN** (`Could not resolve host`).
* `portaldot.io` apex → NXDOMAIN; `www.portaldot.io` → static SPA (no API hosts in its JS bundles; only marketing/polkadot.js content).
* `node-console.portaldot.dev` → SPA fallback for every path; **no REST API**.
* The only unauthenticated JSON REST surface found is the **community** PortalIndex/Pindex API (§3.4).

Consequence: any product needing a world/asset REST API must either self-host the indexer (free tier) or read the chain directly. No such endpoint may be assumed.

## 10. Testnet funding model (official)

* Funding is **manual, admin-distributed**: participants submit their **native SS58 address (starting with `5`)** at registration, or open a Discord support ticket; admins distribute the first batch (announcements reference DoraHacks admin `@Stella707827` and Discord `@titus242471`). A further round was promised.
* ⚠️ **There is no public faucet.** The only "Faucet Interface" found (`Investorquab/portaldot-playground`) is a community UI with no backend endpoint and stale RPC URLs (`testnet-rpc.portaldot.io` — NXDOMAIN).
* ⚠️ **EVM addresses cannot be funded directly** per the official announcement ("send your native POT address (starting with 5), not an EVM address (starting with 0x)"); funding reaches an EVM identity only through the mapped SS58 (§7).
* Test token symbol is reported two ways: `tPOT` (live `system_properties`) and `tPOTv3` (official guide + MetaMask config). Treat `tPOT` as the on-chain symbol.
* Scale of a grant: one participant held ≈ 729 tPOT before paying a 529.84 tPOT deploy → grants appear to be order 10²–10³ tPOT. **Exact grant size is unconfirmed.**
* Gas is paid in tPOT; the native side additionally charges **storage deposits** for new state (dry-run first, per official guide).

## 11. Competition snapshot (public evidence, 2026-10-25)

54 builds / 174 hackers registered on DoraHacks (public build list is behind organizer review, so the list below is from public GitHub repos + DoraHacks pages).

| Space | Public projects found | Nature |
|---|---|---|
| Storage | **PotDrive** (`TransactionStorage` + FastCDC + IPFS CIDs, live), **Makhzan** (bonded challenge-verified storage, live EVM contract, full evidence bundle) | crowded, both strong |
| Metered API payment | **PortalMeter** (HTTP 402 + EIP-712 payment channels), `pot-402-gateway`, `pot-api-gateway` | crowded |
| Escrow / grants / campaigns | **DotGrants** (ink! micro-grants), **Bondot** (agent escrow + verifier), **Reachpot** (pro-rata creator campaigns, live V3 contract + soulbound badges), **Portion** (revenue-share ownership of productive equipment, live core contract, 56-task backlog) | crowded |
| Custody / security | **Ballast** (Assets+Multisig reserve circuit breaker, 79 live V3 extrinsics), **Airlock** (time-locked hot-key vault), **Forklift** (pinned live-chain fork verification) | crowded |
| Naming / identity | **Portal Naming Service** (`.pot`, ink!, community SDKs on npm) | adjacent |
| Tooling / verification | **Plumbline** (docs-vs-runtime conformance checker, 263 tests, live), **NodePulse**, **Developer Playground**, `pdk`/FailLens (fail-decoder), **PotDo** (NL→tx copilot), Hermes | crowded |
| Health / monitoring | **nodepulse** (hackathon prototype) | thin |

No public project addresses the **H160↔SS58 account/amount model** itself (funding-side safety, deterministic mapping, 14↔18 dp normalization, cross-representation payment routing). The official FAQ names this as the chain's unresolved UX. That is the gap selected in `docs/decisions/001-product-lock.md`.

## 12. Unresolved risks carried into the build phase

1. **Exact grant size unknown** → if a grant is < ~600 tPOT, no EVM deployment is affordable; a pallet-only fallback (`assets` + `transactionStorage` + `multisig`) must be ready. *Next action: request funding and measure.*
2. **18-dp EVM vs 14-dp native is derived, not documented** → must be re-proved empirically (compare one mapped account's `eth_getBalance` against its native `System.Account` free balance). Derivation chain: receipt `gasUsed × effectiveGasPrice` = 5.2984e20 wei for a measured 529.844316817465986480 tPOT ⇒ 1e18 wei/tPOT; corroborated by Makhzan's `min bond 1e15 units = 1e19 wei = 10 tPOT`.
3. **Explorer has no deep links** → receipts must be linked as raw tx hashes plus a self-hosted receipt page.
4. **No public faucet** → onboarding of external test users depends on admin distribution; the product must therefore include a funding-side readiness check rather than a faucet.
5. **Mainnet docs describe spec 1002, not V3 spec 3002** → every runtime call used must be validated against V3 metadata before relying on it.
6. **ink! toolchain version unknown** → do not make WASM a dependency.
7. **Pindex is community-run on a free tier** → optional convenience only, never a hard dependency.
8. **`eth_getLogs` returns empty for Revive contract events** → any indexer must consume Substrate events (`Contracts`/`Revive` `ContractEmitted`) instead.

## 13. Reproduction commands (read-only)

```powershell
# DNS
Resolve-DnsName test-evm-rpc-v3.portaldot.dev
# EVM RPC
curl.exe -sS -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' https://test-evm-rpc-v3.portaldot.dev
curl.exe -sS -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":2}' https://test-evm-rpc-v3.portaldot.dev
curl.exe -sS -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",true],"id":3}' https://test-evm-rpc-v3.portaldot.dev
# Receipt of a known live deployment
curl.exe -sS -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_getTransactionReceipt","params":["0xf29a52c507726ceed20861f2cc4cc5f937542d0caa42a7e2a369ea08c998e3e7"],"id":4}' https://test-evm-rpc-v3.portaldot.dev
# Native WS (Node global WebSocket): system_chain, system_properties, state_getMetadata, rpc_methods, state_call("ReviveApi_account_id", …)
node -e "const ws=new WebSocket('wss://test-node-v3.portaldot.dev'); …"
# Mapping check (H160 -> SS58 with 0xEE x 12 suffix)
node "C:\Users\pc\AppData\Local\Temp\opencode\pd_mapping.js"
```

## 14. Files created by this mission

* `docs/PORTALDOT_PREFLIGHT.md` (this file)
* `docs/decisions/001-product-lock.md`

No application code, package manifest, lockfile, or configuration was created. Temporary probe scripts live only in `%TEMP%\opencode` and are not part of the project.
