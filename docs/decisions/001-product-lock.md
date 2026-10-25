# ADR 001 — Product lock: PotLink (payment links & verified receipts for Portaldot V3)

**Status:** Proposed for technical review (no implementation started) · **Date:** 2026-10-25 · **Deciders:** Mahit (product), ChatGPT (review), Codex (execution)
**Evidence base:** `docs/PORTALDOT_PREFLIGHT.md` (all claims below are cited to it) · **Hacker House:** Portaldot Hacker House 2026 on DoraHacks — code freeze **2026-11-06 04:00 UTC**, demo day Nov 8–9, winners Nov 11. 12 days remain.

---

## 1. Decision

**Ship PotLink: merchant payment links and verified payment receipts for Portaldot V3, made safe across the chain's dual account model.**

PotLink gives any Portaldot participant a *verifiable payment identity* (their H160 + their deterministic SS58 + a human label) and lets them issue a **payment link** that a payer can settle **from an EVM wallet (MetaMask) or a native account**, with:

1. a **pre-flight readiness check** (which side is funded, is the amount correct in both decimal systems),
2. an **on-chain payment intent** in one shared Solidity contract on `pallet-revive` (payer → payee → receipt → expiry/dispute window),
3. a **dual-side receipt** readable from EVM *and* from the native Substrate side, so a native-only recipient can verify without an EVM wallet.

**Why this and nothing else:** it is the only product space I found that is simultaneously (a) unoccupied in 54 public builds, (b) demanded by the chain's own official FAQ, and (c) buildable in 12 days at zero cost with one shared contract and no backend. It is not the flashiest idea; it is the one that survives the "usable beyond the hackathon demo" test.

**Target track:** Ecosystem DApps (primary — consumer-facing payment flow, three prize slots) / Modular Cloud & Middleware (secondary — payment rail + SDK). Not Node Operations, not Multi-Chain (see §6).

---

## 2. Constraints that drove the decision (all measured, not assumed)

| Constraint | Value | Design consequence |
|---|---|---|
| Contract deployment cost | **≈ 529.84 tPOT** (code-deposit dominated; ~10,240 B code limit) | **One shared contract, ever.** No per-user or per-merchant deploys. Per-user state = shared contract or native pallets. |
| Light contract call | ≈ 0.0153 tPOT | Payment intents are economically fine at scale. |
| Storage-heavy call | ≈ 58.94 tPOT | Keep per-intent storage small; avoid per-payment new storage roots where possible. |
| Token decimals | native **14 dp** / EVM **18 dp** for the same tPOT | Amounts must be converted at the edge, once, with a unit-tested library. |
| Account model | H160 ↔ SS58 is deterministic (`H160 ‖ 0xEE×12`) but **not understood by users**; H160 differs from Ethereum for the same seed; wrong-side transfers have **no recovery path** (official FAQ) | The mapping, the funding side and the decimal conversion are *the product*, not plumbing. |
| Funding | Manual admin distribution to a **native SS58** address; **no faucet**; EVM addresses not directly fundable | Onboarding must verify the funded side before any EVM action. Do not build a faucet. |
| Explorer | node-console is an SPA with **no REST API and no deep links**; `eth_getLogs` is empty for Revive events | Ship our own receipt page; link raw tx hashes + Pindex address route as a convenience. |
| Docs | Official readthedocs set targets **mainnet spec 1002**; V3 is **spec 3002** | Every runtime call used must be validated against V3 metadata first. |
| Capability envelope | Solidity/revive = proven; ink!/WASM = exists but toolchain unknown; cross-composition unverified; iBridge unconfirmed | Build Solidity-only. Native pallets for optional mirroring. No bridge, no ink! dependency. |

---

## 3. Product definition

### 3.1 User and painful recurring problem

**Primary user:** a merchant / freelancer / creator in the Portaldot ecosystem who has been sent tPOT (native SS58) during the hackathon grant and now needs to *be paid by people holding EVM-wallet funds*; secondarily, a dApp integrator who must resolve payee addresses for users.

**Recurring pain (every single payment):**
1. Which address do I give the payer? My MetaMask H160 and my native SS58 are different strings, and the *same seed* yields a different H160 on Portaldot than on Ethereum — so an address copied from elsewhere is wrong.
2. Which side holds the money? Funding lands on the mapped SS58; an EVM-side payment to an unmapped address is unrecoverable per the official FAQ.
3. How many units? The same token is 14 dp natively and 18 dp in EVM wei; a 10⁴ error is silent.
4. Was I paid? No explorer deep link, no EVM logs for Revive events, so receipts are manual.

### 3.2 User journey (happy path)

1. **Merchant** opens PotLink, connects an EVM wallet (or enters an SS58). PotLink computes the *other* representation deterministically and shows both, with the mapped SS58 copyable and a QR.
2. Merchant creates a **payment link** for an amount (entered in human tPOT) → PotLink normalizes to EVM wei and to native units, converts the amount into a `PaymentIntent` and signs it into the **shared contract** (one tx, ≈ 0.02–0.6 tPOT).
3. **Payer** opens the link in MetaMask. PotLink runs the **readiness check**: payer balance, payee mapped SS58, payee's native balance, amount in both decimals, contract state, expiry. If the payer's EVM side is funded but the payee's mapped account is not, the link says so *before* any value moves.
4. Payer pays → the contract escrows/records the payment and emits `PaymentPaid`; PotLink writes a **native-side receipt commitment** via the `TransactionStorage` pallet (and optionally a `nfts` receipt badge) so the native-only merchant can verify without MetaMask.
5. **Merchant** sees the receipt in PotLink (and in the native wallet view): intent id, amounts in both decimals, payer, payee, block, tx hash, expiry. Unclaimed/expired intents can be cancelled by the payee or refunded after the window.

### 3.3 Acceptance criteria for the first end-to-end vertical slice (all verifiable, no mock)

- [ ] `PaymentIntent` created on **Portaldot V3** (chainId 420420777) — tx hash + block + contract address recorded in the repo (`deployments/`), code size reported by `forge build --sizes` ≤ 10,240 B.
- [ ] Intent read back independently by a third party with plain `eth_call` (no PotLink code involved).
- [ ] Payment executed; `eth_getTransactionReceipt` shows `status 0x1` and the contract address.
- [ ] Receipt verifiable from the **native side** (runtime read of the same contract through the Revive read path, plus the `TransactionStorage` commitment) — demonstrated by a second, native-only client run.
- [ ] Decimal correctness proved on-chain: the same mapped account's EVM balance equals its native balance × 10⁴ (re-derive and pin this in a test with a live account).
- [ ] Mapping correctness proved against two published on-chain pairs (official guide example + Pindex example).
- [ ] Failure case: link opened with an unfunded EVM side → readiness check blocks with a specific message, no transaction attempted.
- [ ] Public repo, README with reproducible commands, ≤3-minute demo video, pitch deck, live deployment details.

---

## 4. Proposed architecture

### 4.1 Shape (zero backend)

```
Browser (static SPA) ──HTTP──▶ https://test-evm-rpc-v3.portaldot.dev   (eth_sendRawTransaction, eth_call, receipts)
        │                      https://test-node-v3.portaldot.dev        (wss: Revive/TransactionStorage reads, native receipts)
        └── unit + mapping library (pure TS, no server, no key custody) ──▶ shared Solidity contract (pallet-revive)
                                                                              native pallets: TransactionStorage, nfts (optional)
```

* **Frontend:** static SPA (React + Vite), hosted on a free tier (Cloudflare Pages / Vercel / GitHub Pages). Routes: `/` (merchant home), `/p/:intentId` (pay page), `/r/:intentId` (receipt page), `/verify` (mapping + unit normalizer demo), `/settings` (network + identity).
* **Library (`@potlink/core`, our own):** `h160ToSs58()` / `ss58ToH160()` (deterministic `0xEE×12` rule), `toEvmWei()` / `toNativeUnits()` (18 ↔ 14 dp), `readinessCheck()` (balances + mapped account + contract state), intent codec, receipt builder. Pure functions, unit-tested, usable by any other builder — this is the ecosystem-contribution surface.
* **Contract (`PotLinkPayments`, Solidity 0.8.24, optimizer 200, evmVersion cancun):** one shared contract, target runtime ≤ ~8 KB to keep the ~530 tPOT deposit bounded.
* **Native mirror:** app writes the receipt hash to `TransactionStorage` (cheap, chain-native) and optionally mints an `nfts` receipt badge for the merchant (soulbound-style), so a native-only user has proof without an EVM wallet.
* **No backend, no accounts, no key custody.** Signing happens in the browser (MetaMask / injected EVM wallet). Native-side writes (if used) are signed by the user's native wallet extension, or omitted entirely in v1.

### 4.2 Contract responsibilities, permissions, state transitions

```
PaymentIntent {
  id, payer: address, payee: address, amountWei: uint128,   // EVM-denominated, 18 dp
  amountNative: uint128,                                    // native-denominated, 14 dp (mirror)
  payeeSs58Hash: bytes32,                                   // commitment to the mapped native account
  createdAt: uint64, expiresAt: uint64, status: uint8,     // 0 open, 1 paid, 2 claimed, 3 refunded, 4 expired
  receiptId: bytes32
}
```

| Actor | Allowed transitions | Guard |
|---|---|---|
| anyone (merchant) | create intent | amount > 0, expiresAt > now, payee != 0, code-size and event limits respected |
| payer | `pay(intentId)` | msg.sender == intent.payer, status == open, not expired; value recorded and forwarded to payee |
| payee | `claim(intentId)` | status == paid, msg.sender == payee |
| payee (or anyone after window) | `refund(intentId)` | status == paid && now > claimDeadline, or status == open && now > expiresAt |
| nobody | mutate amount / payer / payee after creation | fields immutable after create |

* **No admin/owner key. No upgradeability. No custody beyond the escrow window.** A `Sudo`/Root key exists on the V3 testnet (observed by a participant) and can override anything on-chain — so our contract must not assume admin safety on testnet; it assumes *none*.
* **Storage cost discipline:** the contract stores an intent per link; if storage deposit cost becomes material (>1 tPOT), intents expire and their slots are reused rather than growing unboundedly. (Exact deposit behaviour must be measured — see §9.)

### 4.3 Native-side receipts

`TransactionStorage` commitment per paid intent: `(intentId, amountWei, amountNative, payer, payee, blockNumber, txHashHash)` hashed and stored on-chain, plus an `nfts` receipt badge for the merchant if the badge flow proves cheap. Both are read via the native RPC, so a native-only user can prove receipt without ever touching the EVM side — this is the "dual execution" story the V3 brief highlights.

---

## 5. Alternatives considered (Phase 4 evaluation)

Six criteria per the mission: (1) real user + recurring pain, (2) competitive overlap, (3) genuine Portaldot V3 benefit, (4) dependency risk on unavailable/undocumented APIs, (5) shippable before deadline at zero cost, (6) security / adoption / ops cost / failure behaviour.

### A. PortalLease-style equipment lease & revenue-share
1. **User:** real — small-asset operators (machines, cameras, vehicles) who rent out productive assets and split revenue. Painful and recurring.
2. **Overlap: severe.** **Portion** (`Nailer/portion`) already ships a live V3 core contract implementing ownership shares in productive equipment, revenue deposits, default slashing, a funding/protection model, a 56-task backlog and public evidence — same problem, same chain, same window.
3. **V3 benefit:** moderate (shared contract + native `assets`); not differentiating.
4. **Dependencies:** no exotic API needed, but the product depends on off-chain reality (logistics, operators, payments) that cannot be verified on-chain or in a demo.
5. **Shippability: poor.** Each merchant-side contract deployment ≈ 530 tPOT (unaffordable per merchant); RWA onboarding, dispute handling and operator ops do not fit 12 days or ₹0.
6. **Security/ops:** slashing + revenue escrow invite custody, oracle and dispute complexity; a failed demo leaves real money semantics unproven.
**Verdict: rejected** — differentiated only by naming, and beaten on execution by an existing submission.

### B. Rebound-style delivery-failure recovery (escrow refund/slash on failed service)
1. **User:** plausible (services that fail and need refunds), but the "recurring, painful" part is weak without a specific vertical.
2. **Overlap: severe.** **Bondot** (agent escrow + verifier + settlement on fail) and **Makhzan** (bonded challenge + 20% slash + claim/settle) already implement failure-driven settlement on V3; **Ballast**/**Airlock** cover guardian thresholds and vetoes.
3. **V3 benefit:** moderate; no unique use of dual execution.
4. **Dependencies:** dispute-resolution roles, oracle assumptions about "failure" → hard to make non-arbitrary.
5. **Shippability:** a generic escrow with a slash is a weekend project with no differentiator — it would score low on Innovation (30%).
6. **Security/ops:** slashing disputes and off-chain arbitration are exactly the operational cost we cannot fund.
**Verdict: rejected** — "Rebound" as a refund rail is a feature of an escrow product, not a product.

### C. Cross-chain bridge / multi-chain liquidity engine (Track 2)
1. **User:** real in general, but on V3 there is no proven counterparty network.
2. **Overlap:** Forklift (pinned live-chain fork verification) touches chain replication; a bridge would be novel but has no live counterparties.
3. **V3 benefit:** would use iBridge — which the official FAQ lists as **launch status unconfirmed** (no networks, custody model, limits, or registration process published).
4. **Dependencies: fatal** — the core dependency is unverified/unlaunched; the mission forbids betting the product on unavailable integrations.
5. **Shippability:** impossible to verify end-to-end without a counterparty chain.
6. **Security/ops:** bridge risk is the highest-severity category and needs audits we cannot buy.
**Verdict: rejected** — blocked on an unverified dependency.

### D. Docs/runtime conformance checker
1. **User:** builders — real but episodic.
2. **Overlap: total.** **Plumbline** ships exactly this (263 tests, live, V3 spec 3002 vs mainnet spec 1002 diff, canary transactions).
3–6. **Verdict: rejected** — cannot beat an existing, well-evidenced submission in 12 days.

### E. Faucet / onboarding tap (standalone)
1. **User:** every new participant — real and acute (no faucet exists).
2. **Overlap:** low, but the *problem* is owned by the organizers (manual distribution) and by our own build's readiness check.
3. **V3 benefit:** weak.
4. **Dependencies:** a faucet needs a sponsor account with tPOT and a mechanism (meta-tx) whose availability on V3 is not officially documented; our own grant (order 10²–10³ tPOT) cannot fund other people's usage — the same grant must pay our ~530 tPOT deploy.
5–6. **Shippability/ops:** cannot be sustained; would burn the project's only funds.
**Verdict: rejected as a product; retained as a feature** (readiness check + explicit "how to get funded" guidance inside PotLink).

### F. Storage / metering / campaigns / naming (spot-checks)
* **Storage:** PotDrive + Makhzan → rejected.
* **Metered API payment:** PortalMeter + two 402 gateways → rejected.
* **Campaigns/grants:** Reachpot, DotGrants, Bondot → rejected.
* **Naming:** Portal Naming Service → **partially adjacent**; PotLink is *not* a namespace (see §7 differentiation), and PNS ships ink!-based names on a non-EVM chain with no payment lifecycle, no dual-side amounts, no funding-safety checks.

### G. PotLink (chosen)
1. **User:** merchants and integrators on Portaldot; recurring per payment. Pain evidenced by the official FAQ (mapping, funding side, recovery, wallet support) — not invented.
2. **Overlap:** none found in 54 builds; adjacent only to PNS (naming), and PotLink's core is the payment lifecycle + safety, not names.
3. **V3 benefit:** genuinely uses the headline V3 features — **dual execution** (Solidity contract + native `TransactionStorage`/`nfts` receipt readable from the Substrate side), the **revive H160↔SS58 mapping**, and **native asset modules** — exactly what the brief asks projects to demonstrate.
4. **Dependencies:** only `eth_*` RPC + the native WS + one shared contract. No faucet, no bridge, no indexer dependency, no unpublished API. `ReviveApi_account_id` exists as a fallback cross-check, but the primary mapping is a pure function.
5. **Shippability:** yes — 1 contract, 1 library, 1 static SPA, no backend, no keys to custody, ~12 days.
6. **Security/ops:** no admin key, no upgradeability, bounded escrow window, no custody beyond the window; failure modes are "link invalid / expired / unfunded", all detected before any value moves. Operational cost ≈ ₹0 (static hosting + public RPC).

---

## 6. Strategic notes for positioning

* The public build list is behind organizer review; 54 builds / 174 hackers exist. Differentiation must be *visible in 10 seconds* of the demo → open on a **real V3 payment link settled in MetaMask, with the native-side receipt shown from a second wallet**.
* Ecosystem DApps has 1st/2nd/3rd prize slots (800/500/300 USDT) while other tracks have one 800 slot; a consumer-facing payment product fits Ecosystem DApps, and the middleware/API angle is a credible second track.
* Required artefacts must be produced early, not at the end: public repo + ≥3 commits, contract address + tx hash + explorer link, ≤3-min demo video, pitch deck, runnable demo.

---

## 7. Differentiation statement (one paragraph, reusable in the pitch)

> Most Portaldot tools assume you already know which address to use, which side holds your money, and how many decimals the number has. PotLink is the payment layer that makes those three things explicit and verifiable: one deterministic identity (H160 ⇄ SS58), one amount model (18-dp EVM ⇄ 14-dp native), and one receipt that both sides of the chain can independently verify — with a readiness check that refuses to move money when the funded side, the decimal conversion or the recipient mapping is wrong.

---

## 8. Threat model and failure behaviour

| Threat | Mitigation |
|---|---|
| Payer sends to the wrong representation (EVM vs native) | Readiness check compares both representations and the funded side before the payer signs; the contract records the payee's *mapped* SS58 commitment; the UI never shows a bare H160 without its SS58 twin. |
| Decimal confusion (10⁴ error) | Single conversion module, integer-only, unit-tested against live balances; the intent stores both amounts and they must agree (asserted at creation). |
| Wrong amount in a link (tampered link) | Amount and payee live in the on-chain intent; the UI renders from chain state, never from the URL. The URL carries only the intent id. |
| Intent hijack / front-running of a link | Creating an intent is permissionless but the payee field is immutable; paying is bound to `intent.payer`; an attacker cannot redirect funds. |
| Expiry / stale links | `expiresAt` checked at pay time; expired intents are refundable by the payee and self-close. |
| Testnet Root (`Sudo`) can rewrite anything | Contract has no admin; all guarantees are stated as *testnet* guarantees, and the pitch says so explicitly. |
| Explorer shows nothing (no deep links, empty `eth_getLogs`) | Our own receipt page renders from the chain + tx hash; Pindex is a convenience link only; native receipt is independently verifiable. |
| PortalIndex (community indexer) disappears | Not in the critical path; everything reads from the chain. |
| Insufficient funds for a 530 tPOT deploy | Pallet-only fallback plan B (see §9); if no deploy is affordable, the vertical slice ships on `assets` + `transactionStorage` + `multisig`. |

---

## 9. Testing, deployment, rollback, observability

* **Unit tests:** mapping (against the two published pairs + `//Alice` reference), decimal conversions (property tests both directions, boundary values), receipt codec, intent state machine.
* **Integration tests (local):** Foundry `forge test` against anvil for contract logic; a mock of the mapping/unit library used by the SPA.
* **Live tests (V3):** read-only pre-flight suite (chain id, block time, mapping, balances) + the scripted happy path + the funded/unfunded negative cases. Every live run records tx hash, block, receipt JSON and contract address into `evidence/`.
* **Deployment:** `forge build --sizes` → check ≤ 10,240 B → deploy with a **single funded key** → record address + tx hash immediately. Rollback = the contract is immutable and permissionless; a bad version is superseded by a new contract, with the old one left inert (no migration path in v1 → no upgrade risk).
* **Observability:** all state read live from chain; a `/verify` page and a `scripts/preflight.mjs` that fails loudly on chain drift (spec version, mapping rule, decimals, code size); receipts include raw tx hash so any third party can re-derive the outcome.
* **Budget:** ₹0 — static hosting free tier, public RPC, no backend, no monitoring SaaS. Test tokens are the only cost, and they are free (grant).

---

## 10. Proven / assumed / blocked

**Proven by direct observation (read-only, this machine):** chain ID 420420777; EVM RPC live with full `eth_*` surface incl. receipts; native WS live with 135 methods; `revive` (Revm) execution with third-party live contracts and receipts; `pallet_contracts` + `ContractsApi_call` present; `ReviveApi_call`/`eth_transact`/`account_id`/`balance` present; native pallets (assets, nfts, uniques, transactionStorage, multisig, …); deterministic H160→SS58 mapping; deploy ≈ 529.84 tPOT, light call ≈ 0.0153 tPOT; tPOT 14 dp native / 18 dp EVM; funding is manual to a native SS58, no faucet; explorer has no REST API or deep links; 54 builds / 174 hackers; @portaldot/sdk does not exist; official Solidity path = Hardhat/Remix, solc 0.8.24, cancun.

**Assumed (must be validated in the build phase, cheaply):** grant size ≥ ~600 tPOT; storage-deposit cost per intent is small; `eth_estimateGas` behaves for our call shapes; `nfts` badge flow is cheap and permissionless; EIP-1559 with `maxPriorityFeePerGas 0` is accepted by wallets on this chain; the deployed contract stays under the code-size limit with optimizer settings.

**Blocked / explicitly out of scope:** public faucet (no endpoint, no authority), official explorer deep links (none published), mainnet parity (docs describe spec 1002, V3 is 3002), ink! as a primary target (toolchain version unknown), cross-module atomicity between ink! and Solidity (undocumented), ERC-20 ↔ native asset equivalence (explicitly absent), any cross-chain/iBridge feature (unconfirmed), meta-tx/gasless sponsorship (undocumented on V3).

---

## 11. Exact next actions (in order)

1. **Request testnet tPOT** for our native SS58 address (Discord ticket per the official announcement) and, in the same message, ask for the grant size. *This gates the EVM deploy path.*
2. Generate our identity keypair offline; derive the mapped SS58 and H160; verify the mapping rule against the two published pairs in a script (no secrets printed).
3. Re-prove the 18-dp/14-dp conversion empirically on the funded account (compare `eth_getBalance` with the native free balance) and pin it in a test.
4. Prototype the contract on anvil (`forge init`, `forge test`), keep runtime ≤ 8 KB, then dry-run `eth_estimateGas` against V3.
5. Deploy once to V3; record address + tx hash; wire the SPA read path; run the happy path end-to-end (link → pay → receipt) and the unfunded negative case.
6. Write the native-side receipt mirror (`transactionStorage`) and verify it from a native-only client.
7. Produce the required artefacts (README, deployment info, ≤3-min video, pitch deck) from day one, not at the end.

---

## 12. Non-goals (v1)

No custody beyond the escrow window; no admin/upgrade keys; no bridge; no ink!; no token issuance; no fiat; no per-user contracts; no custodial merchant accounts; no dependency on Pindex or any third-party indexer; no claims of mainnet readiness.
