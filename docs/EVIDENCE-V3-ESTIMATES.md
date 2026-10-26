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

Request at least **1,350 tPOT** for the native account that maps to the deployer EVM address, so the
suite deploys with a margin at the current base fee. The base fee is not fixed: it was 32,580 wei
earlier in the chain history and 29,790 wei at the time of the last measurement, so a larger buffer
is wise if the price moves.

The grant has to reach the **native** account that corresponds to the EVM key. For an EVM address
the native account is the 20-byte H160 followed by twelve `0xEE` bytes, encoded as SS58 with prefix
42, and the deployer needs at least 1,350 tPOT there before the EVM side sees the balance.

## 4. Accounts observed on the testnet

| EVM address | Balance (EVM wei) | Note |
| --- | --- | --- |
| `0xf7eC65d11e35375A250e474059a917B537804142` | 499,900,000,000,000,000,000 | Official guide deployer, 499.9 tPOT, below the 911.57 tPOT requirement |
| `0x60481DFcFCA34A8F095939D9675eC715127B2e44` | 24,000,000,000,000,000,000 | Makhzan contract address, 24 tPOT |
| `0x0948EBD7637D1C32858a6FC5D947E85A6600205C` | 172,229,122,908,433,355,700 | Makhzan deployer, 172.23 tPOT, nonce 12 |
| `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 0 | Hardhat development account, unfunded on the testnet |

None of these balances belong to this project, and no private key for them is available here. The
deployment therefore waits on a funded deployer account.

## 5. Reproduction

```bash
npm run compile
npm run estimate:deploy
```

The estimator rebuilds the creation transactions from the compiled artifacts, sends them to
`eth_estimateGas`, and multiplies by the live base fee. `POT_GAS_PRICE` overrides the price and
`POT_ESTIMATE_FROM` overrides the sender address used for estimation.
