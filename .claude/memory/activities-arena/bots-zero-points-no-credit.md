---
name: bots-zero-points-no-credit
description: "Bots (subjectType==='bot', avatars owned by per-bot system users) get tokensAwarded=0 + leaderboardPoints=0 + NO creditClawTokens; the result row is still inserted (tokens=0) for replay/telemetry, and the board SQL filters subjectType='bot'."
category: economy
confidence: high
date: 2026-06-22
---

# Bots: zero CT, zero points, row inserted for telemetry only

**Status: VERIFIED.** The anchor for the bot half of the carve-out; the full economy framing is in `[[match-payout-no-faucet]]` / `[[no-faucet-bots-and-guests]]`.

House bots backfill matches (matchmaking, queue, anti-grief). They are NOT a money counterparty:
- `isBot = participant.subjectType === 'bot'` (reward-pipeline.ts:372).
- `tokensAwarded = isBot ? 0 : …` (:396).
- `leaderboardPoints = (isBot || ctx.isGuest) ? 0 : …` (:403).
- `creditClawTokens` is gated `if (!isBot && tokensAwarded > 0)` (:437) — a bot never touches the ledger.
- The bot's `activity_results` row IS still inserted (tokens=0) for replay/telemetry; bot win-rate by level-bucket is emitted (`reef_race.bot_winrate.by_level_bucket`, :577) so the level-match gate isn't open-loop.
- The per-activity + free-agent leaderboard SQL filters `subjectType='bot'` (activity-leaderboard-service.ts:110).

## Why it matters
Bot avatars belong to per-bot SYSTEM users (bots/bot-pool.ts, 64 seeded). Crediting one mints CT into a system balance — an untreasury-backed synthetic faucet — and pollutes the rankings. Any new reward branch or participant type MUST preserve the guard. This is the #1 thing to re-check when editing the reward pipeline.
