# ADR 002 — Product lock revision: on-chain ERC-20 / ERC-721 token suite for Portaldot V3

**Status:** Accepted (supersedes ADR 001) · **Date:** 2026-10-25
**Supersedes:** `docs/decisions/001-product-lock.md` (PotLink). ADR 001 is retained for history; its platform evidence remains valid and is reused here.

## Context

ADR 001 recommended **PotLink** (payment links and verified receipts) after a full preflight of Portaldot V3 (`docs/PORTALDOT_PREFLIGHT.md`). While that work was being reviewed, the founder created the submission repository `mahitss/Portaldot_Network_onchain_ERC-20-ERC-721` (public, empty, default branch `main`, created 2026-10-25T07:34:12Z) and instructed that the product code be pushed there. The repository name fixes the product direction: an **on-chain ERC-20 / ERC-721 implementation for Portaldot Network**.

This ADR records that direction change under change control, states what is kept from ADR 001, and re-locks the product.

## Decision

Ship **PotToken Suite**: ERC-20 and ERC-721 token contracts that execute for real on Portaldot V3's `pallet-revive` (Revm) EVM, plus the layer that makes those tokens usable on a chain that has **two ledgers** — a binding registry that ties each token to its native `assets` / `nfts` counterpart, a unit-safe conversion between the EVM's 18-decimal denomination and the native ledger's 14-decimal denomination, and a dual-ledger verification path that lets an EVM wallet and a native account independently confirm the same token balance and identity.

Concretely:

1. `PotERC20` — role-based ERC-20 (owner / issuer), mint, burn, allowance, pause, standard events.
2. `PotERC721` — role-based ERC-721 with per-token metadata, approvals, operator approvals, mint / burn.
3. `PotRegistry` — binds a token address to a native asset id or NFT collection id, stores both decimal systems, stores the unit conversion factor and a SHA-256 commitment to the native account (SS58 public key) that administers it, and exposes conversions plus binding verification.
4. `sdk/` — dependency-light library for the two verified primitives of this chain: the deterministic H160 ⇄ SS58 mapping (`H160 ‖ 0xEE × 12`, prefix 42) and the 18 dp ⇄ 14 dp amount conversion; native-side reads through `@polkadot/api`, EVM-side reads through plain JSON-RPC.
5. `app/` — a static dual-ledger console that reads live state only: EVM token holdings and registry bindings over JSON-RPC, and the same contract state read from the **native** side through the chain's Revive runtime call path.
6. `scripts/` — preflight, deployment, byte-for-byte deployment verification and dual-ledger read checks.

## Why this direction is stronger than ADR 001's PotLink for this submission

* It matches the founder's stated direction and the repository identity, and it is a **submission-shaped** deliverable: a judge can read the contracts and verify a real deployment.
* It attacks the same verified gap that justified PotLink — Portaldot's dual account/asset model — from the token-issuer side, which is where the pain is most concrete: the official Portaldot FAQ states that an ERC-20 minted in `revive` is **not** represented in native `assets`/`nfts`, that the same token is denominated with 14 decimals natively and 18 in the EVM, and that a user must resolve an H160 to its SS58 mapping by hand before anything can be funded.
* It is verifiable without an indexer, a faucet, a bridge or an unpublished API: one shared set of contracts on `revive`, the chain's own RPCs, and the deterministic mapping that was proven on two published on-chain address pairs.
* It keeps ADR 001's hard economic constraint: **one shared deployment, no per-user contracts**, because a deployment on V3 costs ≈ 529.84 tPOT while a light call costs ≈ 0.0153 tPOT.

## Carried over from ADR 001 (unchanged, still binding)

* Deadlines and submission artefacts: code freeze 2026-11-06 04:00 UTC, demo day Nov 8–9; public repository, ≥ 3 commits, contract address + transaction hash + explorer link, ≤ 3-minute demo video, pitch deck, runnable demo.
* Cost discipline: one shared contract set; no per-issuer or per-user deployments; runtime code size kept well under the ≈ 10,240 B Revive limit that dominates the ≈ 529.84 tPOT deployment cost.
* Evidence discipline: every live claim must be backed by a receipt or a chain read; no mock data in the shipped app; no secrets in the repository.
* Risk posture: no admin key on user-facing paths (registry ownership is transferable to a native multisig later), no upgradeability, no reliance on the community PortalIndex indexer, no bridge, no ink! dependency.
* Honest limitations: the official FAQ does not define cross-module atomicity between `contracts` (ink!) and `revive`, and does not define an automatic ERC ⇄ native-asset equivalence — this product therefore provides a **verifiable binding**, not an automatic representation, and says so everywhere.

## What this ADR does not change

* `docs/PORTALDOT_PREFLIGHT.md` remains the source of truth for platform facts and must be re-verified before any deployment (chain identity, mapping rule, decimals, code size, costs).
* ADR 001's alternatives analysis remains valid input for future review; PotLink is rejected **for this submission**, not on the merits.

## Consequences

* Build order: contracts + local EVM tests → registry + conversion logic → SDK primitives → dual-ledger console → testnet deployment and verification → submission artefacts.
* V3 deployment remains **blocked on a funded native account**, because the deployer needs tPOT (the funding path is a Discord ticket with the native SS58 address, per the official announcement). Until then the repository ships with the deployment path implemented, tested against a local EVM, and ready to execute against V3.
