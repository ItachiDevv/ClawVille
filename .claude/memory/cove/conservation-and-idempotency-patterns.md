---
name: conservation-and-idempotency-patterns
description: "Atomic settle tx under FOR UPDATE + engine-recompute-under-lock + Idempotency-Key/partial-unique-index backstop + compare-and-set status flip"
category: pattern
confidence: high
date: 2026-06-21
---

# Settle conservation + idempotency patterns (the money-safety spine)

**Atomic settle tx (every game except cash poker):** ONE `db.transaction`. Sequence under `SELECT ... FOR UPDATE` on the parent row (shoe/session/table/tournament):
1. Re-assert `ownerMatch` UNDER the lock (money fn NEVER trusts caller pre-checks).
2. Load the hand bound to `(id, parentId)` not `id` alone (prevents settling a victim hand on another shoe to the attacker's balance).
3. Cursor/dealt drift assertion (stored == reconstructed, else 500 `shoe_counter_drift_at_settle`).
4. **RECOMPUTE the engine UNDER the lock** — a stale pre-lock read must NEVER commit a divergent outcome (cove-blackjack.ts:1738-1764; cove-slots.ts:1114-1152).
5. MAX_SAFE_INTEGER guards, then ledger debit + credit.
6. Compare-and-set: `UPDATE ... WHERE status='in_progress'` flips exactly once.

**Idempotency anchors:** client `Idempotency-Key` header (≤64 chars) + a DB **partial-unique index** = the race-safe backstop: `(sessionId,idempotencyKey)` slots, `(shoeId,idempotencyKey)+(shoeId,coupIndex)` baccarat, `(tableId,idempotencyKey)` holdem. A **23505 collision ABORTS THE WHOLE TX** (rolling back the in-tx debit/credit) → `IdempotencyReplayError` → re-read + replay the colliding settled row OUTSIDE the aborted tx. NEVER read inside the failed tx. Same key + different stake/args → 409, never a second charge.

**Poker conservation by construction (bigint throughout):** `rake=(pool*rake_bps)/10000n`, `computePrizes` floors each share, then settle FOLDS THE ROUNDING REMAINDER INTO 1ST PLACE so `Sum(prize)+rake == pool` EXACTLY (`tournament-manager.ts:1846-1860`). Removing the fold breaks conservation by the rounding dust. Chip conservation: `post = start - totalCommitted + won` (never mints).

**Ledger inserts are NOT independently idempotent** — idempotency lives at the spin/hand/event layer above, which gates whether settlement runs.

**ANTI-PATTERN (cash poker, OPEN HIGH bug):** `cash-table-manager.ts` opens NO db.transaction — 4 separate round-trips guarded only by an in-process mutex (zero DB atomicity). See [[cash-poker-no-transaction-bug]]. Related: [[atomic-settle-under-lock]], [[poker-money-models]].
