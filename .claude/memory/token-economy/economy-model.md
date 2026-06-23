---
name: economy-model
description: "The canonical ClawVille CT economy model — house-banked-edge vs skill-arena-rake, the implicit house (no treasury row), designed-faucet emission vs faucet-bug, treasury-back house opponents"
category: economy
confidence: high
date: 2026-06-22
---

# ClawVille CT economy model (the canonical money model)

**CT is the single internal play-currency.** One signed audit ledger (`claw_token_transactions`, `balanceAfter` per row) IS the source of truth; `avatars.clawTokens` is the materialized balance the ledger keeps in lockstep under a row lock. CT is NOT withdrawable today (caps damage); the same code carries a future SOL/USDC tier.

## Two house models (per game / per earn path)

- **House-banked (edge realized in payouts → net CT burn):** slots (`cove_slots_spin`/`cove_slots_win`), baccarat (banker commission, `BANKER_WIN_NUMERATOR=95n`), hold'em-vs-bot (pot rake `min(floor(pot*5%),5CT)`). The house edge bleeds CT out of player balances over time.
- **Skill-arena (house rakes, best knowledge wins):** blackjack (intentionally COUNTABLE — the 5%-net-winnings rake is the edge, not a reshuffle), poker MTT (buy-in pool → prizes minus rake), future agent-vs-agent hold'em. Edge is the rake; skill decides the rest.

## The house is IMPLICIT — economy monitor is the only P&L surface

The cove NEVER writes a treasury row for the house. House P&L = CT minted (`SUM(payout)`) vs burned (`SUM(bet)`) per gameType. ONLY surface: `cove-economy.ts GET /api/cove/economy/summary` (admin, `FEATURE_GATE cove_ct_economy_monitor`, review 2026-07-01): `houseNet = burned − minted`; **`houseNet < 0` = faucet alarm.** OPEN (medium): the gate reads 'Current reading: to fill (no prod cove traffic yet)' — never run against real traffic, so leak fixes are unverified end-to-end and there's no automated alarm-to-action.

## Designed faucet (legitimate) vs faucet BUG (the thing to kill)

The game INTENTIONALLY emits CT with no debit at these system faucets — they are the designed economy, NOT bugs: `daily_login` (10 + streak*5, max 100; idempotent on `lastLoginDate`), `level_up` (`xp-service.ts`), `building_visit`/`autonomous_visit` (agent-gateway), `building_chat_teaching` (chat rewards). A faucet **BUG** is an UNINTENDED credit-without-debit on a SETTLEMENT path, or a house-funded opponent whose chips aren't treasury-backed (→ skilled play net-mints CT). The RULE: **never let a GAME be a CT faucet.**

## Treasury-back house opponents (anti-faucet construction)

A house/seeded counterparty's chips MUST be backed by a real house-bank debit so chips are chip-for-chip conserved. Cash poker enforces this: a seeded provider with no `houseBankAvatarProvider` THROWS `seeded_agent_requires_house_bank` (explicit anti-faucet). Hold'em vs-bot does NOT yet (bots mint synthetic stacks; rake only bounds it) — STILL OPEN on prod, full treasury-bank fix deferred. `[[no-ct-faucet]]`

## Conservation by construction

Per game `Σdebit == Σcredit + rake`. Poker (bigint): `rake=(pool*rake_bps)/10000n`, floor each prize share, then **fold the rounding remainder into 1st place** so `Σprize + rake == pool` EXACTLY (`tournament-manager.ts`). Removing the fold breaks conservation by the rounding dust.

Related: `[[known-traps]]`, `[[ledger-primitive-and-consumers]]`. Source-of-truth for per-game leak detail: the cove agent's `.claude/memory/cove/{cove-economy-house-implicit,holdem-ct-faucet,baccarat-commission-economy-leak,poker-money-models}.md`.
