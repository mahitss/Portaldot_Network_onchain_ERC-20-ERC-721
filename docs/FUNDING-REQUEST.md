# Funding request for the Portaldot V3 testnet deployer

The PotToken suite cannot be deployed until the deployer account holds enough tPOT on the native
side. This file contains the exact details to paste into the Portaldot Discord funding ticket.

## What to request

| Field | Value |
|---|---|
| Native account to fund | `5CpDHd5EAM8XefjSjNASyWArNiZjkxy4iDXGMCthN1TTrcbo` |
| Whole-release recommended balance | **≈ 2,549 tPOT** (EVM 18 decimals; native 14 decimals) |
| Minimum deployment budget | ≈ 1,209.9 tPOT (measured creation estimates × live gas price) |
| Remaining binding budget | ≈ 913.7 tPOT reserve (2 registry bindings × registry-creation upper bound) |
| Network | Portaldot V3 testnet, chain id 420420777 |
| Reason | Deployment of three Solidity contracts (ERC-20, ERC-721, binding registry) plus both native registry bindings for the Portaldot on-chain ERC-20 / ERC-721 hackathon entry |

## Ticket text

```text
Hello, I need a testnet grant for the Portaldot V3 testnet (chain id 420420777).

Native account to fund: 5CpDHd5EAM8XefjSjNASyWArNiZjkxy4iDXGMCthN1TTrcbo
Amount requested: 2549 tPOT (whole-release recommended balance)

This is the native account that maps to the EVM address I use for the submission
(0x212e9F97ed3EE1f605C6132fEdB1E99606a6f4Ce). The amount covers the whole
release: measured creation estimates for three contracts (ERC-20, ERC-721,
binding registry) ≈ 1,209.9 tPOT at the live gas price, plus a binding reserve
of ≈ 913.7 tPOT for the two registry bindings (bounded by the registry's own
creation estimate, the heaviest measured registry transaction), plus a 20%
fee-fluctuation margin. Recommended whole-release balance ≈ 2,549 tPOT. The
previous 1,350 tPOT figure covered only the deployment estimate and is
insufficient for the full release including bindings and margin.

These figures are read-only estimates (eth_estimateGas × live gas price),
not a guarantee of the final deployment cost. The release preflight recomputes
the requirement live before the first transaction and fails closed if the
balance is insufficient.

Repository: https://github.com/mahitss/Portaldot_Network_onchain_ERC-20-ERC-721
```

## Why the native account is funded instead of the EVM address

The testnet has no faucet. Balances are sent to a native SS58 account, and the EVM side only sees
that balance at the mapped EVM address. The mapping is deterministic: the 20-byte H160 of the EVM
address followed by twelve `0xEE` bytes, encoded as SS58 with prefix 42.

```text
EVM address  0x212e9F97ed3EE1f605C6132fEdB1E99606a6f4Ce
account      0x212e9f97ed3ee1f605c6132fedb1e99606a6f4ceeeeeeeeeeeeeeeeeeeeeeeee
SS58         5CpDHd5EAM8XefjSjNASyWArNiZjkxy4iDXGMCthN1TTrcbo
```

The same mapping appears in the official Portaldot V3 guide, where the guide deployer address
`0xf7eC65d11e35375A250e474059a917B537804142` corresponds to
`5Hfmuhj1AHrTBJiC9zUPnJo1cfG2G52LLMwofSigBnjtto8Y`.

## Checking the balance

```bash
npm run check:funding
```

The script prints the EVM balance and the native balance, each in its own ledger's
units (native 14 decimals, EVM 18 decimals), and compares them against the
computed whole-release requirement (deployment estimate + binding reserve + 20%
fee margin). It reports `funded: true` only when both ledgers clear the
requirement, and exits with status 1 otherwise. The release performs its own
stage-aware preflight before any transaction.

## After the grant lands

```bash
npm run release:testnet
```

That runs the full release preflight first and only then broadcasts: it validates
the chain id (420420777), the deployer identity and its mapped native account,
the whole-release funding requirement on BOTH ledgers in each ledger's own
units, that the required native asset AND NFT collection are explicitly
configured and exist on the native runtime, that the compiled artifacts are
within the 10,240-byte Revive limit, and that the gas plan covers the RPC's own
creation estimates. If any preflight check fails, the release aborts before
signing anything, so an unfunded or misconfigured release spends nothing.

The deployment is resumable: each confirmed contract is persisted immediately
after it is sent, and rerunning the release reuses confirmed contracts instead
of redeploying them. A malformed or mismatched deployment record is never
silently overwritten; replacing it requires the explicit
`POT_FORCE_FRESH_RELEASE=1` operation, which archives the old record first.

Before running the release, you must also set the native binding IDs:

```bash
export POT_NATIVE_ASSET_ID=1
export POT_NATIVE_NFT_ID=1
```

These values must correspond to live native objects on the Portaldot V3 testnet
(see `npm run dual:read` to inspect existing assets and collections). The
preflight requires them to exist; neither the registry nor the release creates
native objects, so fund this step only after the native asset and NFT collection
are already in place.

After deployment the release binds the tokens and writes
`deployments/portaldotTestnet.json`. The binding stage is stage-aware: after
deployment has spent its funds, the binding preflight budgets only the remaining
binding transactions (each re-estimated live with `eth_estimateGas`), never the
original deployment balance again. A successful preflight proves the
configuration was safe before broadcasting; only `npm run verify:deployment`
proves the deployment itself landed with bytecode, confirmed receipts, and the
required bindings.
```
