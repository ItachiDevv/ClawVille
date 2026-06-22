---
name: scoring-cte-dual-leg-lockstep
description: "agent_daily and avatar_daily are disjoint subject tiers that must stay byte-for-byte symmetric; the agent.connected per-day session cap is midnight-safe only because it is a POINT event"
category: pattern
confidence: high
date: 2026-06-22
---

`buildAgentSnapshot` (leaderboard.ts:555) builds TWO near-duplicate inner CTEs UNION'd onto one board: `agent_daily` (events with `agent_id IS NOT NULL` = openclaw-bound Trainers, :599) and `avatar_daily` (events with `agent_id IS NULL AND avatar_id IS NOT NULL` = Player-tier, :660). They are DISJOINT subject sets, so no double-count, but they must stay BYTE-FOR-BYTE symmetric: a new scored FILTER column, a cap, or the activity proportional-cap math added to ONE leg only silently zero-scores the OTHER cohort. The code carries an in-line 'KEEP IN LOCKSTEP with agent_daily' comment (:705) on the land columns — extend that discipline to every edit. The score terms also mirror (agent_scores ‖ avatar_scores) and the breakdown shaping mirrors.

**Midnight-safe POINT-event capping:** session credit = `LEAST(COUNT(DISTINCT session_id) FILTER (WHERE event_type='agent.connected'), C.session)` per day (:603). This is midnight-safe ONLY because `agent.connected` is a POINT event — one row per connect, fresh session_id, single timestamp — so each session_id lands in exactly one day and is never double-counted across the boundary (:595 comment: the old 'sessions outside the daily CTE' guard was only needed for multi-row-per-session spanning, which doesn't occur here). On top, the emission side coalesces (`shouldEmitAgentConnected`, 60s/fp, event-logger.ts:340). Do NOT fold a multi-row-per-session event into the same per-day distinct-session cap without re-deriving midnight safety.

**Rule for a new scored event:** add the FILTER column to BOTH legs, the cap, the score term to BOTH agent_scores AND avatar_scores, and the breakdown shaping — all same-diff.

Status: VERIFIED present (both legs + lockstep comment). Related: [[event-weight-registry]], [[activity-proportional-cap]].
