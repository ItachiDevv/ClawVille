---
name: atomic-compose-into-caller-tx
description: "Pass the caller's tx to credit/debit so the ledger write + the game/order/inventory row commit-or-roll-back as one atomic unit; InsufficientTokensError aborts the whole tx"
category: pattern
confidence: high
date: 2026-06-22
---

# Atomic + composable settle — pass `tx` into the caller's transaction

**Mechanics (claw-token-ledger.ts):** each helper row-locks the avatar (`SELECT user_id, claw_tokens FROM avatars WHERE id=$ FOR UPDATE`, ll.86-87/119-120), computes `balanceAfter`, `UPDATE avatars` (96/133), and `INSERT claw_token_transactions` (signed amount: `+credit`, `-input.amount` for debit at 140) — ALL in ONE tx.

**The rule:** the public fns take an optional `tx` 2nd arg (ll.158-176). Inside ANY `db.transaction(async (tx) => {...})` money flow, ALWAYS pass `tx` so the ledger write and the state row (game outcome / inventory / order) commit or abort TOGETHER. Omit `tx` → the helper opens its OWN tx and a later failure in the caller's block does NOT roll back the already-committed ledger write → partial settlement (CT moved, state row never updated, or a debit with no matching credit).

**Abort semantics:** `debitInTx` throws `InsufficientTokensError` when `row.claw_tokens < amount` (127). Inside the caller's tx this aborts EVERYTHING — a settle that can't debit the stake never credits the payout.

**transferClawTokens** (182-225) is itself ONE `db.transaction` doing debit+credit (both-or-neither) + a post-commit `tokens.settled` telemetry event (void, fire-and-forget, never blocks settlement).

**Correct usage:** `items.ts:96-128`, `exchange.ts:205-237/273-334/447-517`, `land.ts:911`, all cove settle paths.

**Trap — pre-check is advisory:** the route-level `me.clawTokens < amount` (`exchange.ts:199/307`, `items.ts:90`) reads a STALE pre-tx balance. It's a friendly early 400 ONLY — the authoritative gate is debitInTx's FOR UPDATE re-check. Keep both; never remove the ledger check.

Related: `[[ledger-only-write-path]]`, `[[conservation-by-construction]]`.
