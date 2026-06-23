---
name: event-weight-registry
description: "The canonical contribution-scoring scheme (weights + caps) is single-sourced in leaderboard.ts; the legacy composite board is a separate surface; land weights import from @clawville/shared"
category: pattern
confidence: high
date: 2026-06-22
---

ClawVille Priority #3 is a free contribution-based leaderboard; rank is computed from the `events` spine by `buildAgentSnapshot` (leaderboard.ts:555). Weights/caps are canonical + single-sourced.

**Two boards, do NOT conflate:** Priority #3 `GET /api/leaderboard/agents` (:953 — public, event-weighted, events-only, 60s/window cache cap 500, max-age=30 swr=60, 60/min/IP dedicated limiter, unified agent+avatar rows with chips) vs legacy composite `GET /api/leaderboard`+`/stats` (:1105 — auth'd, avatars-only, COMPOSITE_WEIGHTS gold1/earned1/skillsSold500/skillsAuthored250/quests300/bounties400, reads DOMAIN tables, 30s, pre-pivot modal). Editing one does NOT touch the other.

**Canonical numbers (re-read leaderboard.ts):** AGENT_SCORE_WEIGHTS (:370) buildingVisit 3 / teacherChat 10 / collaboration 40 / skillFetch 1 / session 1 / identityIssued 5. ACTIVITY_PLACEMENT_WEIGHTS (:387) 1st 12 / 2nd 6 / 3rd 3 / default 1. DAILY_CAPS (:416) building 10 / teacherChat 50 / collaboration 50 / skillFetch 11 / activity 10 / session 10 (identity.issued = 0/1 MAX, not count-capped). Land (:446, imported @clawville/shared) parcel.purchased 5/cap5, structure.placed 3, structure.upgraded 5; land.service.sold 40/cap50 defined-but-unwired (no service routes). Q3 §2.4 rationale: learning > arcade.

**Single-source rule:** a weight/cap change updates (1) the leaderboard.ts constant, (2) CLAUDE.md Brand-Identity line, (3) ARCHITECTURE.md §Observability, (4) Nori town-guide.ts (file to knowledge-orientation), (5) SKILL.md/hosted-runtime if stated. Land weights live in @clawville/shared so the buy/place/upgrade routes that GATE events and the scoring CTE can't drift — change them THERE. The web /leaderboard page hard-codes WEIGHTS/HINTS/ScoringLegend (UI-drift risk — same-diff or move to shared).

**getAgentLeaderboardEntry (:498)** reuses the 60s snapshot so the Hatcher partner stats endpoint shows the SAME score+rank publicly. Caveat: returns null for agents ranked > 500 (snapshot cap).

Status: LIVE staging+prod (Priority #3). Related: [[scoring-cte-dual-leg-lockstep]], [[activity-proportional-cap]].
