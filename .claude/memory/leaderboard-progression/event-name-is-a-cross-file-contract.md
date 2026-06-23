---
name: event-name-is-a-cross-file-contract
description: "A scored eventType string lives in the emitter + the scoring CTE + /dash + the tutorial gate; rename/add moves all same-diff or scoring silently drops with no error"
category: gotcha
confidence: high
date: 2026-06-22
---

`events.event_type` is plain text (schema/events.ts) — there is NO central enum and NO compile-time guard. A scored `eventType` literal (and scored payload keys: `placement`, `subjectType`, `isGuest`, `via`, `chatType`) is a CROSS-FILE CONTRACT matched by string equality in raw SQL across:
- the **emitter** (~6 route/service files: agent-gateway.ts for building.visited/agent.chat.turn/skill_md.fetched/identity.issued/agent.connected, agent-collaboration.ts:115 for agent.collaboration.turn, cove/activity routes for activity.match.placed, land routes for land.*)
- the **scoring CTE** in `leaderboard.ts` — BOTH agent_daily AND avatar_daily legs
- the **/dash query** in `dashboard.ts` (e.g. the teacher-chat discriminator `chatType IN ('building','location')` at :137-147)
- the **tutorial engagement gate** `validateTutorialQuestEngagement` in `quests.ts` (counts the same events as proof-of-engagement)

**The trap:** renaming an event_type, or changing a scored payload key, in one place but not the others → scoring/metrics SILENTLY drop, no error. Notable nuances already in the contract: the partner-import carve-out (`skill_md.fetched AND payload->>'via' <> 'partner-import'`, leaderboard.ts:612 — so a partner re-embedding our SKILL.md can't farm skill_md rank), and `tutorial_quest.claimed` IS emitted (quests.ts:1395) but deliberately NOT scored (it's a CT reward, not a contribution signal — 0 hits in leaderboard.ts).

**Rule:** grep the literal across `apps/api/src` (emitters), `leaderboard.ts` (both legs), `dashboard.ts`, and `quests.ts`; move all same-diff; coordinate the payload shape with the emitter's owning domain (co-owned seam).

Status: VERIFIED cross-file (no central enum). Related: [[fphash-coverage-gap]], [[event-weight-registry]].
