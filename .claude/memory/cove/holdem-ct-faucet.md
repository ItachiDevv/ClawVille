---
name: holdem-ct-faucet
description: "Hold'em vs-bot bots mint synthetic CT (BOT_STACK=100n, no treasury debit) — rake only BOUNDS the faucet, full treasury-bank counterparty deferred"
category: economy
confidence: high
date: 2026-06-21
---

# Hold'em vs-bot CT faucet (BOUNDED, not closed — STILL OPEN on prod)

**Leak:** the 5 house bots are ephemeral seats with synthetic stacks (`cove-holdem.ts:131 BOT_STACK=100n`) NOT backed by a treasury debit. A human/agent who out-skills the deterministic bots cashes out > buy-in → net CT minted.

**Partial mitigation (on prod):** pot rake `computeHoldemRake = min(floor(pot*5%), 5CT)` (`holdem-engine.ts:71-72,1781-1864`) taken at settle, never credited back → a net CT BURN that BOUNDS the faucet. Rake is computed ONCE under the table FOR UPDATE lock, stored (`outcomeJson.rake` + flat payout/net = RAKED figures), and a settled-replay reads stored figures via `rakedFiguresFromOutcome` (pre-rake rows fall back to GROSS) — NEVER re-raked.

**Still OPEN (medium):** the 5CT/≈2.5BB cap is small vs the variance of an elite agent beating 5 deterministic bots — sustained skilled play can still net-mint CT. The FULL fix (treasury-CT-bank counterparty so chips are chip-for-chip conserved) is DEFERRED. Only watch = `GET /api/cove/economy/summary` faucets[]; no automated alarm-to-action.

**Money model:** STACK-based — only buy-in (open) + cash-out (close) cross the ledger; chips move WITHIN `table.playerStack` per hand (no per-hand ledger write). An abandoned in-progress hand leaves chips committed (no free-peek exploit; the human already paid at buy-in).

**Bots are deterministic** (never `Math.random`): mixed-strategy rolls from a dedicated cursor region `BOT_DECISION_CURSOR_BASE=2^20`, per-(seat,street,decisionIndex) non-overlapping 256-byte windows so deal bytes and decision bytes never collide → fully replayable. Related: [[baccarat-commission-economy-leak]], [[poker-money-models]], [[commit-reveal-no-board-leak]].
