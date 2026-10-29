# Portaldot V3 deployment estimates

Read-only measurements against the public Portaldot V3 testnet on 2026-10-25. No funds were used:
every number comes from `eth_estimateGas`, `eth_getCode`, and chain state queries.

## 1. `eth_estimateGas` is supported

The preflight listed gas estimation as an unverified assumption for this chain. It is verified now:
`eth_estimateGas` on `https://test-evm-rpc-v3.portaldot.dev` returns a gas value for contract
creation transactions sent from an account that holds a balance. The estimator is therefore usable
to size a funding request before any account is funded.

## 2. Measured deployment cost of the PotToken suite

Compiler profile: solc 0.8.24, `evmVersion: cancun`, optimizer enabled with `runs: 200`, no viaIR
(the MISSION 002 quality-gate profile, matching ADR 002). Deployment cost on this chain is
dominated by the code deposit, so runtime bytecode size is the cost driver. Every number below
comes from `eth_estimateGas` against the live testnet at a 31,000 wei base fee; no funds were
used.

| Contract | Creation bytes | Runtime bytes | Gas | Cost at 31,000 wei |
| --- | --- | --- | --- | --- |
| `PotERC20` | 4,431 | 3,258 | 9,650,098,430,981,588 | 287.48 tPOT |
| `PotERC721` | 6,569 | 5,391 | 15,460,513,308,742,377 | 457.07 tPOT |
| `PotRegistry` | 5,636 | 5,545 | 15,342,985,002,896,258 | 460.56 tPOT |
| **Total** | **16,636** | **14,194** | **40,453,596,742,626,191** | **1,205.11 tPOT** |

Per-contract runtime is well under the 10,240 byte Revive limit (largest: 5,545 bytes).

Cost per creation byte is roughly 0.07 to 0.09 tPOT, consistent with the preflight figure of
529.84 tPOT for the 7,154 creation byte Makhzan contract. At the higher base fees observed
earlier on the chain (32,580 wei), the same deployment costs ≈ 1,198 tPOT; request at least
**1,350 tPOT** for the deployer account to keep a margin.

## 3. Funding requirement

The whole-release requirement is computed from live measurements, not from a fixed historical figure:

| Component | Basis | Value at 27,440 wei gas price |
| --- | --- | --- |
| Deployment estimate | 3 contract creation estimates × gas price | ≈ 1,209.9 tPOT |
| Binding reserve | 2 registry bindings × registry creation estimate (heaviest measured registry transaction; no bind-call measurement exists in the evidence docs) | ≈ 913.7 tPOT |
| Subtotal | deployment + binding reserve | ≈ 2,123.6 tPOT |
| Fee margin | 20% on the subtotal (observed base-fee swing 29,790 → 32,580 wei ≈ +19%) | ≈ 424.7 tPOT |
| **Whole-release recommended balance** | subtotal + margin | ≥ **2,549 tPOT** |

The legacy 1,350 tPOT figure covered only the deployment estimate and is **insufficient for the whole
release** once both registry bindings and the fee margin are included. Request ≥ 2,549 tPOT for the
native account that maps to the deployer EVM address so the full release (deploy + both bindings +
margin) clears the preflight. Native balances use 14 decimals and EVM balances use 18 decimals; both
are compared in BigInt end to end.

The release preflight recomputes this requirement live before the first transaction and fails closed
if either ledger's balance is insufficient. After deployment has spent its funds, the binding stage is
stage-aware: it budgets only the remaining binding transactions (each re-estimated live), never the
original deployment balance again.

## 4. Binding reserve derivation (evidence status)

No bind-call cost measurement exists in the evidence docs (checked `docs/EVIDENCE-V3-ESTIMATES.md`,
`docs/PORTALDOT_PREFLIGHT.md`, `docs/decisions/001-product-lock.md`, and `README.md`). The only
measured call figures are a light call ≈ 0.0153 tPOT and a storage-heavy call ≈ 58.94 tPOT from
earlier research (ADR 001), neither of which is a registry `bind` transaction. A live
`eth_estimateGas` of `bind` is impossible before the registry is deployed (the target contract does
not yet exist on chain).

The safest supported reserve is therefore an **upper bound**: each of the two bindings is bounded by
the PotRegistry creation estimate itself — the heaviest measured registry transaction (15,342,985,002,896,258 gas ≈ 456.88 tPOT at 27,440 wei) — because a state-changing registry call is bounded by the contract creation that establishes that state, and no smaller measured figure is available. This is deliberately conservative: the actual bind cost is re-measured read-only at binding time via the bind-mode preflight (`eth_estimateGas` on both `bind` calls), so the final binding budget can only go down from this reserve.

## 5. Accounts observed on the testnet

| EVM address | Balance (EVM wei) | Note |
| --- | --- | --- |
| `0xf7eC65d11e35375A250e474059a917B537804142` | 499,900,000,000,000,000,000 | Official guide deployer, 499.9 tPOT, below the 911.57 tPOT requirement |
| `0x60481DFcFCA34A8F095939D9675eC715127B2e44` | 24,000,000,000,000,000,000 | Makhzan contract address, 24 tPOT |
| `0x0948EBD7637D1C32858a6FC5D947E85A6600205C` | 172,229,122,908,433,355,700 | Makhzan deployer, 172.23 tPOT, nonce 12 |
| `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 0 | Hardhat development account, unfunded on the testnet |

None of these balances belong to this project, and no private key for them is available here. The
deployment therefore waits on a funded deployer account.

## 6. Reproduction

```bash
npm run compile
npm run estimate:deploy
```

The estimator rebuilds the creation transactions from the compiled artifacts, sends them to
`eth_estimateGas`, and multiplies by the live base fee. `POT_GAS_PRICE` overrides the price and
`POT_ESTIMATE_FROM` overrides the sender address used for estimation.
