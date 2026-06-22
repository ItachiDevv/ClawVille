---
name: cash-poker-no-transaction-bug
description: "cash-table-manager seat/cash-out do debit+insert+update as separate round-trips with NO db.transaction — only an in-process mutex, zero DB atomicity"
category: gotcha
confidence: high
date: 2026-06-21
---

# Cash poker has NO db.transaction (OPEN HIGH bug, LOCAL-ONLY)

`cash-table-manager.ts` is the ONLY cove money core that NEVER opens a `db.transaction`. `grep '\.transaction(' cash-table-manager.ts` → none.

- `seatSubject` (`:541-587`): debit → insert(seat) → update(escrow) → insert(ledger event) as **4 separate round-trips**.
- `cashOutSeat` (`:652-709`): credit → update(seat 'left') → update(escrow) → insert(ledger event), likewise.

The `withTableLock` in-process mutex serializes same-process calls but gives **ZERO DB atomicity**. Failure modes:
- Crash AFTER the ledger debit but BEFORE the seat insert → CT debited with no seat (player loses CT).
- Crash AFTER the cash-out credit but BEFORE the seat flips to 'left' → double cash-out on retry (seat still active).

**Contrast the CORRECT pattern:** `tournament-manager.ts:787 registerEntrant` does debit+pool+entrant inside `this.db.transaction` under FOR UPDATE.

**Fix before cash deploys:** wrap each money mutation in `db.transaction`, mirroring MTT. The in-process mutex is NOT a substitute for atomicity — do not assume it is.

Status: OPEN, LOCAL-ONLY on `feat/poker-mtt-tournament`. Settle itself (`settleHand`) IS idempotent (`poker_cash_hands.settled_at` non-null under the (tableId,handNumber) unique row replays). Related: [[conservation-and-idempotency-patterns]], [[poker-money-models]].
