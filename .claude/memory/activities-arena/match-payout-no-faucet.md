---
name: match-payout-no-faucet
description: "The per-match CT reward is a designed credit-only faucet (NOT a conservation break); bots earn 0/0/no-credit, guests earn real CT but 0 leaderboard points."
category: economy
confidence: high
date: 2026-06-22
---

# Match payout is a designed faucet, not a conservation break

**Status: VERIFIED (anchors current as of staging `a4daf0d8`).** Composes `[[no-faucet-bots-and-guests]]`, `[[bots-zero-credit-zero-score]]`, `[[two-economies-reward-faucet-vs-sol-wager]]`, `[[atomic-match-settlement]]`.

The activity reward path CREDITS ClawTokens on placement with NO entry-fee debit. This is INTENTIONAL legitimate emission (like daily-login / building-visit) backing the `activity.match.placed` leaderboard weight — the cove's `Sigma debit == Sigma credit` rule does NOT apply here. Do NOT add a debit to 'balance' it; do NOT flag it as a faucet.

## The real faucet RISK is a BUG faucet — two carve-outs prevent it
- **Bots** (`subjectType === 'bot'`, reward-pipeline.ts:372): `tokensAwarded = 0` (:396), `leaderboardPoints = 0` (:403), and `creditClawTokens` is SKIPPED — gated `if (!isBot && tokensAwarded > 0)` (:437). A bot result row is still inserted (tokens=0) for replay/telemetry. Bot avatars belong to per-bot system users (bots/bot-pool.ts, 64 seeded) — crediting them mints CT into a system balance.
- **Guests** (`ctx.isGuest`, reward-pipeline.ts:392-402): an activity guest is a REAL Lucia guest user with a REAL avatar, so it DOES earn placement CT via the ledger, but `leaderboardPoints = 0` (:403). DELIBERATE divergence from the cove (whose guests are ephemeral demo-only session balances). The carve-out is LEADERBOARD exclusion, NOT ledger exclusion. The leaderboard SQL excludes BOTH bots and guests (activity-leaderboard-service.ts:110,:119).

## Atomicity
Reward CT moves ONLY through `creditClawTokens(…, tx)` (reward-pipeline.ts:438, `source:'simulation'`, `reason:'activity_match_placed'`), composed INTO the match `db.transaction` (:354/:457) so a ledger failure rolls back the `activity_results` inserts. Reward tiers come from the SERVER-side `rewardConfig`, never the request body. NEVER write `avatars.clawTokens` directly — that is token-economy's ledger.

## Trap for a future editor
Any new reward branch or participant type MUST preserve both carve-outs. The #1 audit error is applying the cove conservation lens and either flagging the legit emission or 'fixing' the activity guest to demo-only.
