---
name: activity-proportional-cap
description: "The activity tier-cap scales by LEAST(act_total,cap)/act_total; the denominator must equal the four-bucket numerator universe or honest scores deflate; bots+guests score zero"
category: pattern
confidence: high
date: 2026-06-22
---

`activity.match.placed` is scored with TIER weights (1st 12 / 2nd 6 / 3rd 3 / default 1, leaderboard.ts:387) but capped on the TOTAL placements per day, NOT per tier. The per-tier weighting is preserved by scaling `(wins*12 + silver*6 + bronze*3 + other*1)` by `LEAST(act_total, C.activity)/act_total` (cap 10/day).

**The keystone:** `act_total` (the denominator) MUST equal the union of the four numerator buckets' conditions — `placement IS NOT NULL AND payload->>'subjectType' <> 'bot'` (:638-647 agent_daily, :697-703 avatar_daily; audit finding 2026-04-28). If `act_total` counted rows outside that universe (a malformed/NULL-placement row, a bot row), `LEAST(act_total,cap)/act_total` would shrink honest scores. NULL-placement rows are excluded from BOTH numerator and denominator. `act_total = 0 → 0` (no divide-by-zero).

**Bot/guest zero-credit:** every tier bucket filters `payload->>'subjectType' <> 'bot'` (bots emit telemetry, earn no rank) and guest placements carry `payload.isGuest='true'` and are excluded. The CTE is the last line of defense — a mis-tagged subjectType from the emitter (activities-arena) could leak credit, so coordinate the payload shape with the emitter owner.

**Rule:** when editing the activity scoring or adding another tiered/proportional-capped event, keep the act_total FILTER exactly the union of the numerator buckets — never broader.

Status: VERIFIED present (IS NOT NULL clause + audit comment, both legs). Related: [[scoring-cte-dual-leg-lockstep]], [[no-farm-is-a-rank]].
