---
name: guest-reward-farm-guard
description: "Fresh-userId-per-guest defeats a (userId,questId) idempotency key; account-bound rewards must 403 guests, and an agent must never be guest-demoted on the score path"
category: gotcha
confidence: high
date: 2026-06-22
---

Userid-keyed rewards have a guest farm hole: every guest signup mints a fresh `userId`, and the tutorial idempotency key is `(user_id, quest_id)`. Without a guard, a guest claims the full ~175 CT tutorial reward, then re-signs-up and farms again.

**The guard:** `quests.ts:1305` checks `users.isGuest` BEFORE the validator/transaction and returns 403 `guest_not_eligible` (audit-fix 2026-04-29, in-code comment: 'a guest could mint the full ~175 CT tutorial reward, then re-signup and farm again'). Daily-login, admin-quest, and bounty rewards are also `requireAuth` (human-only by design — these are onboarding/PR rewards, NOT an E5 co-play money path, so do not 'fix' them to agent sessions without checking the brand carve-out).

**The symmetric trap (scoring side):** bots + guests score ZERO on the contribution board (`subjectType <> 'bot'`, `isGuest <> 'true'` filters in both CTE legs); an AGENT that gets guest-demoted on the read/score path (because the resolver didn't resolve `{user,agent,guest}` consistently) would silently zero its real contribution — the auth subject-keying-keystone bug.

**Rule:** any new reward whose idempotency key is userId-scoped must `403` guests (or bind to a durable identity); any agent-reachable score/read path must resolve the agent (never demote to guest).

Status: tutorial guest-403 FIXED (VERIFIED quests.ts:1305). Related: [[reward-credit-atomic-idempotent]], [[tutorial-quest-server-gate]], [[no-farm-is-a-rank]].
