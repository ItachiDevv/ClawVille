# Reef Race — Phase 4 IMPLEMENTATION audit

**Audited SHA:** `9ed3e93` (`feat(reef-race): Phase 4 §1,3-7 PB persistence + streak + daily lobster + match-end + tests`) + `2924c4a` (`feat(reef-race): Phase 4 §2 PB ghost mesh — adapt ReefRaceGhost to selfBestLapGhost`).
**Range:** `git diff 6d5c23f..9ed3e93 -- apps/ packages/`.
**Plan v2 reviewed:** `.claude/plans/reef-race-phase4-detailed.md` (SHA `ebd47eb`, 1172 lines).
**Auditor:** orchestrator (ultrathink, single-author).
**Date:** 2026-04-25.
**Verdict:** **NEEDS REVISION — 4 critical, 7 significant, 5 nits.**

---

## Verdict summary

| Severity | Count | Examples |
|---|---|---|
| Critical | 4 | C-IMPL-1 modal §5 not implemented · C-IMPL-2 leaderboard `/leaderboard` page tab not implemented · C-IMPL-3 streak HUD chip not implemented · C-IMPL-4 drizzle journal not updated for migration 0005 |
| Significant | 7 | S-IMPL-1 sim broadcasts empty `event.match_ended` BEFORE per-recipient one (clients see `tokens=0` flash) · S-IMPL-2 PB write happens for DNFers w/ flagCount=0 (anti-cheat carve-out incomplete) · S-IMPL-3 GHOST_SAMPLE_HZ=10 client constant stale (server now 5) · S-IMPL-4 streak resets to 0 on first non-hairpin cross of NEW pet (no apex verdict yet) · S-IMPL-5 client `selfStreak` doesn't reset visually on dirty cross (no flash CSS) · S-IMPL-6 ghost sample at race start lands at `t=now-startedAt`, not `t=0` (S6 partially fixed) · S-IMPL-7 `event.streak_milestone` re-fires if streak drops to 0 then back up to milestone (no edge dedupe) |
| Nit | 5 | N-IMPL-1 daily-best query reads `pets.wallet_address` not `wallets` table (plan §4.1 said join wallets) · N-IMPL-2 anti-cheat skip wires through `reefRaceSim.getFlagCount` after computeResults → reward-pipeline call (cross-module hard import) · N-IMPL-3 ghost cache TTL holds null result for 30s on DB error (recovery delay) · N-IMPL-4 `_dailyInvalidations` hardcoded counter in test never resets → side effects between tests · N-IMPL-5 `event.match_ended` is broadcast TWICE in Reef Race rooms (sim's empty broadcast + pipeline's per-recipient) |

---

## ✅ What plan v2 promised AND code delivered (verified)

### C1 fix — discard branch frame clear
`apps/api/src/services/activity/sim/reef-race-sim.ts:1685` clears `body.currentLapFrames.length = 0` in the sub-MIN_LAP discard branch before `break`. Re-anchors with synthetic `t=0` frame at line 1687-1692. Also `lastApexVerdictByHairpin.clear()` at line 1696 (S1 belt-and-suspenders). **Test exists** at `reef-race-sim.test.ts:2457` (P4-T2). ✓

### C2 fix part 1 — awaited PB write
`apps/api/src/services/activity/reward-pipeline.ts:319-331` — `Promise.allSettled` over per-pet PB writes is AWAITED before the rewards transaction begins. ✓

### C2 fix part 2 — dailyRank via direct indexed scan
`apps/api/src/services/activity/reef-race-personal-best-service.ts:180-191` — single `SELECT count(*)::int + 1 AS rank ... WHERE best_lap_ms < $1` runs in the SAME async chain as the upsert. Returns null when rank > 100. ✓

### C2 fix part 3 — daily-best-lap cache invalidated on PB write
`reef-race-personal-best-service.ts:198` — `invalidateDailyCacheLazy()` called after successful upsert. Lazy import avoids circular dep. **Test exists** at `reef-race-personal-best-service.test.ts:227` (P4-T12). ✓

### C2 fix part 4 — dailyRank persisted to `activity_results.match_pb_daily_rank`
`packages/database/src/schema/activity-results.ts:89` adds `matchPbDailyRank` integer column. Pipeline writes it at `reward-pipeline.ts:431`. `/results` route reads it at `apps/api/src/routes/activities.ts:708`. ✓

### C3 fix — streaks + ghost frames embedded into SimResultRow at computeResults() time
`reef-race-sim.ts:855-913` — `computeResults()` walks `state.bodies` while ALIVE and embeds `reefRace: extractReefRaceBlock(body)` into each result row. The reward pipeline reads from `simResults[i].reefRace` (no live-state accessor). Helper at `reef-race-sim.ts:2699`. **Test exists** at `reef-race-sim.test.ts:2538` (P4-T4). ✓

### S1 fix — `lastApexVerdictByHairpin` keyed by `(lap, cpIdx)`
`reef-race-sim.ts:2123-2127` keys with `${body.lap}-${cpIdx}`. Cleared at lap-up boundary (line 1696, 1736). ✓

### S4 fix — PB-ghost cache invalidation on write
`reef-race-personal-best-service.ts:196` — `invalidatePbGhostCache(input.petId)` called on successful upsert. ✓

### S5 fix — separate `dailyBestLapLimiter`
`apps/api/src/routes/leaderboard.ts:624-627` — declared NEW limiter, not shared with `agentLeaderboardLimiter`. ✓

### S7 fix — per-recipient match-end via `sendToPet`
`reward-pipeline.ts:823-861` — `emitPerRecipientMatchEnd` iterates `for (const r of issued)` and calls `matchEndDeliveryFn(room.id, r.petId, frame)` which routes to `activityWsHub.sendToPet`. ✓

### S8 fix — 4 substantive town-guide knowledge entries
`packages/agent-templates/src/locations/town-guide.ts:67-70` — 4 multi-sentence entries covering PB ghost, streak counter, Lobster of the Day, match-end summary. ✓

### Snapshot.init carries selfBestLapGhost (per-recipient)
`apps/api/src/services/activity/activity-ws-hub.ts:553-568` awaits `loadPersonalBestGhostFrames(ws.data.identity.petId)` and embeds in `RoomMeta.selfBestLapGhost`. Per-recipient by construction. ✓

### PB ghost client component
`apps/web/src/lib/three/activities/reef-race/ReefRaceGhost.tsx` — module-scope geometry/material, FEATURE_GATE comment present (line 24-30), localStorage gate `clawville.reef.showPBGhost`, fade in/out at lap-loop boundaries. Mounted in `ReefRaceScene.tsx:278`. Subscribes to `s.reefRace?.selfBestGhostPath` from store. ✓

### Type system
- `bun --bun tsc --noEmit` passes for `apps/api`, `apps/web`, `packages/database`, `packages/shared` (all exit 0). ✓

### Tests pass
- `reef-race-personal-best-service.test.ts`: 6 pass / 0 fail. ✓
- `reef-race-daily-best-service.test.ts`: 5 pass / 0 fail. ✓
- `reef-race-sim.test.ts`: 106 pass / 0 fail (includes P4-T1..T4 ghost + C1 fix tests). ✓
- `reward-pipeline.test.ts`: 26 pass / 0 fail. ✓

---

## CRITICAL

### C-IMPL-1 — `activity-results-modal.tsx` Phase 4 §5 sections NOT implemented

**Where:** `apps/web/src/components/game/activity-results-modal.tsx` (UNCHANGED in commit range — `git diff 6d5c23f..9ed3e93 -- apps/web/src/components/game/activity-results-modal.tsx` returns ZERO bytes).

**Plan reference:** §5.2 (PB delta block, streak section, daily rank section), §5.5 ("Replace the hard-coded `'BUMPER SHELLS'` at line 649"), §9 file-by-file table (`activity-results-modal.tsx MOD orchestrator +90`).

**Evidence:**

1. Line 649 still hard-codes `BUMPER SHELLS` for every activity:
   ```tsx
   <div style={{ ... }}>
     {petName}
   </div>
   <div style={{ ... }}>
     BUMPER SHELLS
   </div>
   ```
   Reef Race players see "BUMPER SHELLS" subtitle on their match-end modal — wrong activity name on a UX-critical surface. Plan §5.5 explicitly called this out as a "found a stale string while reading the file, fix it now" zero-laziness fix.

2. The "PHASE 6 — NEW callout" block at line 794 still renders the legacy `⭐ NEW PERSONAL BEST ⭐` text-only callout. Plan §5.2(a) requires replacing it with a Reef-Race-specific PB delta block (`🏆 NEW PERSONAL BEST  12.34s (was 12.89s, −0.55s)`).

3. NO streak section anywhere. NO daily rank section. NO `streakBest`, `pbDelta`, `matchBestStreak`, `matchPbDailyRank`, `perfectLapBonus` reads in the entire modal file (verified via Grep — count = 0).

4. Store has `lastMatchPbDelta`, `lastMatchStreakBest`, `lastMatchDailyRank`, `lastMatchPerfectLapBonus` populated correctly from `event.match_ended` (`activity.ts:790-804`), but NO consumer in the modal reads them. The data lands in zustand and dies there.

**Severity rationale:** The match-end summary IS the headline UX of Phase 4 ("PB delta + perfect-line streak + daily rank — players see the achievement on the match they earned it"). Without the modal extension, the entire Phase 4 reward loop is invisible to users. The server PERSISTS the data (`match_pb_daily_rank`, `match_best_streak` columns), the WS DELIVERS it (`event.match_ended.rewardPreview.{pbDelta, streakBest, perfectLapBonus}`), the store STORES it — but the modal never RENDERS it. Scaffolding-theater violation per CLAUDE.md.

**Fix:** Implement §5.2 (a/b/c) sections + §5.5 activity label fix. Wire `selfDailyBestLapRank`/`lastMatchStreakBest`/`lastMatchPbDelta` into conditional render blocks. Fix the "BUMPER SHELLS" hard-coded label. ~90 lines per the plan estimate.

---

### C-IMPL-2 — `/leaderboard` "Lobster of the Day" tab NOT implemented

**Where:** `apps/web/src/app/leaderboard/page.tsx` (UNCHANGED — `git diff 6d5c23f..9ed3e93 -- apps/web/src/app/leaderboard/` returns ZERO bytes). Grep for `lobster|Lobster|daily-best-lap|reef-race` in the file returns 0 hits.

**Plan reference:** §4.3 ("Add a TAB GROUP at the top with two tabs: Agents (existing) | Lobster of the day 🦞 — fetches `GET /api/leaderboard/reef-race/daily-best-lap`, renders a single ranked list..."), §9 file-by-file table (`apps/web/src/app/leaderboard/page.tsx MOD orchestrator +120`).

**Evidence:** The route handler `GET /api/leaderboard/reef-race/daily-best-lap` IS implemented (`apps/api/src/routes/leaderboard.ts:696-731`), the aggregator IS implemented, the cache invalidation works, the rate limiter is separate (S5 fix), tests pass — BUT no UI surface fetches the endpoint. Players who set a daily-best lap have no way to see the leaderboard from inside the game.

**Severity rationale:** Brand priority #4 ("Gamified UI + free promotion + unified leaderboard"). The "Lobster of the Day 🦞" gold card surface is the social-proof flex that makes daily-best laps motivating. Without the UI, the leaderboard ENDPOINT is a tree falling in an empty forest. Same scaffolding-theater violation as C-IMPL-1.

**Fix:** Implement §4.3 — add tab group, daily-best-lap fetch hook (`useQuery` with `staleTime: 60_000`), ranked-row component, gold-bordered #1 card, empty-state copy.

---

### C-IMPL-3 — Streak HUD chip NOT implemented

**Where:** `apps/web/src/components/game/reef-race-hud.tsx` (NOT in commit's file-touched list). Grep for `selfStreak|reef-race-streak-counter|StreakCounter|streak-chip` in `apps/web/src/components/game/` returns ZERO hits.

**Plan reference:** §3.5 ("Read `useActivityStore((s) => s.reefRace?.selfStreak ?? 0)`. Render a small chip near the placement tile (top-right of HUD): `🔥 STREAK: 7`. Light up at milestones using the SHARED tier kind from `streakMilestoneKind(streak)`..."), §9 file-by-file table (`reef-race-hud.tsx MOD orchestrator +35`).

**Evidence:** The store HAS `selfStreak` (populated correctly from `EntityDelta.changed.streak` at `activity.ts:720`). The shared `streakMilestoneKind` helper is exported at `packages/shared/src/activities/reef-race-streak.ts:46`. The server emits `event.streak_milestone` with the kind. **No component anywhere reads `selfStreak` for HUD render.**

**Severity rationale:** Players have no visual feedback for the streak mechanic mid-race. The +25 perfect-lap bonus (which IS credited correctly server-side) becomes a black-box reward — players don't know why they got it because they couldn't watch the streak counter climb. Brand priority #4 ("the streak chip will light up the HUD"). The streak mechanic IS the carrot for the entire Phase 4 hairpin discipline loop.

**Fix:** Implement §3.5 — small chip component, CSS class table indexed by `streakMilestoneKind` tier (tier-1 amber → perfect rainbow), reset flash CSS keyframe (200ms `streak-reset`). Mount in `reef-race-hud.tsx`.

---

### C-IMPL-4 — Drizzle journal NOT updated for migration 0005 (pre-existing breakage extends)

**Where:** `packages/database/drizzle/meta/_journal.json` ends at entry `idx: 2` (`0002_lively_thunderbolt_ross`). The file system has `0003_activity_results_acknowledged_at.sql`, `0004_guest_pet_columns.sql`, AND the new `0005_reef_race_personal_bests.sql` — none registered in the journal. The plan's §9 explicitly listed `packages/database/drizzle/meta/0005_snapshot.json` as a NEW file expected to be generated; it is NOT in the diff.

**Plan reference:** §10.3 migration ordering ("Migration 0005 lands first... `bun run db:push` applies cleanly").

**Evidence:** `bun run db:push` (the documented path per CLAUDE.md "Database migrations") uses schema introspection and bypasses the journal — so `db:push` against a fresh prod DB WOULD create the `reef_race_personal_bests` table. BUT the migration file SHIPS in the repo without being acknowledged by the migrator. Anyone running `drizzle-kit migrate` (e.g. local dev, CI, future migration ordering enforcement) gets a silent no-op for 0003/0004/0005 — the table won't exist.

**Severity rationale:** This is partly a pre-existing bug (0003 + 0004 also missing from journal), but Phase 4's `0005` ships in the same broken state. Plan §10 explicitly promised the snapshot.json + journal entry. Production DB will work via `db:push`, but any environment that runs `drizzle-kit migrate` (testing rigs, future migration tooling) silently misses Phase 4's table.

**Fix:** Run `bun run db:generate` from `packages/database` to backfill journal entries for 0003, 0004, AND 0005, plus generate the missing `0005_snapshot.json`. Otherwise the migration story is "works on prod via db:push but breaks `drizzle-kit migrate`" — a quiet trap.

---

## SIGNIFICANT

### S-IMPL-1 — Sim broadcasts empty `event.match_ended` BEFORE per-recipient one (clients see `tokens=0` flash)

**Where:** `reef-race-sim.ts:1920-1936` — `endRound` broadcasts a generic `event.match_ended` via `this.broadcastFn` (which routes to `activityWsHub.broadcastEvent`, fanning out to all room WSs) with `tokens: 0, leaderboardPoints: 0`. THEN, after the room manager's `transitionRoom('results')` finishes (which runs the reward pipeline async), `emitPerRecipientMatchEnd` sends the SECOND `event.match_ended` per pet via `sendToPet`.

**Bug:** The client's `applyServerFrame` `event.match_ended` handler at `apps/web/src/stores/activity.ts:767-807` runs TWICE in quick succession:
1. First payload: `tokens=0, leaderboardPoints=0, no pbDelta, no streakBest`. Sets `matchPhase: 'ended'`, `rewardPreview: {placement, tokens:0, leaderboardPoints:0}`. The match-end modal opens with "0 tokens" displayed.
2. Second payload (~50–500ms later, depending on PB write + DB roundtrip): authoritative numbers.

The user sees "PLACEMENT #3 / +0 tokens / +0 points" briefly before it flips to "+30 tokens / +25 points / +25 perfect bonus / NEW PERSONAL BEST 12.34s". UX flash flickers on every Reef Race match-end.

**Fix.** Either:
- (a) Suppress the sim's generic `event.match_ended` for Reef Race (let the reward pipeline own the broadcast). Easy: `if (state.activityId !== 'reef-race') this.broadcastFn(state.roomId, {...})`.
- (b) Suppress the client-side write when `rewardPreview.tokens === 0 && rewardPreview.leaderboardPoints === 0` — racy, hides legitimate bot-only matches.
- (c) Best — let the sim emit `event.match_started/ended` lifecycle events ONLY, and have the reward pipeline emit a SEPARATE `event.match_ended_summary` that the modal subscribes to. Cleaner separation of concerns.

---

### S-IMPL-2 — PB write filters use `flagCount > 0` but DNFers may have `flagCount=0`

**Where:** `reward-pipeline.ts:309-318` — PB candidate filter does `reefRaceSim.getFlagCount(room.id, s.petId)` and skips if `flags > 0`. This calls `state.flagCounter.countFor(petId)` (sim line 920-924) — but `state` may already have been cleared from `this.rooms` by the time the reward pipeline runs.

**Trace:**
1. Sim's `endRound` calls `endedFn(roomId)` → `activityRoomManager.transitionRoom(roomId, 'results')` → `persistResultsTransition` → `computeResultsFn(room)` → `issueRewardsForRoom`.
2. The PB candidate filter at line 315 calls `reefRaceSim.getFlagCount(room.id, s.petId)`.
3. After `transitionRoom('results')` returns, the `setEndedFn` callback chain calls `reefRaceSim.stopRoom(roomId)` which deletes the state from `this.rooms` (sim line 745).

**The race:** `getFlagCount` is called WHILE state is still alive (good), but if the chain becomes async (e.g. PB write takes 50ms, then reward credit takes another 100ms), and a DIFFERENT room's `endedFn` for the same petId fires in parallel and deletes the room first... actually that's not possible (one room per match, not per pet). False alarm on race condition.

**Real bug:** `body.flagCount` doesn't exist as a field — it's tracked in `state.flagCounter` (a separate `ReefFlagCounter`). The candidate filter correctly uses the sim accessor. BUT — Phase 4 spec §4.4 says "any pet with anti-cheat flag in the match has PB write skipped". The implementation at line 315 does this correctly. ✓

**Actual issue (re-classified Significant):** the anti-cheat-skip path requires the `reefRaceSim.getFlagCount` to remain accessible — which means `stopRoom` cannot be called BEFORE `issueRewardsForRoom` completes. The current chain is `transitionRoom('results')` (which awaits issue) → `.then(stopRoom)`. Correct ordering, but tightly coupled to the index.ts wiring. **A test that verifies stopRoom is NOT called before reward issuance completes is missing.** A future refactor that swaps the chain order would silently break the anti-cheat skip.

**Fix:** Add a test that mocks `stopRoom` and asserts it's called AFTER the PB write completes. Or refactor `getFlagCount` to read from a snapshot embedded in `SimResultRow` (mirror of C3 fix pattern).

---

### S-IMPL-3 — Client `GHOST_SAMPLE_HZ = 10` constant stale (server now 5 Hz)

**Where:** `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts:219` — `export const GHOST_SAMPLE_HZ = 10;`. Plan §1.4 explicitly: "GHOST_SAMPLE_HZ = 10 in reef-race-config.ts:219 (client-side mirror) updates to **5** in the same diff so client and server agree."

**Evidence:** Grep for `GHOST_SAMPLE_HZ` across the entire web codebase returns ONE hit — the declaration. The constant is dead — no consumer reads it. So the bug is documentation drift, not runtime behavior. But the plan promised the same-diff update; failing to do it leaves a misleading constant for the next reader.

**Fix:** Either delete the unused constant, or update to `5` per spec. One-line change.

---

### S-IMPL-4 — Streak resets to 0 on first non-hairpin cross of a NEW pet (no apex verdict yet)

**Where:** `reef-race-sim.ts:2117-2127` — `applyStreakUpdate`:
```ts
if (!isHairpin) {
  clean = true;  // non-hairpin auto-clean
} else {
  const key = `${body.lap}-${cpIdx}`;
  clean = body.lastApexVerdictByHairpin.get(key) === 'clean';
}
```

**Bug:** Consider a body that just spawned and is about to cross checkpoint 1 (non-hairpin, indices [3, 9]). Plan §3.1 says "non-hairpin checkpoints are clean automatically". So `clean = true`, streak += 1. ✓

But wait — the FIRST hairpin a body encounters is cp 3 of lap 0 (since they start AT cp 0 and head toward cp 3). If the body is moving FAST and cuts the corner outside both apex zones (inner+outer), `lastApexVerdictByHairpin.get('0-3')` returns undefined, so `clean = false` → streak resets to 0. The plan §3.1 documents this as "likely cut a corner outside both rings". ✓

**Real bug.** The plan's "test §7.4 last bullet" says "streak survives lap boundary if the lap-up checkpoint is clean". Trace through: body crosses cp 0 (lap-up). cp 0 is non-hairpin. `applyStreakUpdate(cpIdx=0)` runs BEFORE the lap-up branch (line 1661). `clean = true` for cp 0 → streak += 1. Then lap-up branch runs, increments lap, clears `lastApexVerdictByHairpin`. Next checkpoint cross (cp 1 of new lap) → `applyStreakUpdate(cpIdx=1)` → non-hairpin → clean → streak += 1. ✓ Survives lap boundary.

But what about cp 3 of NEW lap? When the body approaches cp 3, `resolveApex` (step 5b) runs first. If body passes through inner apex zone, sets `lastApexVerdictByHairpin.set('1-3', 'clean')`. Then `resolveCheckpoints` (step 7) crosses cp 3, `applyStreakUpdate(cpIdx=3)` reads `'1-3'` → clean. ✓

**Actual edge case.** What if the body crosses cp 3 in the SAME tick that `resolveApex` first registers the verdict? Both run in step 7 vs step 5b — same tick, but step 5b runs FIRST. So the verdict is set BEFORE the cross resolves. ✓

**False alarm — re-classified Nit.** Logic is sound, but the test (§7.4) does NOT exercise the lap-2 hairpin scenario (only the lap-up of cp 0). Add an explicit test for "first hairpin of NEW lap reads the freshly-set verdict (not stale lap-1 verdict)".

---

### S-IMPL-5 — Streak chip "reset flash" CSS keyframe mentioned in plan but not implemented (depends on C-IMPL-3)

**Where:** Plan §3.5 mentions "Resets to 0 visually with a brief flash (CSS keyframe `streak-reset 200ms`) when the value drops to 0 — gives the player feedback that they just lost the streak." Since C-IMPL-3 entirely skips the HUD chip, this sub-detail is also missing. Listed separately because it's a load-bearing UX detail (the FLASH is what makes the reset feel meaningful).

**Fix:** Part of C-IMPL-3 implementation.

---

### S-IMPL-6 — First ghost frame at race start is `t=0` anchor, but actual capture starts at `t = (tickCount × 1000/30)` (S6 partially fixed)

**Where:** `reef-race-sim.ts:657` — at body init, the first frame is seeded with `{t: 0, x, z: y, rot}`. ✓ S6 first-frame fix.

**But.** The first CAPTURE-tick after race start lands at `state.tick === 6` (since capture stride is 6). At that tick, `now - body.lapStartedAt = 6 × (1000/30) = 200ms`. So the SECOND frame in the array has `t = 200`. The synthetic `t=0` anchor is correct, but the gap from frame 0 to frame 1 is 200ms instead of the regular 200ms cadence — actually that's the same as steady state. ✓ False alarm.

**Re-classified Nit.** Documentation drift only — the plan §1.5 said "the first sample after `lapStartedAt` is set lands at... typically ~200ms". Implementation matches plan exactly. ✓

---

### S-IMPL-7 — `event.streak_milestone` re-fires on streak drop+climb (no edge dedupe across resets)

**Where:** `reef-race-sim.ts:2128-2143` — milestone broadcast condition is:
```ts
if ((STREAK_MILESTONES as readonly number[]).includes(body.currentStreak)) {
  this.broadcastFn(... type: 'event.streak_milestone' ...);
}
```

**Bug:** A player reaches streak=10 (tier-2 milestone fires), then drifts wide on a hairpin → streak resets to 0. They climb back to streak=10 → milestone fires AGAIN.

The plan §3.3 says "Edge-trigger event broadcast on milestone hits (5/10/20/30/36). Avoid per-checkpoint broadcasts — too noisy." The intent was edge-triggered ONCE per match per milestone — a player shouldn't get tier-2 glow twice in the same match.

**However.** Looking at the client handler (`activity.ts:1007-1018`), the milestone event just sets `selfStreak: frame.streak` and updates `selfBestStreakThisMatch`. Replaying the event is idempotent — the visual glow simply re-fires, which is arguably correct (the player DID reach 10 again). So the bug is "is this the intended semantic?"

**Decision needed.** Is "tier-2 glow fires twice if you bounce 10→0→10" a feature (rewards re-attainment) or a bug (overstates milestone density)? Plan doesn't say. Implementation chose "fires twice". The +25 perfect-lap bonus only credits if `bestStreakThisMatch >= 36` — the milestone EVENTS are decorative; the BONUS is once-per-match. So the duplicate fire is at most a glow-redundancy, not an exploit.

**Fix or document:** Add a per-(petId, kind) Set on `state` to dedupe milestone fires within a match. Or document in the plan that re-attainment re-fires the glow (intentional reward).

---

## NITS

### N-IMPL-1 — Daily-best query reads `pets.wallet_address` not `wallets.address`

**Where:** `apps/api/src/services/activity/reef-race-daily-best-service.ts:114` SQL:
```sql
SELECT ... p.wallet_address AS wallet_address
FROM reef_race_personal_bests pb
JOIN pets p ON p.id = pb.pet_id
```

Plan §4.1 specified:
```sql
LEFT JOIN wallets w ON w.subject_type = 'pet' AND w.subject_id = pb.pet_id
```

**Why this matters.** Per CLAUDE.md "Wallet Table Semantics" memory: `pets.wallet_address` is the CUSTODIAL Solana address (legacy). Plan §4.1 used `wallets` table to get the unified per-subject custodial wallet. Both columns track the same address today, so the result is identical for non-Phase-5.1 pets. Once Phase 5.1's per-pet envelope encryption is fully rolled out, the `wallets` table is the source of truth and `pets.wallet_address` may go stale. **Drift risk for the future.**

**Fix:** Switch to the `LEFT JOIN wallets` pattern per plan, OR document the deliberate divergence in a comment.

### N-IMPL-2 — `reefRaceSim` hard import in reward-pipeline

**Where:** `reward-pipeline.ts:55` — `import { reefRaceSim } from './sim/reef-race-sim';`. Plan §1.2 designed `setMatchEndDeliveryFn` callback specifically to AVOID hard imports from reward-pipeline → activity-ws-hub. The same anti-pattern is present for `reefRaceSim.getFlagCount(...)` at line 315.

**Why this matters.** Tests that mock `@clawville/database` will pull in the entire `reef-race-sim.ts` module (~2700 lines) just to exercise `computeBreakdown` or `computePlacementBase`. Slows test boot. Also couples reward-pipeline tests to sim mock surface area.

**Fix:** Add a `setFlagCountFn` callback (mirror of `setMatchEndDeliveryFn`) so reward-pipeline doesn't hard-import the sim. Or move the anti-cheat-skip check into the room-manager's `transitionRoom('results')` path, so reward-pipeline only sees pre-filtered candidates.

### N-IMPL-3 — Ghost cache holds `null` for 30s on DB error

**Where:** `reef-race-personal-best-service.ts:271` — on DB error, the cache stores `{ frames: undefined, expiresAt: now + 30_000 }`. A pet who reconnects within 30s of the transient DB error gets the cached miss back, NOT a fresh attempt.

**Why this matters.** If the DB hiccup self-heals in 5s, the player still sees no PB ghost for 25 more seconds. Acceptable for transient errors but worth noting. The 30s "miss cache" prevents retry storms — fair tradeoff.

**Fix:** Acceptable as-is. Document the trade.

### N-IMPL-4 — `_dailyInvalidations` test counter resets on `beforeEach` but is module-scoped — sibling test files can leak

**Where:** `reef-race-personal-best-service.test.ts:107-109`:
```ts
const dailyCacheInvalidations: number = 0;
let _dailyInvalidations = dailyCacheInvalidations;
```

The mock `invalidateDailyBestLapCache` increments `_dailyInvalidations`. `beforeEach` resets it to 0. Fine within this file. **But** Bun's `mock.module` IS process-scoped — if a sibling test file imports `reef-race-personal-best-service` AFTER this file's mocks register, the sibling will hit the same lazy mock. Not a bug today (no sibling imports), but a future test could break silently.

**Fix:** Acceptable as-is for now. Worth a comment when adding sibling tests.

### N-IMPL-5 — `event.match_ended` is broadcast TWICE in Reef Race rooms (counted in S-IMPL-1)

Already covered in S-IMPL-1. Listed here as a nit because the second emit is the correct one and the first is just a UX flash, not a correctness bug.

---

## What's IN the diff

`9ed3e93` + `2924c4a` together touch 32 files, +2526/-107 lines:

- **NEW server services:** `reef-race-personal-best-service.ts` (281 lines), `reef-race-daily-best-service.ts` (158 lines)
- **NEW DB schema:** `reef-race-personal-bests.ts` (112 lines), migration `0005_reef_race_personal_bests.sql` (46 lines)
- **NEW shared module:** `reef-race-streak.ts` (52 lines), protocol additions (96 lines)
- **EXTENDED sim:** +276 lines on `reef-race-sim.ts` (frame capture, streak, computeResults, extractReefRaceBlock)
- **EXTENDED reward pipeline:** +250 lines on `reward-pipeline.ts` (PB write, per-recipient match-end, perfect-lap bonus)
- **EXTENDED routes:** `+57` lines on `leaderboard.ts` (new endpoint), `+6` on `activities.ts` (extra columns in /results)
- **EXTENDED activity_results schema:** `match_best_streak`, `match_pb_daily_rank` columns
- **EXTENDED store:** `+128` lines on `activity.ts` (selfStreak, lastMatchPbDelta, lastMatchStreakBest, lastMatchDailyRank, lastMatchPerfectLapBonus, snapshot.init ghost path, match-end handler)
- **EXTENDED ghost component:** `+273/-?` lines on `ReefRaceGhost.tsx` (mounted properly + fade)
- **EXTENDED town-guide:** 4 substantive Phase 4 entries
- **NEW tests:** 5 test files added (reef-race-personal-best-service, reef-race-daily-best-service, +sibling defensive stubs in 5 existing test files)

## What's NOT in the diff

- `apps/web/src/components/game/activity-results-modal.tsx` — UNCHANGED (C-IMPL-1)
- `apps/web/src/app/leaderboard/page.tsx` — UNCHANGED (C-IMPL-2)
- `apps/web/src/components/game/reef-race-hud.tsx` — UNCHANGED (C-IMPL-3)
- `packages/database/drizzle/meta/0005_snapshot.json` — NOT GENERATED (C-IMPL-4)
- `packages/database/drizzle/meta/_journal.json` — NOT updated for entries 0003/0004/0005 (C-IMPL-4)
- `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts` — `GHOST_SAMPLE_HZ` still 10 (S-IMPL-3)
- `GameFeatures.md` / `ARCHITECTURE.md` / `3dStructure.md` — NO doc updates (CLAUDE.md mandatory same-diff doc update violation — see Brand alignment below)

---

## Brand alignment check

The four Phase 4 deliverables per `reef-race-real-racing.md` §Phase 4:

1. **PB ghost** — server capture + persistence + per-recipient delivery + client mesh ALL implemented and verified. ✓
2. **Streak counter on HUD + bonus tokens for 100% perfect** — server tracking + +25 token bonus credit ALL implemented. **HUD chip NOT implemented** (C-IMPL-3). Players grind for the bonus with no visual signal of progress. ✗
3. **Daily fastest lap on `/leaderboard`** — server endpoint + cache + invalidation + anti-cheat filter ALL implemented. **`/leaderboard` page UI NOT implemented** (C-IMPL-2). Endpoint is a tree falling in an empty forest. ✗
4. **Match-end screen surfaces all 3 goal results** — server payload (`event.match_ended.rewardPreview.{pbDelta, streakBest, perfectLapBonus}`) + store hydration ALL implemented. **Modal UI NOT implemented** (C-IMPL-1). Data lands in zustand and dies there. The `BUMPER SHELLS` subtitle still appears on Reef Race match-end. ✗

**Verdict.** The server-side Phase 4 is COMPLETE and high-quality (C1/C2/C3 all fixed correctly, S1/S4/S5/S7/S8 all addressed, tests pass, types pass). The client-side surfaces (modal, HUD chip, leaderboard tab) are MISSING. The implementation ships a server that does everything right but a client that exposes none of it to the user.

**Will players FEEL it?**

- PB ghost: **YES** — the only Phase 4 surface the player will actually experience. ✓
- Streak counter: **NO** — no HUD chip, no glow, no flash. The +25 token bonus appears in their token balance with no in-game explanation. ✗
- Lobster of the Day: **NO** — no `/leaderboard` tab, no in-game promotion. Players can hit `curl /api/leaderboard/reef-race/daily-best-lap` but no UX surface points there. ✗
- Match-end summary: **NO** — modal still says "BUMPER SHELLS" and shows the legacy `⭐ NEW PERSONAL BEST ⭐` callout. PB delta + streak + daily rank live in the store but never render. ✗

3 of 4 deliverables are 90% done server-side and 0% done client-side.

---

## Recommendations

1. **DO NOT MERGE.** The server-side work is solid; the client-side gap means Phase 4 ships as a half-feature where 75% of the player-visible surface is missing. Brand priority #4 ("Gamified UI + free promotion + unified leaderboard") is the load-bearing constraint that's violated.

2. **Implement C-IMPL-1 + C-IMPL-2 + C-IMPL-3 in the same iteration.** All three are pure client-side React work; ~300 lines total per the plan estimates. The data they need is already in the store + endpoints. No additional server work required.

3. **Fix C-IMPL-4 separately.** Run `bun run db:generate` from `packages/database` to backfill the journal for migrations 0003/0004/0005 + generate `0005_snapshot.json`. Verify the table creation works via both `db:push` AND `drizzle-kit migrate`.

4. **Address S-IMPL-1 in the same diff as the modal work.** The "tokens=0 flash" will be most visible once the modal renders authoritative numbers — fix the double-emit before users notice.

5. **Add docs same-diff.** Plan §9 explicitly listed `GameFeatures.md +30`, `ARCHITECTURE.md +25`, `3dStructure.md +12`. NONE landed. CLAUDE.md mandatory doc-update rule violation. The doc updates can wait until the C-IMPL-1/2/3 are done (since the missing surfaces would otherwise have to be documented as "scaffolded but not exposed" — confusing).

6. **Re-audit after fixes.** Same dimensions, expect Critical count to drop to 0 once the three client surfaces ship.

The bones of Phase 4 are right. Server-side implementation is high quality with all critical plan-v2 fixes verified in code. **The miss is cultural — committed the server work as "§1,3-7 done" without surfacing the §3.5/§4.3/§5 client work that the user actually sees.** Same scaffolding-theater pattern CLAUDE.md exists to prevent.

---

**Final verdict — NEEDS REVISION (4 critical, 7 significant, 5 nits).** Server quality is excellent; client surface is missing. Fix C-IMPL-1/2/3/4 + S-IMPL-1 before merging. Then re-audit.
