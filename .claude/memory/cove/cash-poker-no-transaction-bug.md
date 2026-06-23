---
name: cash-poker-no-transaction-bug
description: "RESOLVED — cash-table-manager seat/cash-out/settle now wrap db.transaction + FOR UPDATE (was separate round-trips with no DB atomicity); fix verified by the house-bots money audit 2026-06-22"
category: gotcha
confidence: high
date: 2026-06-22
---

# Cash poker NO-db.transaction bug — RESOLVED (was OPEN HIGH)

**FIXED.** `cash-table-manager.ts` now opens a `db.transaction` with `SELECT … FOR UPDATE` on the parent table row for every money mutation, composing the ledger debit/credit INTO that same tx (so the CT row-lock + balance-assert + `claw_token_transactions` insert commit atomically with the seat/escrow write). Confirmed by the option-A + option-B house-bots money-conservation audits (2026-06-22): `seatSubject` (~`:711-753`), `cashOutSeat`, and `settleHand` are all single-tx + FOR UPDATE. `grep '\.transaction(' cash-table-manager.ts` now returns matches.

**The original bug (for the record):** seat/cash-out did debit → insert(seat) → update(escrow) → insert(ledger) as **separate round-trips** under only the in-process `withTableLock` mutex — zero DB atomicity. Failure modes were: crash after the ledger debit but before the seat insert (CT debited, no seat); crash after a cash-out credit but before the seat flips to `'left'` (double cash-out on retry). The in-process mutex serializes same-process calls but is NOT a substitute for DB atomicity.

**Lesson that still holds:** any cove money mutation that touches the ledger AND a row write must compose both into ONE `db.transaction` under `FOR UPDATE` (mirror `tournament-manager.ts registerEntrant`), never a sequence of round-trips guarded only by an in-process mutex. The house-bots build (treasury-banked seeded bots) depends on this: every seeded buy-in DEBITS the house bank inside the seat tx, so `Σdebits == Σcredits + Σescrow` holds atomically.

Status: RESOLVED on `staging` (cash games shipped with the tx). Related: [[conservation-and-idempotency-patterns]], [[poker-money-models]].
