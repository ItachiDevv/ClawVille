---
name: reward-credit-atomic-idempotent
description: "Every CT reward (quest/bounty/tutorial/level-up) goes through the ledger inside the SAME db.transaction as its idempotency anchor; the anchor differs per reward type"
category: pattern
confidence: high
date: 2026-06-22
---

Every CT reward this domain pays MUST go through `creditClawTokens`/`debitClawTokens` (token-economy's ledger — NEVER a raw `avatars.clawTokens` write) AND commit INSIDE the same `db.transaction` as its idempotency anchor, so a retry/race can't double-pay.

**The anchor differs per reward type:**
- **Quest approve** (quests.ts:432): one `db.transaction`; anchor = compare-and-set `UPDATE questSubmissions SET status='approved' WHERE id=? AND status IN ('submitted','in_review') RETURNING *` — 0 rows ⇒ 409. The `creditClawTokens({...}, tx)` + `questRewards` INSERT + `quests.currentCompletions` increment ride the same tx.
- **Bounty escrow/release/refund** (bounties.ts): create = `debitClawTokens({...}, tx)` + bounty INSERT atomic (:347); release = compare-and-set attempt + `creditClawTokens` to hunter (:554); cancel-refund = compare-and-set `bounties WHERE status='open'` + `creditClawTokens` to creator (:1219). NOTE: PAUSED peer-commerce surface — escrow code correct but writes should 503; re-audit conservation if un-paused (creator debit == hunter credit == cancel refund, no double-release).
- **Tutorial-quest claim** (quests.ts:1369): one `db.transaction` with `creditClawTokens({...}, tx)` + INSERT into `tutorial_quest_claims`. Unique `(user_id, quest_id)` index is the authoritative barrier — concurrent double-claim rolls back at INSERT (23505 → :1411 → already_claimed 409). Cheap pre-check short-circuits before the validator+tx.
- **Level-up** (xp-service.ts:67): `creditClawTokens` for TOKENS_PER_LEVEL_UP (50/level) — see [[daily-login-and-xp-idempotency]].
- **Daily-login** (avatars.ts): date short-circuit is the barrier; credit is a single `creditClawTokens` NOT in a tx with the streak update (under-pay-on-crash only) — see [[daily-login-and-xp-idempotency]].

**Rule for new rewards:** (1) pick the ledger helper, (2) pick the anchor (compare-and-set / unique index / date key), (3) credit + anchor write in ONE tx, (4) on 23505/0-row return a stable already_* shape, (5) guard guests if the key is userId-scoped ([[guest-reward-farm-guard]]). Pass the caller `tx` so the ledger composes.

Status: quest/bounty/tutorial/level-up all atomic+idempotent (VERIFIED). Related: [[guest-reward-farm-guard]], [[daily-login-and-xp-idempotency]], [[tutorial-quest-server-gate]].
