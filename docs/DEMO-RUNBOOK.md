# Demo runbook

Everything needed for the submission video and the live demo, in order. Target length is three
minutes.

## 0. Before filming

```bash
npm install
npm run check
npm run check:funding
```

`npm run check` compiles, regenerates the SDK ABI, and runs all three test suites (72 contract
tests, 13 SDK tests, 68 release-safety tests). `npm run check:funding` must report `funded: true`
before anything else.

## 1. Deploy and bind (one command)

```bash
npm run release:testnet
```

The release runs the shared preflight before broadcasting anything: chain id 420420777, the
deployer identity and its mapped native account, the funding threshold on both ledgers in the
ledger's own units, the required native asset and NFT collection, the compiled artifacts byte
sizes, and the gas plan. Only when every preflight check passes does it deploy `PotERC20`,
`PotERC721`, and `PotRegistry`, then bind the ERC-20 to the configured native asset and the
ERC-721 to the configured NFT collection, then print the verification report. The artifact to show
is `deployments/portaldotTestnet.json`, which holds the contract addresses, transaction hashes,
block numbers, and the expected binding configuration with its transaction evidence.

A preflight pass proves the configuration was safe before the first transaction, not that
contracts are on chain. Use `verify:deployment` (included as the final step) for on-chain proof.

Before running, you must set the native binding IDs:

```bash
export POT_NATIVE_ASSET_ID=1
export POT_NATIVE_NFT_ID=1
```

These IDs must correspond to live native objects on the Portaldot V3 testnet (see
`npm run dual:read` to inspect existing assets and collections). The preflight rejects
`Option::None` native objects, misconfigured ids, insufficient funding, or missing artifacts
before signing, so an invalid id is caught with zero funds spent. The registry does not
automatically create or synchronize native objects: create the asset and collection on the native
side first. Restarting an intentionally unbound release is a deliberate, documented selection
(`POT_ALLOW_UNBOUND=true` for verification) and is not part of this demo.

## 2. Show the dual ledger console

```bash
npm run app
```

Open `http://localhost:4173/` and walk through the panels in this order:

1. **Chain and contracts** — chain id 420420777, latest block, and the deployed bytecode size of
   each contract.
2. **Token state** — ERC-20 name, symbol, decimals, supply, owner, issuer, pause state, and the
   ERC-721 collection metadata.
3. **Native account mapping** — paste an EVM address and show the derived SS58 account, the
   `0xEE` suffix rule, and the SHA-256 commitment.
4. **Unit conversion** — show that one native base unit equals 10,000 EVM wei, the 14 to 18 decimal
   relationship.
5. **Holder balances** — read an ERC-20 balance and an NFT count for an address.
6. **Registry bindings** — the native id, both decimal bases, and the conversion factor for each
   bound token.

The mapping and conversion panels work even if the browser cannot reach the RPC endpoint.

## 3. Show the same identity from both ledgers

```bash
npm run dual:read 0x212e9F97ed3EE1f605C6132fEdB1E99606a6f4Ce 5CpDHd5EAM8XefjSjNASyWArNiZjkxy4iDXGMCthN1TTrcbo 1 1
```

The output contains the EVM balance and nonce over JSON-RPC, the native free balance and nonce over
the Substrate WebSocket, the native asset balance for asset 1, the NFT collection 1 details, and
the mapping cross-check in both directions.

## 4. Optional SDK snippet

```js
import { PotTokenSuite } from './sdk/index.mjs';

const suite = await PotTokenSuite.connect({ deployments });
const state = await suite.getErc20State();
const binding = await suite.getBinding(deployments.tokens.erc20.address);
const account = await suite.nativeAccountFor(deployments.deployer);
console.log(state, binding.conversionFactor, account.ss58);
```

## 5. Talking points

- Portaldot V3 runs two ledgers over one chain: the native Substrate runtime and the Revive EVM.
  Tokens issued on the EVM side have no native meaning unless they are bound to it.
- `PotRegistry` is the bridge layer: it binds a token to a native `assets` id or `nfts`
  collection, records both decimal bases, derives the conversion factor, and stores a SHA-256
  commitment to the native account that owns the EVM identity.
- The unit trap is real: native balances use 14 decimals, the EVM uses 18, so one native base unit
  is 10,000 EVM wei. Every conversion in the suite is derived from stored decimals, never hardcoded.
- The mapping is deterministic and verifiable: H160 followed by twelve `0xEE` bytes, SS58 prefix 42,
  checked against the pairs published in the official Portaldot guide.
- The economics force the architecture: a deployment on this chain costs roughly 1,205 tPOT for this
  suite against 0.0153 tPOT for a light call, so the design is one shared deployment with per user
  state in the registry, never per user contracts.
- Verification is scripted, not asserted: `npm run check`, `npm run verify:deployment`, and
  `npm run dual:read` reproduce every claim on demand.

## 6. Submission artifacts

| Artifact | Where |
| --- | --- |
| Public repository | `https://github.com/mahitss/Portaldot_Network_onchain_ERC-20-ERC-721` |
| Contract addresses and tx hashes | `deployments/portaldotTestnet.json` |
| Preflight evidence | `docs/PORTALDOT_PREFLIGHT.md` |
| Cost measurements | `docs/EVIDENCE-V3-ESTIMATES.md` |
| Product decision record | `docs/decisions/002-product-lock-revision.md` |
| Funding request | `docs/FUNDING-REQUEST.md` |
