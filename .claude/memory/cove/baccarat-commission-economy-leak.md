---
name: baccarat-commission-economy-leak
description: "Baccarat banker commission floored-down was a CT faucet below stake 20 — fixed by flooring the player's WINNINGS not the commission"
category: economy
confidence: high
date: 2026-06-21
---

# Baccarat commission economy leak (FIXED, but UNVERIFIED end-to-end)

**Leak:** the 5% banker commission was being floored on the COMMISSION side, so on small / non-multiple-of-20 stakes it rounded to 0 and the banker bet flipped +EV for the player (a CT faucet below stake 20).

**Fix:** `baccarat-engine.ts:497-519 settleBet` + `:106 BANKER_WIN_NUMERATOR=95n`. Floor the PLAYER's WINNINGS instead: `winnings = stake * 95n / 100n`; `commission = stake - winnings` (>= 1 for any stake >= 1). Restores the ~1.06% banker edge at EVERY stake. On master+staging (engine byte-identical across WT too).

**House model:** baccarat is house-banked — the edge is realized as net CT burn (`SUM(bet) - SUM(payout)`). The house is IMPLICIT (no treasury row); only surface is `cove-economy.ts GET /api/cove/economy/summary` (admin, `houseNet<0` = faucet alarm).

**OPEN (low):** the economy monitor's FEATURE_GATE reads 'Current reading: to fill (no prod cove traffic yet)' — the fix shipped ahead of the documented §3.3 re-sim + §3.4 UI/mobile gate (`.claude/plans/cove-casino-economy.md`). The commission/rake is NOT yet surfaced to the player in the UI. The formula change IS proven by the `oldBaccaratSettle` back-compat path in the verifier.

Rule: NEVER let a game be a CT faucet. Related: [[holdem-ct-faucet]], [[conservation-and-idempotency-patterns]], [[cove-economy-house-implicit]].
