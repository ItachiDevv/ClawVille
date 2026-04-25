# Reef Race — Phase 4 audit

**Audited SHA:** `c9fc37c` (`plan(reef-race): Phase 4 final — PB ghost + streak + lobster-of-the-day + match-end`)
**Plan reviewed:** `.claude/plans/reef-race-phase4-detailed.md` (921 lines)
**Phase reference:** `.claude/plans/reef-race-real-racing.md` §Phase 4
**Auditor:** orchestrator (ultrathink, no team spawn — single-author audit per request)
**Date:** 2026-04-24
**Verdict:** **NEEDS REVISION — 3 critical, 8 significant, 5 nits**

---

## Verdict summary

| Severity | Count | Examples |
|---|---|---|
| Critical | 3 | C1 discarded-lap frame contamination · C2 dailyRank race vs cache · C3 perfect-lap bonus skipped on reset-lap |
| Significant | 8 | S1 streak survives lap-up only by accident · S2 STREAK_MILESTONES count vs tier-kind union mismatch · S3 best-streak in `activity_results` is per-MATCH not per-PB · S4 PB write happens BEFORE results endpoint freezes · S5 shared rate limiter contention · S6 ghost frame `t` re-base on PB load · S7 `event.match_ended` ghost frame payload size · S8 town-guide mention is too thin |
| Nit | 5 | N1 `gen_random_uuid()` requires `pgcrypto` · N2 partial index WHERE redundant · N3 outdated SHA in plan header · N4 client-only `STREAK_MILESTONES` mirror gap · N5 frames cap math (worst-case lap can be 90s) |

Plan is mostly good (~85% solid) — the new-table decision is correct, the migration is additive, the streak mechanic is well-grounded in existing apex code, and the 5 Hz capture math holds. But three load-bearing flows have bugs that must be fixed before implementation, and a handful of edge cases need explicit handling.

---

## CRITICAL

### C1 — Discarded sub-MIN_LAP lap contaminates ghost frame buffer

**Where:** §1.4 frame capture; conflicts with `apps/api/src/services/activity/sim/reef-race-sim.ts:1543-1556`.

**Evidence:** When a body completes the start-line crossing with `lapMs < MIN_LAP_MS = 15_000`, the existing code (lines 1544-1555) flags `underminlap`, **resets `body.lapStartedAt = now`**, rolls `nextCheckpoint` back to 1, and `break`s — **without clearing `currentLapFrames`**. The plan adds the clear ONLY inside the post-validation success path (after line 1568, with `body.currentLapFrames.length = 0;` per §1.4).

**Bug.** After the reset, the next legitimate lap captures frames with `t = now - body.lapStartedAt` starting at 0. But the buffer still contains old frames with `t` values up to ~15000ms from the just-discarded attempt. When that lap eventually finishes and `bestLapFrames = body.currentLapFrames.slice()` runs, the saved replay is a Frankenstein with monotonically-decreasing-then-increasing `t` values. `findGhostFrames()` linear scan (`while … path[lo+1].t <= nowMs`) silently breaks on non-monotonic input — the ghost will appear stuck or teleport.

**Fix:** Add `body.currentLapFrames.length = 0;` to the discard branch (`reef-race-sim.ts:1554` area, before `break`). Same pattern as the lap-up clear. Also test it: §7.2 must add a case "currentLapFrames cleared on under-MIN-LAP lap discard".

**Severity rationale:** silent corruption of the canonical PB replay; only triggered by anti-cheat path but the path absolutely fires today (covered by `anti-cheat/__tests__/reef-race.test.ts:89`).

---

### C2 — `dailyRank` is computed inside results endpoint but PB write is fire-and-forget — race condition

**Where:** §1.2 (`PB write is INTENTIONALLY OUTSIDE the rewards transaction`, `void maybeUpdatePersonalBest(...)`) + §6.5 (`Daily rank is computed by ranking the row against getDailyBestLapSnapshot()`).

**Evidence:** Plan ships PB writes as fire-and-forget AFTER the rewards transaction commits. The match-end results endpoint `GET /api/activities/:id/rooms/:roomId/results` (§6.5) joins to `reef_race_personal_bests` to compute `pbDelta` and ranks against `getDailyBestLapSnapshot()` (60-second cache, §4.1).

Two race windows exist:

1. **Pre-write window.** The client receives `event.match_ended` before the PB INSERT lands (fire-and-forget). The `event.match_ended.pbDelta.newGhostFrames` payload is set INSIDE the same async callback, so the client sees a `pbDelta` with `oldMs/newMs` that the database hasn't acknowledged. If the client GETs `/results` immediately, the JOIN returns the OLD row (or null) and `pbDelta.dailyRank` is null/wrong.
2. **Cache-stale window.** `getDailyBestLapSnapshot()` caches 60s. A freshly-written PB row will not appear in the snapshot until cache expiry — meaning `dailyRank` always **reflects the previous snapshot**, never the just-set PB. The plan never says "invalidate the cache after a PB write", so the answer is permanently 1-pole behind.

**Fix:** Three changes.
- (a) PB write must complete BEFORE the `event.match_ended` payload is built. Either await `maybeUpdatePersonalBest` (it's a single `INSERT…ON CONFLICT` round-trip — sub-10ms; the "fire-and-forget" rationale in §1.2 is overcautious) or compute `pbDelta` from the pipeline's local `ReefRacePerLapResult` (which the plan already has) instead of round-tripping through the DB.
- (b) After a successful PB upsert, call `invalidateDailyBestLapCache()` (which §4.1 already exposes) so the next read sees the new entry.
- (c) Compute `dailyRank` for the just-set PB by directly querying `count(*) WHERE bestLapMs < newMs AND best_lap_recorded_at > NOW() - INTERVAL '24h'` (one indexed scan) instead of post-cache ranking. This avoids any cache dependency.

**Severity rationale:** the headline UX of Phase 4 ("🎖 #7 LOBSTER OF THE DAY" callout) is wrong on the very match that earned the rank. Players never see the achievement on the match they earned it.

---

### C3 — `perfectStreakBonusTokens` requires PB to fire — plan ties it to bestStreakThisMatch but pipeline only credits on `bestStreak >= 36`

**Where:** §3.4 reward configuration + §6.5 schema column `activity_results.best_streak`.

**Evidence:** §3.4 says `perfectStreakBonusTokens` is added to `tokensAwarded` when `bestStreakThisMatch >= TOTAL_CHECKPOINTS_PER_RACE` (36). The pipeline writes `best_streak` to `activity_results` (§6.5). But §3.3 sets `body.bestStreakThisMatch` only when `body.currentStreak > body.bestStreakThisMatch` — and `currentStreak` resets on a dirty cross.

**Edge case.** A player who hits 35 clean crosses, drifts wide on the LAST hairpin (cp 9 of lap 3), gets verdict 'wide' on apex, then crosses cp 9 — the cross is clean by §3.1 logic IF the apex verdict was clean, NOT clean if 'wide'. So:
- Last hairpin verdict = wide → cross 9 is dirty → streak resets to 0 → `bestStreakThisMatch = 35` (high-water before the reset). They miss the 36-bonus.

That's correct mechanics. BUT — the plan does NOT define behaviour when **the last 12 checkpoints (lap 3) are needed to hit 36 and the player's first lap had 0 dirty crosses but they had a forfeit/dnf at lap 2**. Per `resolveCheckpoints` (line 1492), forfeited bodies skip checkpoint resolution entirely. A pet that DNFs after streak=20 would never reach 36 but their `bestStreakThisMatch=20` is still in `body`. The pipeline reads `body.bestStreakThisMatch` even for DNF pets — so DNF=20 streak gets recorded and surfaced.

That's actually fine per spec ("best run this match"). **The actual bug:** `getStreaksByPet(roomId)` is called from `activity-room-manager.ts` AFTER `endRound()` (per §3.4 file-by-file). But `endRound` (sim.ts:797 `Array.from(state.bodies.values())`) iterates AFTER bodies have been potentially frozen. The plan never says when `state.bodies` gets cleared — if it's cleared in `endRound` (matching `bumper-shells-sim` pattern), `getStreaksByPet` returns an empty Map and the perfect-lap bonus never fires.

**Fix:** Verify the `endRound`/`removeRoom`/`state.bodies` lifecycle in sim.ts (~line 800-880). The accessor MUST read before bodies are GCed. Either (a) snapshot streaks into the SimResultRow at `computeResults()` time (cleaner — single shape returned to pipeline), or (b) explicitly call `getStreaksByPet` BEFORE `endRound` clears state. The plan's current ordering (sim runs `endRound` → room-manager calls accessors → pipeline credits bonus) is broken if `state.bodies` is invalidated by `endRound`.

**Severity rationale:** the perfect-lap bonus is the carrot for the entire streak mechanic. If it silently doesn't fire, players grind for nothing.

---

## SIGNIFICANT

### S1 — Streak-survives-lap-up logic is implicit, not enforced

**Where:** §3.3 ordering claim ("apex resolves BEFORE checkpoints").

**Evidence:** Plan claims streak survives lap boundary if the lap-up checkpoint is clean (test at §7.4 last bullet). Code path: at lap-up, `body.apexCheckedThisLap.clear()` runs at sim.ts:1567 INSIDE the cp-resolution block. The plan's `lastApexVerdictByHairpin` Map is keyed by `cpIdx`, NOT by `(lap, cpIdx)`. After lap-up, the Map keeps stale verdict from the PREVIOUS lap's hairpin 9. If the player IMMEDIATELY enters cp 9 of the NEW lap before resolveApex re-fires (it won't fire until the body re-enters the apex zone, which happens AFTER cp 9 in the elliptical-track geometry), `isCheckpointCrossClean` reads the previous lap's verdict.

**Fix.** Key the verdict map by `(lap, cpIdx)` to match `apexCheckedThisLap`'s `${lap}:${idx}` key, or clear `lastApexVerdictByHairpin` in the same `apexCheckedThisLap.clear()` block at line 1567. Plan should explicitly call this out.

---

### S2 — `STREAK_MILESTONES.length === 7` but `event.streak_milestone.kind` union has 5 members

**Where:** §3.3 (`STREAK_MILESTONES = [5, 10, 15, 20, 25, 30, 36]`) vs §6.1 (`kind: 'tier-1' | 'tier-2' | 'tier-3' | 'tier-4' | 'perfect'`).

**Evidence:** 7 milestones, 5 tier kinds. Plan never says how 7→5 maps. Implementation will likely default extra milestones to `'tier-4'` and call it a day, but ambiguity = bug surface.

**Fix:** Either widen the union (`'tier-1'..'tier-6' | 'perfect'`) or compress milestones to `[5, 10, 20, 30, 36]` (5 entries → 5 tiers). Pick one and write it down.

---

### S3 — `activity_results.best_streak` semantics: per-MATCH or per-PB?

**Where:** §6.5 `ALTER TABLE activity_results ADD COLUMN best_streak`.

**Evidence:** `activity_results` is per-match (one row per finish). The plan stores `bestStreakThisMatch` here. But the §3 streak counter is described in player-facing copy as "best streak" (HUD reset flash, results screen). Players will read this as a personal record; the column name "best_streak" is ambiguous.

**Fix.** Rename to `match_best_streak` (column) and `streakBest` (response field — already in plan). Doc same diff in `ARCHITECTURE.md`.

Also: `activity_results.best_streak` is column-additive but the column is set ONLY for `reef-race` rows. That's fine, but the column name communicates "always meaningful". Add a comment to the schema explaining "Reef Race only; null for other activities".

---

### S4 — PB write atomicity vs concurrent room-end

**Where:** §1.2 + §8 risk table ("DB write at match end").

**Evidence:** Two concurrent matches could finish at the same scheduler tick (two rooms processed back-to-back by the same room-manager loop). Both call `maybeUpdatePersonalBest(pet=A)` for the SAME pet (Phase 5+ feature: a player races in two rooms simultaneously? Today the schema says one room per pet, but cross-room concurrency from spectate-then-replay could collide). The plan's `INSERT…ON CONFLICT…WHERE EXCLUDED.best_lap_ms < existing.best_lap_ms` is atomic at the row level, so the DB protects integrity. **But** the GHOST_REPLAY_DATA blob is replaced wholesale on UPDATE — a concurrent write where pet A wrote a fresh ghost and pet B's older lap still wins the predicate would NOT happen (predicate filters), so the blob is consistent. ✓ DB-level safe.

**HOWEVER:** the cache in `loadPersonalBestGhostFrames` (§1.6, "5-min in-memory `Map<petId, …>` TTL") has NO invalidation on write. Player sets a new PB → reconnects within 5 min → snapshot.init returns the OLD ghost from cache. They never see their own freshly-set PB ghost until the cache expires.

**Fix:** Either `invalidate(petId)` from `maybeUpdatePersonalBest` after a successful upsert, or drop the cache entirely (PB load is a single-row PK lookup; <2ms; ~8 reads per match start). Caching this is premature optimization.

---

### S5 — Shared rate limiter with `/agents` route

**Where:** §4.2 ("Same rate limiter as `/agents`").

**Evidence:** `apps/api/src/routes/leaderboard.ts:613` defines `agentLeaderboardLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 })`. Plan reuses this same instance for `/reef-race/daily-best-lap` (§4.2 code snippet uses `agentLeaderboardLimiter.check(ip)`).

**Bug:** A single browser tab renders both `/leaderboard` (tabbed UI from §4.3) — the React-Query refetch on tab-switch hits both `/agents` AND `/reef-race/daily-best-lap`. With 60s server cache, the staleTime barrier is fine, but background tab reactivation + window-focus refetch = 2 hits per minute per tab. Power users with multiple tabs blow through 60/min/IP fast. Result: rate-limit floods on legit traffic.

**Fix:** Define a NEW limiter `dailyBestLapLimiter` (60/min) so the two endpoints don't share a bucket. Or bump `agentLeaderboardLimiter` to 120/min and document.

---

### S6 — Ghost frame `t` re-base on first replay

**Where:** §1.5 lap-relative `t` decision + §2.5 client behaviour.

**Evidence:** Plan stores `t = now - body.lapStartedAt`, so the FIRST frame has `t > 0` (the first capture happens at tick % 6 == 0; `lapStartedAt` is set at `startedAt` in `addBody`, line 575). If frame capture starts at tick 6 (200ms after race start), the first frame's `t` is 200. The client's `findGhostFrames(path, ghostMs)` uses `path[0].t` as the time origin (line 110: `path[0].t + (elapsedMs % pathDuration)`). That's mathematically OK — the client lerps from frame 0 onward — but the ghost will visibly "start late" by ~200ms vs. the player's own kart (which is frame 1 from `t=0`).

**Fix:** Capture the first frame at `body.lapStartedAt` (insert one synthetic frame with `t=0, x=startX, z=startZ, rot=startRot` when `currentLapFrames.length === 0`). Or document that ~200ms drift is the ghost's start-line delay (visually invisible at 60 FPS). Either way, decide and write it down.

---

### S7 — `event.match_ended.pbDelta.newGhostFrames` payload size

**Where:** §6.4 `RewardPreview.pbDelta.newGhostFrames?: GhostFrame[]`.

**Evidence:** Plan computes ~5 KB per ghost (5 Hz × 30s × 24B). `event.match_ended` fires per pet over WS. For an 8-pet match, total broadcast = 8 × 5 KB = 40 KB at match end. WS frame size is fine. **But:** if the event is broadcast room-wide (not just to the pet that earned the PB), other players receive 35 KB of useless data.

**Fix:** `event.match_ended` already has per-pet payload semantics — verify `pbDelta.newGhostFrames` is included ONLY in the SELF pet's match-end (i.e., the protocol ships per-pet match-end frames addressed to specific WS, not a single broadcast). If broadcast, gate on recipient identity.

Re-reading §6.4: `event.match_ended` carries a single `RewardPreview`. If it's broadcast, every spectator gets every PB ghost. **Critical clarification needed**: is it `for each pet, send their event.match_ended only to that pet` (good), or `broadcast event.match_ended for each pet to all sockets` (bad — N² bandwidth)?

The plan must make this explicit and reference the existing pattern (likely per-recipient via `safeSend(ws)` not `broadcastFn`).

---

### S8 — Town Guide knowledge entry is too thin

**Where:** §9 file-by-file table ("`packages/agent-templates/src/locations/town-guide.ts` MOD orchestrator +6").

**Evidence:** 6 lines for "Lobster of the day surface + perfect-lap bonus". Per `CLAUDE.md`'s mandatory town-guide-knowledge-sync rule, Nori's `knowledge[]` MUST cover: PB ghost, streak counter, perfect-lap bonus tokens, daily leaderboard surface (where to find it: /leaderboard tab), how it differs from the agents leaderboard.

**Fix:** Plan must enumerate 4-5 distinct `knowledge[]` entries (one per surface), not "+6" anonymous lines. Otherwise the rule will be perfunctorily satisfied.

---

## NITS

### N1 — `gen_random_uuid()` requires `pgcrypto`

§10.2 SQL uses `DEFAULT gen_random_uuid()`. PostgreSQL ≥ 13 ships this in the `pgcrypto` extension which Supabase enables by default — verified by checking other migrations (`packages/database/drizzle/meta/0002_snapshot.json` has many uuid PKs). Non-issue for prod; flag for completeness.

### N2 — Partial index WHERE clause is redundant

§10.2 partial index `WHERE activity_id = 'reef-race'` is harmless but redundant since the column has a `DEFAULT 'reef-race'` and the plan never inserts another activityId. Remove the WHERE for a smaller index def, or keep it to make the intent clear (recommend keep).

### N3 — Plan header status

§3 calls Phase 1 "merged"; Phase 2 "merged"; Phase 3 "merged". Verified: `git log` shows `5fa9ebb feat(reef-race): Phase 3 — stat connection`. ✓ accurate.

### N4 — Client-side STREAK_MILESTONES mirror

§3.3 says "clients need a parallel constant set ONLY for the HUD label". Where? §3.5 reads `selfStreak` from store but doesn't reference any milestone constant for the glow tier mapping. Either thread the `kind` from `event.streak_milestone` into the entity delta (server already sends it in the event payload) and read THAT, or add a client-side `STREAK_MILESTONE_TIERS` map. Decide and document.

### N5 — Frame cap math vs worst case

§1.4 says "250 frames cap = 50 sec lap @ 5 Hz" and §8 risk row says "lap is ~25-35 sec". `REEF_SOFT_TIMEOUT_MS = 90_000` is for the WHOLE 3-lap race, but a SINGLE lap has no time cap — only the race does. A player who accidentally drives backwards into a hazard and is slowed to 15 wu/s could spend 75+ seconds on one lap. The 250-frame FIFO `shift()` would silently lose the first ~25 seconds of frames, breaking interpolation continuity (gap from lost frames to first kept frame).

**Mitigation:** Either bump the cap to `Math.ceil(REEF_HARD_TIMEOUT_MS / 200) = 450` (still 11 KB worst case, fine), or accept the data loss with a comment ("PB lap by definition is the player's fastest, so the worst-case frame budget is never the saved one — we're capping the WORK of capture, not the SIZE of the saved blob"). The latter is correct reasoning; the plan should write it down.

---

## Brand alignment check

Per `reef-race-real-racing.md` §Phase 4, the four deliverables are:
1. PB ghost — ✓ §1-2.
2. Streak counter on HUD + bonus tokens for 100% perfect — ✓ §3.
3. Daily fastest lap on `/leaderboard` — ✓ §4.
4. Match-end screen surfaces all 3 goal results — ✓ §5.

Plan covers all four explicitly. Will players FEEL it?

- **PB ghost:** invisible until the player has set ONE prior PB. First-ever Reef Race match has no ghost — the headline mechanic is silent for new players. Acceptable (mirrors Mario Kart Time Trials).
- **Streak counter:** HUD chip + glow + reset flash at milestones is the right feedback intensity. Risk: the chip competes with the placement tile + power-up bar + drift sparks. Visual hierarchy review needed in implementation.
- **Lobster of the day:** `/leaderboard` tab is well-placed; "🦞 LOBSTER OF THE DAY" gold card is a flex worth pursuing.
- **Match-end:** three optional sections (PB delta, streak best, daily rank) sandwiched into existing modal. Risk of visual clutter — the modal already has placement banner + portrait + stats + podium + rewards + CTAs. Adding three more conditional blocks pushes scroll. **Recommendation:** mockup the worst case (all three fire) before implementation.

---

## Test coverage gaps

§7 covers PB persistence, frame capture, streak, daily leaderboard, match-end results. Missing:

- **Sub-MIN-LAP discard frame-buffer cleanup** (the C1 fix): "currentLapFrames cleared on under-MIN-LAP lap discard".
- **Perfect bonus + DNF**: pet streaks to 35, DNFs at lap 2 → no perfect bonus, but `bestStreakThisMatch=35` surfaced.
- **Daily-rank cache invalidation** (the C2 fix): write a PB, immediately re-query `getDailyBestLapSnapshot()`, assert new entry visible.
- **Concurrent PB writes** (S4): two pets finish in the same scheduler tick, both fire PB writes for the same pet (synthetic test against the cache layer).
- **Snapshot.init for guest sockets** (Phase 5+ guests): no `ws.data.identity.petId` → no PB load → no error.
- **Streak survives lap boundary** (S1 fix): plan §7.4 includes this case but the fix needs the (lap, cpIdx) keying — test against the keying.

---

## Recommendations

1. **Fix C1, C2, C3 before merging.** The discarded-lap bug, the dailyRank race, and the streak-state lifecycle are silent corruption / silent feature-loss bugs.
2. **Plan v2 needed**, addressing Critical + Significant items. Estimated +50 lines of plan delta (key the verdict map by lap, define cache invalidation, snapshot streaks into SimResultRow, define ghost-frame addressing semantics).
3. **Then re-audit.** Same dimensions; quick pass.
4. **Before implementation, lock the four plan ambiguities** (S2 tier kinds, S6 first-frame timing, S7 broadcast semantics, N4 client-tier-mapping source).
5. **Mockup the match-end modal** at maximum density before writing modal CSS. The three-section pile risks overflow on small screens.

The bones are right. The new table is the correct call. Once the critical bugs are fixed, this ships a cohesive Phase 4 — PB ghost will haunt every lap, the streak chip will light up the HUD, and the daily-fastest leaderboard finally gives competitive replay value.

---

**Final verdict — NEEDS REVISION (3 critical, 8 significant, 5 nits).** Re-issue plan v2; re-audit before implementation.
