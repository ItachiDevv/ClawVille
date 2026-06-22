---
name: whitelisted-window-no-sql-injection
description: "windowToInterval maps a validated enum to a fixed literal before sql.raw; limit clamped 1..100; subject whitelisted — no user input reaches the raw scoring SQL"
category: pattern
confidence: high
date: 2026-06-22
---

The scoring CTE uses `sql.raw` for the time interval, which would be an injection vector if a raw query param reached it. It does not:

- **Window → interval:** `windowToInterval` (leaderboard.ts:517) is a closed `switch` over the validated `{24h,7d,30d,all}` enum that returns a FIXED interval literal; only that literal is passed to `sql.raw` (:657). User input never reaches the raw string.
- **Limit:** clamped to 1..100 (:963) before use.
- **Subject:** validated against a 3-value whitelist (all/players/trainers, :976) — not interpolated.

**Rule:** any new window/interval/filter/subject MUST map a validated enum to a fixed literal through a whitelist before `sql.raw`; clamp numeric bounds; never interpolate a query param into the scoring SQL. Drizzle parameterizes the bound params (the `${C.x}`/`${W.x}` template values are bound, not raw) — the ONLY raw is the whitelisted interval.

Status: VERIFIED no injection vector. Related: [[event-weight-registry]].
