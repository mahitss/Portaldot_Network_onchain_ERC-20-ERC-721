# Portaldot V3 deployment estimates

Read-only measurements against the public Portaldot V3 testnet on 2026-10-25. No funds were used:
every number comes from `eth_estimateGas`, `eth_getCode`, and chain state queries.

## 1. `eth_estimateGas` is supported

The preflight listed gas estimation as an unverified assumption for this chain. It is verified now:
`eth_estimateGas` on `https://test-evm-rpc-v3.portaldot.dev` returns a gas value for contract
creation transactions sent from an account that holds a balance. The estimator is therefore usable
to size a funding request before any account is funded.

## 2. Measured deployment cost of the PotToken suite

Compiler profile: solc 0.8.24, `evmVersion: cancun`, `viaIR: true`, optimizer enabled with
`runs: 1`. The viaIR profile with a single optimizer run was chosen because the deployment cost on
this chain is dominated by the code deposit, so runtime bytecode size is the cost driver.

| Contract | Creation bytes | Runtime bytes | Gas | Cost at 31,270 wei | Cost at 32,580 wei |
| --- | --- | --- | --- | --- | --- |
| `PotERC20` | 4,058 | 2,775 | 7,968,528,748,368,133 | 249.18 tPOT | 259.61 tPOT |
| `PotERC721` | 5,799 | 4,517 | 12,512,097,908,704,717 | 391.25 tPOT | 407.64 tPOT |
| `PotRegistry` | 3,284 | 3,201 | 8,670,927,359,302,908 | 271.14 tPOT | 282.50 tPOT |
| **Total** | **13,141** | **10,493** | **29,151,554,007,375,758** | **911.57 tPOT** | **949.76 tPOT** |

Runtime total 10,493 bytes sits just under the 10,240 byte per-contract limit for the largest
contract at 4,517 bytes, well within the limit for every contract.

The non-viaIR profile (`runs: 200`, no viaIR) produced 12,453 runtime bytes and an estimated
1,111.72 tPOT at 32,580 wei, so the lean profile removes about 162 tPOT and roughly 2 kB of code.

Cost per creation byte is about 0.067 to 0.085 tPOT depending on the contract, which matches the
preflight figure of 529.84 tPOT for the 7,154 creation byte Makhzan contract.

## 3. Funding requirement

Request at least **1,050 tPOT** for the native account that maps to the deployer EVM address, so the
suite deploys with a 10 percent buffer at the current base fee. The base fee is not fixed: it was
32,580 wei earlier in the chain history and 31,270 wei at the time of measurement, so a larger
buffer is wise if the price moves.

The grant has to reach the **native** account that corresponds to the EVM key. For an EVM address
the native account is the 20-byte H160 followed by twelve `0xEE` bytes, encoded as SS58 with prefix
42, and the deployer needs at least 1,050 tPOT there before the EVM side sees the balance.

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
