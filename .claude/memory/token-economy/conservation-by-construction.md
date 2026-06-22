---
name: conservation-by-construction
description: "Σdebit == Σcredit (+rake) on every settlement; signed-amount + balanceAfter ledger reconstructs balances exactly; no path mints or vaporizes CT"
category: economy
confidence: high
date: 2026-06-22
---

# Conservation by construction

**Rule:** `claw_token_transactions.amount` is a SIGNED integer (`+credit`, `-debit`) with a `balanceAfter` snapshot, so `Σ` over an avatar reconstructs the balance exactly. No path mints or vaporizes CT. Every settlement: `Σdebit == Σcredit (+ rake)`.

**Per-domain matched legs:**
- **exchange escrow** (`routes/exchange.ts`): NEED = debit creator at post (`price*capacity`) → credit claimant at confirm OR refund creator at cancel; OFFER = debit buyer at order → credit seller at confirm OR refund buyer at cancel. Listing-cancel refunds remaining `(capacity - completed)` slots / each open buyer's escrow. Every debit has a matching credit-or-refund (no escrow COLUMN — the ledger IS the escrow source of truth).
- **transfer** = debit + credit in the same tx.
- **tournament**: `ΣprizeCt + rakeTaken == prizePoolCt` (fold the rounding remainder into 1st place).

**Designed faucets are legitimate:** `daily_login`, `level_up`, `building_visit`, chat rewards are the game's DESIGNED emission. A faucet BUG is an *unintended* credit-without-debit on a SETTLEMENT path, OR an untreasury-backed house opponent (see `[[no-game-is-a-faucet]]`, `[[treasury-backed-house-opponents]]`).

**The implicit house:** the cove has NO treasury row — house P&L = `SUM(bet) - SUM(payout)`, surfaced ONLY by the admin economy monitor `GET /api/cove/economy/summary` (`houseNet<0` = a leak/faucet regression).

**Audit-trail source tagging:** every write carries `source` (enum, `schema/treasury.ts:80-90`) + `reason` + `metadata` so the ledger is queryable per-domain. When a NEW CT-spending domain lands, ADD its `source` literal SAME-DIFF rather than mislabel it `'api'` (the source drives the per-domain economy/faucet monitor P&L).

Related: `[[no-game-is-a-faucet]]`, `[[treasury-backed-house-opponents]]`, `[[atomic-compose-into-caller-tx]]`.
