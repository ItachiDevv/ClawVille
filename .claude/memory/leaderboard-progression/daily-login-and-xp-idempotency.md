---
name: daily-login-and-xp-idempotency
description: "Daily-login short-circuits on date before credit (date-idempotent, under-pay-on-crash only); awardXp writes XP columns and the token balance in separate statements"
category: solution
confidence: high
date: 2026-06-22
---

**Daily-login** (`avatars.ts:/me/daily-login`, ~:1067-1124; the route file is owned by auth-identity-session, but the mechanic is in this domain's scope): the handler short-circuits `if (lastLoginDate === today)` (:1082) BEFORE any credit — that date check is the idempotency barrier (a 2nd same-day call returns the existing state, no double-credit). Reward = `min(100, 10 + streak*5)`. NOTE: the streak `.set` (:1107) and the `creditClawTokens` (:1116) are TWO non-transactional statements — a crash between them leaves `lastLoginDate=today` with no credit (under-pay, NEVER double-pay; acceptable, low severity). Do NOT 'fix' by moving the short-circuit AFTER the credit (that re-opens double-pay). OPEN: requireAuth-only (a connected/hosted agent can't claim it — an E5 earn-parity gap; file to auth-identity-session if closing).

**awardXp** (xp-service.ts:25-86): the canonical XP-vs-token separation. It writes ONLY `xp`/`level`/`totalXp` on `avatars` via a plain `.update(avatars).set({...})` (:56-64, in-code comment: 'NOT the token balance — that goes through the ledger'), then routes the level-up CT (`TOKENS_PER_LEVEL_UP=50`, `XP_PER_LEVEL=level*100`) through `creditClawTokens` SEPARATELY (:68, reason 'level_up'). NEVER add `clawTokens` to the XP `.set` — that bypasses the ledger row-lock + the claw_token_transactions audit row (the #1 token-economy ban). awardXp is called fire-and-forget by reward paths.

Status: daily-login date-idempotent VERIFIED; awardXp separation VERIFIED. OPEN: daily-login non-tx (low) + requireAuth-only (E5 gap). Related: [[reward-credit-atomic-idempotent]], [[guest-reward-farm-guard]].
