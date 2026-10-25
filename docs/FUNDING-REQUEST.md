# Funding request for the Portaldot V3 testnet deployer

The PotToken suite cannot be deployed until the deployer account holds enough tPOT on the native
side. This file contains the exact details to paste into the Portaldot Discord funding ticket.

## What to request

| Field | Value |
| --- | --- |
| Native account to fund | `5CpDHd5EAM8XefjSjNASyWArNiZjkxy4iDXGMCthN1TTrcbo` |
| Amount | **1,050 tPOT** (minimum 911.57 tPOT, which is the measured deployment cost) |
| Network | Portaldot V3 testnet, chain id 420420777 |
| Reason | Deployment of three Solidity contracts (ERC-20, ERC-721, binding registry) for the Portaldot on-chain ERC-20 / ERC-721 hackathon entry |

## Ticket text

```text
Hello, I need a testnet grant for the Portaldot V3 testnet (chain id 420420777).

Native account to fund: 5CpDHd5EAM8XefjSjNASyWArNiZjkxy4iDXGMCthN1TTrcbo
Amount requested: 1050 tPOT

This is the native account that maps to the EVM address I use for the submission
(0x212e9F97ed3EE1f605C6132fEdB1E99606a6f4Ce). The amount is the measured cost of deploying
three contracts (ERC-20, ERC-721, and a binding registry), estimated with eth_estimateGas:
249.18 + 391.25 + 271.14 = 911.57 tPOT, plus a 10 percent buffer.

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

The script prints the EVM balance, the native balance, and whether the account clears the 1,050
tPOT threshold. It exits with status 1 until the account is funded.

## After the grant lands

```bash
npm run release:testnet
```

That deploys the three contracts, binds the ERC-20 to native asset 1 and the ERC-721 to native NFT
collection 1, and verifies the deployment, writing `deployments/portaldotTestnet.json` with the
addresses and transaction hashes.
