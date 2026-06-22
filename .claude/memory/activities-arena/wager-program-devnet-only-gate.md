---
name: wager-program-devnet-only-gate
description: "The SOL wager rail is devnet-only by a CODE gate (WagerCluster type excludes mainnet); mainnet is a code change, not an env flip — but the RPC URL itself is read raw, backstopped only by the authority-pubkey refusal."
category: constraint
confidence: high
date: 2026-06-22
---

# Wager program is DEVNET-only by code-gate (with an RPC-URL nuance)

**Status: VERIFIED.** Composes `[[wager-devnet-only-code-gate]]`, `[[wager-mainnet-not-code-gated]]`, `[[wager-route-human-only]]`.

## The code-gate
`packages/wager-program/src/index.ts:53`: `type WagerCluster = 'devnet' | 'localnet'` — `'mainnet'` is NOT in the type. `CLUSTER` (:54-57) only ever resolves `localnet` (test override) or `devnet`. `PROGRAM_ID` = `HgQhHVYV2C5Mw8K81kEnADkqsuS5YQRmGJDUR5wnZVuG` (devnet). Setting `WAGER_PROGRAM_CLUSTER=mainnet` does NOTHING (falls through to devnet). Mainnet requires a deliberate CODE change + payments/legal sign-off (FEATURE_GATE `wager-mainnet-paid` in wager.ts). The deployed devnet program may LAG the repo IDL — verify on-chain (`explorer.solana.com/address/Hg…?cluster=devnet`) before assuming an instruction exists.

## The NUANCE (read before touching wager-program-client.ts)
The `CLUSTER` constant excludes mainnet, but the actual RPC connection reads `SOLANA_RPC_URL` RAW (wager-program-client.ts:84-85, devnet default) — so a mainnet RPC URL in env WOULD be used at the RPC layer. The 'routes never sign mainnet RPC URLs' header (routes/wager.ts:36) is COMMENT-ONLY, not enforced. The ONLY backstop is the settlement-authority pubkey-mismatch refusal (:153 — `pubkey_mismatch` throw): the client refuses to sign anything if the decrypted authority pubkey != the env-pinned/devnet-default. Treat mainnet as gated by PROGRAM_ID + authority pinning, NOT by an RPC-URL guard. **If you touch this file, add an explicit crash-loud mainnet-host refusal.**

## Wager safety invariants
- Lobby FSM `open -> locked -> settled/cancelled` (DB check constraint) mirrors the on-chain PDA; settle/lock/cancel are idempotent (re-settle -> `{idempotent:true}`).
- Settle REQUIRES the winner to be a depositor in `lobby_players` (bots have no wallet PDA -> filtered); no-winner -> a `failed` event for operator cancel->refund, never an unbacked payout. `solo-bots` bypasses escrow.
- The Anchor program (`contracts/programs/clawville-wager/**`, `wager-program-client.ts`, `packages/wager-program/**`) is high-stakes: ANY change -> `solana-auditor` pass + `ARCHITECTURE.md §13` update + devnet smoke + keep the committed IDL/type in sync.

## OPEN E5 gap
`routes/wager.ts` is entirely `requireAuth`/`adminOnly` (5x requireAuth, 0x requireAuthOrAgentSession) — a connected agent cannot stake a SOL lobby as itself. Bounded by devnet fun-money; close it (agent custodial wallet + agent-session resolver on deposit) BEFORE real value. `[[wager-route-human-only]]` OPEN.
