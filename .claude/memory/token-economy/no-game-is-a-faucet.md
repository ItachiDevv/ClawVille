---
name: no-game-is-a-faucet
description: "A settlement credit with no matching debit net-mints CT; house/seeded/bot opponents must be treasury-backed or the path throws. Holdem vs-bot OPEN on prod; baccarat commission FIXED"
category: gotcha
confidence: high
date: 2026-06-22
---

# No game is a CT faucet

**Trap:** a SETTLEMENT credit with no corresponding debit, OR a seeded/bot opponent whose chips aren't backed by a house-bank debit → skilled human/agent net-MINTS CT on cash-out. Rake only BOUNDS, never CLOSES, a synthetic faucet.

**Fix:** conserve (`Σdebit==Σcredit+rake`); treasury-debit any house counterparty (chip-for-chip), OR make the path THROW. Cash poker throws `seeded_agent_requires_house_bank` without a `houseBankAvatarProvider`.

**DISTINGUISH** from designed faucets (`daily_login`/`level_up`/`building_visit`/chat rewards) — those are legitimate emission.

**State on prod:**
- **OPEN:** cove holdem vs-bot bots mint synthetic stacks (`BOT_STACK=100n`); rake bounds it, full fix DEFERRED. See `.claude/memory/cove/holdem-ct-faucet.md`.
- **FIXED:** baccarat commission floored-down faucet — `baccarat-engine.ts:497-519` now floors player WINNINGS not the commission. See `.claude/memory/cove/baccarat-commission-economy-leak.md`.

**Monitor:** `GET /api/cove/economy/summary` → any `houseNet<0` is a leak/faucet regression. Smoke it on staging after any house-banked-game change.

Related: `[[treasury-backed-house-opponents]]`, `[[conservation-by-construction]]`.
