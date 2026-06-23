---
name: treasury-backed-house-opponents
description: "Any house/seeded/bot CT counterparty must be funded by a treasury-bank debit chip-for-chip or the path must throw — never a synthetic stack"
category: economy
confidence: high
date: 2026-06-22
---

# Treasury-backed house opponents (no synthetic stacks)

**Rule:** any game/activity where a house bot or seeded agent provides a CT counterparty MUST fund that counterparty from a treasury-bank debit (chip-for-chip), OR the path MUST throw. A synthetic (non-treasury) stack is a faucet — a skilled player nets CT minted from nowhere on cash-out.

**Patterns:**
- **Cash poker (correct):** throws `seeded_agent_requires_house_bank` unless a `houseBankAvatarProvider` supplies a real treasury-backed avatar whose stack is a real ledger debit. See `.claude/memory/cove/poker-money-models.md`, `cash-poker-no-transaction-bug.md`.
- **Activities (correct):** bots get `leaderboardPoints=0` and NO CT credit (`activity/reward-pipeline.ts:438`) — they're not a counterparty, just opponents.
- **Holdem vs-bot (OPEN):** mints synthetic stacks — full fix deferred, rake bounds it.

**Treasury context:** `treasuryWallets` (`schema/treasury.ts`) is team merchant supply (AES-256-GCM secret keys, x402 receiver, vanity set) — NEVER user-facing. The cove house itself is implicit (no row); P&L is `SUM(bet)-SUM(payout)` via the monitor.

Related: `[[no-game-is-a-faucet]]`, `[[conservation-by-construction]]`.
