# Reef Race reward issuance crash — integer column rejects fractional value

**Date:** 2026-07-11
**Env:** staging (`api-staging`, `SOURCE_COMMIT=5c766ac6`, `REEF_RACE_USE_SPLINE=true`)
**Branch:** `fix/reef-reward-int-crash` off `origin/staging`
**Status:** Primary bug ROOT-CAUSE CONFIRMED + fixed. Upstream fractional source not yet pinned (a diagnostic ships with the fix to capture it on the next live race). Codex adversarial review applied. Needs a live staging reef race to confirm an `activity_results` row writes + the diagnostic fires.

## The alert
```
🚨 ClawVille API critical — source: activity-room-manager
Reward issuance failed for room ef875e24-949f-453d-8772-e379b07d658f
{ "activityId": "reef-race",
  "error": "PostgresError: invalid input syntax for type integer: \"-400865.68798828125\"" }
```

## What is actually broken (evidence, not theory)
- Staging DB, queried directly:
  - Room `ef875e24…`: `status=completed`, `started_at=04:59:42.529Z`, `ended_at=05:09:28.716Z` → **duration 586,187 ms (~9.8 min)**.
  - `select count(*) from activity_results where activity_id='reef-race'` → **0 rows, ever.**
- So **every reef race silently loses its rewards + results + leaderboard credit.** `issueRewardsForRoom` throws → `persistResultsTransition` catches it (best-effort at the FSM boundary) → the room completes but nothing is written. 100% failure.
- **Secondary observation:** the room ran 586 s vs a 120 s hard timeout (`REEF_HARD_TIMEOUT_MS = 90k + 30k`). The sim is not ending on time.

## Where it throws
`apps/api/src/services/activity/reward-pipeline.ts › issueRewardsForRoom`, inside the single `db.transaction`, writing to `integer` columns (`score`, `score_ms`, `tokens_awarded`, `leaderboard_points`) or the ledger `amount`. `-400865.68798828125` is negative + ~400 k magnitude → matches `score` (`= -totalTimeMs`).

## The paradox (why the fractional SOURCE isn't in the static path)
Traced exhaustively on `5c766ac6`:
- `room.startedAt` has exactly ONE writer — `activity-room-manager.ts:468` `room.startedAt = now` (`now = Date.now()`, integer). Type `number | null`.
- Both sims: `now = Date.now()` (integer), `totalTimeMs = now - state.startedAt` → integer. DNF score is the integer constant `-120001`.
- So `score`/`score_ms` are provably integer in source. A runtime value is arriving non-integer through a path not visible at this commit. **Not yet pinned** — the fix ships a diagnostic (logs `typeof`/value of `startedAt` and the raw reward values) so the next live race captures the real producer.
- Note (Codex #5): a fractional **number** in `startedAt` would explain the fractional score but NOT the 586 s room (`hardEndsAt = startedAt + N` stays numeric, so the timeout would still fire). A numeric **string** would explain BOTH (`string + number` concatenates → `now >= hardEndsAt` never true → no timeout; `now - string` coerces → fractional only if the string were fractional). The two symptoms may share one cause or be two bugs; the diagnostic settles it.

## Fix — two layers + non-finite hardening (Codex-reviewed)

### Layer 1 — write-boundary contract enforcement (stops the outage for ALL races)
`reward-pipeline.ts`: coerce every integer-destined value before the DB, guarding non-finite (`Math.round(NaN)=NaN` and `Infinity` survive rounding and would still crash — Codex #3):
```ts
const score = Number.isFinite(sim.score) ? Math.round(sim.score) : 0;
const scoreMs = sim.scoreMs != null && Number.isFinite(sim.scoreMs) ? Math.round(sim.scoreMs) : null;
const tokensAwarded = Number.isFinite(tokensAwardedRaw) ? Math.max(0, Math.round(tokensAwardedRaw)) : 0;
const leaderboardPoints = Number.isFinite(leaderboardPointsRaw) ? Math.max(0, Math.round(leaderboardPointsRaw)) : 0;
```
A diagnostic `console.error` fires whenever any coerced value differs from the raw, capturing the true upstream value. The PB write (`reef_race_personal_bests.best_lap_ms`, also `integer`) now rejects non-finite lap times and rounds the value (Codex #6) so a bad lap can't silently lose the PB/daily-best update.

### Layer 2 — sim source normalization (guarantees an integer time; MAY also fix the timeout)
Both `reef-race-spline-sim.ts` and `reef-race-sim.ts`:
```ts
const coercedStartedAt = Math.round(Number(opts?.startedAt));
const startedAt = Number.isFinite(coercedStartedAt) && coercedStartedAt > 0 ? coercedStartedAt : Date.now();
// ... body.totalTimeMs = Math.round(now - state.startedAt);
```
`Number()` collapses a Date/string to epoch ms; the finite+positive guard rejects NaN/±Infinity/≤0. This guarantees an integer race time. If the upstream value was a numeric string, this ALSO restores the 120 s timeout — but that is NOT proven yet (Codex #5); the diagnostic will confirm.

## Known-not-fixed / follow-up
- **MED (Codex #4):** an integer-but-implausible `startedAt` (seconds-since-epoch, monotonic clock, stale/future) is still accepted. The diagnostic surfaces anomalies; full epoch-range validation deferred as over-engineering until data shows it's needed.
- **Secondary 586 s timeout:** root cause not established by this diff (see Codex #5). Confirm on the live race whether the timeout now holds; if not, open a separate investigation into how a non-numeric `startedAt` reaches the sim.

## Before merge (money + game-flow path)
1. Push to staging → run ONE real reef race → confirm an `activity_results` row writes + vCLAW credited + capture the diagnostic's real upstream value.
2. Codex adversarial pass — DONE (no BLOCKING; #3/#6 fixed, #4/#5 documented).
3. Staging-first, then PR `staging → master`.
