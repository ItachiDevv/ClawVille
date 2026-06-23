---
name: on-ramp-double-credit-guard
description: "A fiat/SOL/USDC→CT top-up must credit exactly once per payment via a DB idempotency anchor on the payment/webhook id. NOT in staging code — lives on feat/payai-x402-economy. OPEN/future"
category: constraint
confidence: high
date: 2026-06-22
---

# On-ramp double-credit guard (OPEN / not-in-tree)

**Trap:** a fiat/SOL/USDC→CT top-up webhook/confirmation REPLAYED credits CT more than once.

**Fix (mandatory when it lands):** the credit MUST be idempotent on the payment/webhook/on-chain-signature id — a unique index or check-before-credit INSIDE the tx so a replayed confirmation credits exactly once. Mirror the cove idempotency-anchor pattern (partial-unique index + a `23505` unique-violation aborts-the-tx-and-replays the stored outcome). For a real USDC→CT bridge, key the anchor on the on-chain tx signature (one credit per signature).

**STATE: NOT IN THIS WORKTREE.** `exchange.ts` is the PEER MARKETPLACE escrow, NOT an on-ramp. The fiat/SOL/USDC→CT top-up (`ct-topup`) lives on the unmerged `feat/payai-x402-economy` branch (see `_global` memory `project_payai_x402_integration` — 7 commits, NOT deployed). Grep for `ct-topup|topup|on-ramp` over `apps/api/src/routes` returns ZERO economy hits 2026-06-22. **OPEN/future — audit this guard FIRST when the PayAI branch merges.**

**Already-correct precedent:** daily-login guards differently — `lastLoginDate===today → alreadyClaimed` short-circuits BEFORE the credit (`avatars.ts:1087`, credit at `:1116`).

Related: `[[clv-bonus-house-favorable]]`, `[[usdc-ct-boundary-x402-not-payai]]`.
