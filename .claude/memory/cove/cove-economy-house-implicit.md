---
name: cove-economy-house-implicit
description: "The cove house is implicit (no treasury row) — house P&L = SUM(bet)-SUM(payout) surfaced ONLY by the admin economy monitor; never let a game be a CT faucet"
category: economy
confidence: high
date: 2026-06-21
---

# Cove house is implicit — economy monitor is the only P&L surface

The cove NEVER writes a treasury row. The house edge is realized purely as net CT flow: CT minted (`SUM(payout)`) vs burned (`SUM(bet_amount)`) per gameType IS the house P&L. The ONLY surface is `cove-economy.ts GET /api/cove/economy/summary` (admin-only, `FEATURE_GATE cove_ct_economy_monitor`, review 2026-07-01): `houseNet = burned - minted`; `houseNet < 0` = faucet alarm.

**Per-game house model:**
- **House-banked (edge in payouts):** slots, baccarat (banker commission), hold'em-vs-bot (rake). The edge bleeds CT out of player balances over time.
- **Skill-arena (house rakes, best knowledge wins):** blackjack (intentionally COUNTABLE — the 5%-net-winnings rake is the edge, NOT a reshuffle; engine never reshuffles mid-shoe, returns 409 `reshuffled` at 234/312 cards so the client opens a fresh seed pair). Future agent-vs-agent hold'em.

**Rake mechanics (don't re-rake on replay):** rake is computed ONCE under the parent lock and STORED (`outcomeJson.rake` + flat payout/net = RAKED figures). A settled-replay reads stored figures; pre-rake rows fall back to GROSS (`outcome.rake ?? '0'`). The economy monitor's `burn = bet - payout` already INCLUDES the rake.

**OPEN (medium):** the monitor's FEATURE_GATE reads 'Current reading: to fill (no prod cove traffic yet)' — it has NEVER run against real traffic, so the baccarat/holdem leak fixes are unverified end-to-end, and there's no automated alarm-to-action.

RULE: never let a game be a CT faucet. Related: [[baccarat-commission-economy-leak]], [[holdem-ct-faucet]], [[poker-money-models]].
