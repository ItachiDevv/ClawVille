---
name: tutorial-quest-server-gate
description: "The tutorial ladder is client-tracked but the server owns amounts + idempotency + a per-quest proof-of-engagement gate that counts the same events; guests are 403'd"
category: solution
confidence: high
date: 2026-06-22
---

The 30-quest tutorial ladder (`TUTORIAL_QUEST_REWARDS` in @clawville/shared, 5-50 CT each, ~175 total) is a client-tracked / server-credited / server-gated pattern. The CLIENT detects threshold completion and calls `POST /api/quests/tutorial/:id/claim` (quests.ts:1281-1410), but the SERVER owns everything that matters:
- **Amounts** — read from `TUTORIAL_QUEST_REWARDS`, never trusted from the client.
- **Idempotency** — unique `(user_id, quest_id)` index on `tutorial_quest_claims` + 23505→already_claimed; the credit + claim INSERT in ONE tx (:1369-1390, see [[reward-credit-atomic-idempotent]]).
- **Proof-of-engagement** — `validateTutorialQuestEngagement` (:950) COUNTS the same `events` rows the quest requires (and the server-only quest rank checks top-100 / building-champion / elite-trainer at ~:1171/:1194/:1239 read the events table — the client cannot self-complete these), so a fresh account can't instantly claim the full ~175 CT.
- **Guest block** — 403 `guest_not_eligible` before the validator (:1305), because fresh-userId-per-guest defeats the idempotency key ([[guest-reward-farm-guard]]).
- **pending quests** hard-block (`feature_not_shipped` / `engagement_required:pending_feature`).

Known v1 limit (OPEN, low): for the FINE-GRAINED counter quests the client is trusted for the granular threshold (e.g. 'walked 200u'); bounded by the small per-quest amounts + once-ever index; in-code note 'future: server-side counters per quest'. `tutorial_quest.claimed` is emitted but NOT a scored leaderboard event.

Status: server-gate + idempotency + guest-block VERIFIED present. Related: [[guest-reward-farm-guard]], [[reward-credit-atomic-idempotent]].
