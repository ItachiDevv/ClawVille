# Reef Race — Phase 4 (FINAL) detailed implementation plan

**Status:** Plan v2 locked 2026-04-24. Addresses audit findings (C1/C2/C3 + S1/S2/S4/S5/S7/S8).
**Owners:** orchestrator (PB persistence + streak sim hooks + leaderboard route + match-end UI), 3da (PB ghost client wiring + fade), reef-race-bot (no scope — bots have no PB ghost / no streak rewards).
**Previous phases:** 1 (drift + launch boost) merged; 2 (slipstream + apex + ribbons + hazards + placement-weighted items) merged; 3 (stat connection) merged. All on master via `worktree-fix-bumper-build`.
**Plan reference:** `.claude/plans/reef-race-real-racing.md` §Phase 4.
**Audit reference:** `.claude/plans/reef-race-phase4-audit.md` (audited SHA `c9fc37c`).

---

## Changelog

### v2 — addresses audit findings (2026-04-24)

| Audit ID | Severity | Fix location in v2 |
|---|---|---|
| C1 | Critical — sub-MIN_LAP lap contaminates ghost frame buffer | §1.4 — `currentLapFrames.length = 0` in BOTH discard AND success branches |
| C2 | Critical — `dailyRank` race vs cache | §1.2 (await PB write), §1.6 (cache invalidation on write), §4.1 (separate cache from rank query), §5.4 + §6.5 (rank computed via indexed scan, not cache) |
| C3 | Critical — perfect-lap bonus may never fire | §3.4 (snapshot streaks into `SimResultRow` at `computeResults()` time, BEFORE teardown), §3.5 + §9 (no late `getStreaksByPet` accessor) |
| S1 | Streak-survives-lap-up implicit | §3.1 (`lastApexVerdictByHairpin` keyed by `${lap}-${cpIdx}` AND cleared at lap-up) |
| S2 | `STREAK_MILESTONES` count vs tier-kind union mismatch | §3.3 (compressed milestones to `[5, 10, 20, 30, 36]` matching 5 tier kinds) |
| S4 | PB ghost cache stale after write | §1.6 (`invalidate(petId)` from `maybeUpdatePersonalBest` on successful upsert) |
| S5 | Shared rate limiter contention | §4.2 (NEW `dailyBestLapLimiter` — does not share bucket with `agentLeaderboardLimiter`) |
| S7 | `event.match_ended.pbDelta.newGhostFrames` broadcast semantics undefined | §6.4 (per-recipient via `safeSend(ws)` — only the PB-setter receives their own frames; rivals get `pbDelta` minus `newGhostFrames`) |
| S8 | Town-guide knowledge "+6 lines" too thin | §9 + new §11 (4 substantive entries: PB ghost, streak counter, lobster-of-the-day, match-end summary) |

Every other section preserved from v1 with edits inlined where the fix lands. No scope downgrade. No kill switches.

---

## 0. Source-code baseline audit

Verified via Read on each cited file at the head of this plan session.

### 0.1 `ReefRaceGhost.tsx` — current behaviour

`apps/web/src/lib/three/activities/reef-race/ReefRaceGhost.tsx:1-175` (FULL FILE READ).

- Component **already implements** the runtime mechanic — clones `sea_horse.glb` via `SkeletonUtils.clone`, applies ghost transparency (`GHOST_OPACITY=0.45`, `transparent=true` on every mesh material), reads `useActivityStore((s) => s.reefRace?.selfBestGhostPath ?? null)`, runs `useFrame` interpolation between `GhostFrame` brackets, loops `(elapsedMs % pathDuration)`.
- Module-scope scratch (`_ghostPos`, `_ghostPos2`, `_ghostScratch`) — zero per-frame allocs (Iris Xe rule). `frustumCulled=false` is set after clone (Iris Xe rule). `useFrame` does only number math + `group.position` / `group.rotation` writes.
- `<Html>` label exists with `display: 'none'` default — Phase 4 will keep it hidden by default and toggle via setting (see §2.4).
- **Currently DORMANT** — no caller mounts `<ReefRaceGhost />` in the tree (verified with Grep — only the file itself references the export). `ReefRaceScene.tsx` does NOT import it. Phase 4's first job is to (a) populate `selfBestGhostPath` from server data and (b) mount the component inside `ReefRaceScene` behind a self-only render gate.

### 0.2 Best-lap persistence — current state

- `activity_results` (`packages/database/src/schema/activity-results.ts:36-87`) already stores `score_ms` (Reef Race finish time) and `is_personal_best` boolean per row. **Per-MATCH best (full race), not per-LAP best.** A 3-lap race has 3 splits; only the cumulative finish is persisted.
- `reward-pipeline.ts:563-577` computes `priorBestMs = min(score_ms)` from prior `activity_results` rows for the pet; sets `isPersonalBest` if the new total beats it.
- Per-lap splits exist transiently in `ReefBody.lapSplitsMs[]` (`apps/api/src/services/activity/sim/reef-race-sim.ts:204` declared; populated at `sim.ts:1559` `body.lapSplitsMs.push(lapMs)`). They are **NOT persisted** anywhere — they evaporate when the room is GC'd.
- The `bestLapMs` field on the client `ReefRaceEntity` (`reef-race-types.ts:67`) is **defined but never written** — Grep on `bestLapMs` across the codebase returns only the type declaration.

**Decision (locked, see §1.1):** create a NEW table `reef_race_personal_bests` for the per-lap-best + ghost replay payload. DO NOT extend `activity_results` — that table is per-match (one row per finish), Phase 4 needs per-pet (one row per lifetime PB lap) and a JSONB blob whose size (~5 KB) doesn't belong in a per-match row.

### 0.3 `/leaderboard` page — current state

- `apps/web/src/app/leaderboard/page.tsx` (verified via Read 1-130) — single-purpose: agent leaderboard from `GET /api/leaderboard/agents`, tabbed by `24h | 7d | 30d | all`. No per-activity surface.
- `GET /api/activities/:id/leaderboard` (`apps/api/src/routes/activities.ts:790-810`) — exists but only consumed by in-game `leaderboard-modal.tsx`. It returns the per-activity board (sorted by `totalPoints` from `leaderboard_points` sum), with `bestTimeMs = min(score_ms)` for Reef Race rows ONLY (`activity-leaderboard-service.ts:131,156-167`). This is **per-MATCH best**, NOT per-lap.
- The "Lobster of the day" surface defined in §4 uses **per-LAP best**, which means a new aggregator over `reef_race_personal_bests` (NOT a re-sort of `activity_results`).

### 0.4 `ActivityResultsModal` — current fields

`apps/web/src/components/game/activity-results-modal.tsx` (verified via Read 1-1141).

- Hard-coded "BUMPER SHELLS" subtitle (line 649). **BUG to fix in same diff** — Phase 4 must show "REEF RACE" when `activityId === 'reef-race'`.
- Already shows: placement banner, pet portrait, stats (placement, score, eliminations witnessed), podium (top 3 + collapsed others), rewards (tokens, leaderboard points, first-play bonus, focus bonus), PB callout (★ NEW PERSONAL BEST ★ — fires on `isPersonalBest` from authoritative results), CTAs (Play Again / Back to Lobby).
- Phase 4 additions (§5) extend the rewards/callout sections and add Reef-Race-specific stat rows (best lap delta, streak best, daily rank).
- Authoritative fetch via `GET /api/activities/:activityId/rooms/:roomId/results` (line 254-263) — Phase 4 extends the response shape so the modal can render PB delta + streak + daily rank without a second round-trip.

---

## 1. Personal best (PB) ghost — server side

### 1.1 New table `reef_race_personal_bests`

Decision rationale: extending `activity_results` was rejected because (a) one row per match vs. one row per lifetime-best-lap is a different cardinality, (b) ghost replay JSONB (~5 KB compressed) bloats the per-match row that's hot for leaderboard scans, (c) per-match `score_ms` is a finish time (3-lap total) not a single lap; we'd be conflating two metrics. New table is additive, has a clean unique constraint, and indexes are tiny.

```ts
// packages/database/src/schema/reef-race-personal-bests.ts (NEW)
export const reefRacePersonalBests = pgTable('reef_race_personal_bests', {
  id: uuid('id').primaryKey().defaultRandom(),
  petId: uuid('pet_id').notNull().references(() => pets.id),
  /** Always 'reef-race' today; column kept for forward-compat parity with
   *  activity_results (avoids a future rename if a second racing activity
   *  ships). NOT NULL. */
  activityId: text('activity_id').notNull().default('reef-race'),
  /** Best single-lap time in ms. */
  bestLapMs: integer('best_lap_ms').notNull(),
  /** Wall-clock when the lap was set. */
  bestLapRecordedAt: timestamp('best_lap_recorded_at', { withTimezone: true })
    .defaultNow().notNull(),
  /** room_id of the match where the PB was set (for audit / replay link). */
  sourceRoomId: uuid('source_room_id').references(() => activityRooms.id),
  /** Frame samples for the best lap, 5 Hz, JSONB. See §1.4 for shape. */
  ghostReplayData: jsonb('ghost_replay_data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // One PB per (pet, activity). Replaced (not appended) on improvement.
  petActivityUq: uniqueIndex('uq_reef_race_pb_pet_activity').on(t.petId, t.activityId),
  // Daily-fastest-lap query over `bestLapRecordedAt > NOW() - INTERVAL '24h'`,
  // ORDER BY bestLapMs ASC LIMIT 100. Composite index makes both predicate +
  // ordering index-only. Also covers the daily-rank scan in §1.6
  // (count(*) WHERE bestLapMs < newMs AND best_lap_recorded_at > cutoff).
  recordedAtIdx: index('idx_reef_race_pb_recorded_lap')
    .on(t.bestLapRecordedAt.desc(), t.bestLapMs.asc())
    .where(sql`activity_id = 'reef-race'`),
}));
export type ReefRacePersonalBest = typeof reefRacePersonalBests.$inferSelect;
export type NewReefRacePersonalBest = typeof reefRacePersonalBests.$inferInsert;
```

Migration file: `packages/database/drizzle/0005_reef_race_personal_bests.sql` (new, generated via `bun run db:generate`). Additive only — no destructive changes; migration commit gates on `bun run db:push` against prod (per CLAUDE.md "Database migrations" section).

Schema export: add to `packages/database/src/schema/index.ts` after line 36 (`export * from './activity-seasons';`).

### 1.2 PB write path

New module `apps/api/src/services/activity/reef-race-personal-best-service.ts`:

```ts
export interface PbWriteInput {
  petId: string;
  activityId: 'reef-race';
  newBestLapMs: number;
  ghostReplayData: GhostReplayPayload;  // see §1.4
  sourceRoomId: string;
}
export interface PbWriteResult {
  /** Was the PB actually written? false if newBestLapMs >= existing. */
  improved: boolean;
  /** Previous best in ms. null if no prior PB row. */
  previousMs: number | null;
  /** Daily rank of the just-written PB if improved (1 = #1 fastest in last 24h),
   *  else null. Computed via single indexed scan against the same connection,
   *  avoiding the 60s cache used by the public leaderboard surface. */
  dailyRank: number | null;
}

/** Atomic upsert: write only when newBestLapMs < existing.bestLapMs.
 *  On success, INVALIDATES the in-memory PB ghost cache (S4) AND the
 *  daily-best-lap snapshot cache (C2) so subsequent reads see the new entry.
 */
export async function maybeUpdatePersonalBest(input: PbWriteInput): Promise<PbWriteResult>;

/** Read latest PB for pet (hot path: snapshot.init for self pet). */
export async function loadPersonalBest(petId: string): Promise<ReefRacePersonalBest | null>;

/** Read PB ghost frames only (snapshot.init payload). Cached 5 min;
 *  invalidated by maybeUpdatePersonalBest on successful upsert. */
export async function loadPersonalBestGhostFrames(petId: string): Promise<GhostFrame[] | undefined>;

/** Internal — exported for tests + the daily-best-lap service to call after
 *  any external mutation. */
export function invalidatePbGhostCache(petId: string): void;
```

Implementation notes:
- `maybeUpdatePersonalBest` uses `INSERT ... ON CONFLICT (pet_id, activity_id) DO UPDATE SET ... WHERE EXCLUDED.best_lap_ms < reef_race_personal_bests.best_lap_ms RETURNING ...` — single round-trip atomic compare-and-set. The `RETURNING` lets us know whether the row actually got updated (improved=true) vs. predicate matched but kept (improved=false).
- **C2 fix.** When `improved === true`, the same function executes a single follow-up indexed scan in the same async chain to compute `dailyRank`:
  ```sql
  SELECT count(*)::int + 1 AS rank
  FROM reef_race_personal_bests
  WHERE activity_id = 'reef-race'
    AND best_lap_recorded_at > NOW() - INTERVAL '24 hours'
    AND best_lap_ms < $1;  -- newBestLapMs
  ```
  Returns the new rank in <2 ms (covered by `idx_reef_race_pb_recorded_lap`). Returns `null` if `count >= 100` (off-board) so the modal doesn't display a misleading rank.
- **C2 fix part 2.** Immediately AFTER a successful upsert, the function calls `invalidateDailyBestLapCache()` (from §4.1) AND `invalidatePbGhostCache(petId)`. This makes the next `/api/leaderboard/reef-race/daily-best-lap` read see the fresh row, and any reconnect within the 5-minute PB-ghost-cache TTL sees the freshly-set ghost (S4 fix).
- Bots are skipped at the call site (`participant.subjectType === 'bot'`). Guests are NOT skipped — guests can have PBs (matches §0.4 reward logic; guests still earn tokens, but their daily-leaderboard surface fires the same anti-bot SQL filter as `activity-leaderboard-service.ts:117-120`).

### 1.3 When PB is UPDATED

In `apps/api/src/services/activity/reward-pipeline.ts` `issueRewardsForRoom()`:

- After the existing `db.transaction` block that writes `activity_results` rows (line 223-331), the pipeline AWAITS `maybeUpdatePersonalBest()` for each non-bot Reef Race participant with a complete lap. **C2 fix — this is no longer fire-and-forget.** The pipeline `Promise.all`s the per-pet PB writes (parallel; bounded by 8 concurrent matches; total wall-clock <50 ms even with all 8 pets improving).
- The PB write is INTENTIONALLY OUTSIDE the rewards transaction. Rationale: PB write failure must not roll back the actual reward credit (token debit). On error, the pipeline logs + `alertError({severity: 'warning'})` + sets the per-pet `pbDelta = null` so the modal doesn't show a half-truth.
- **C2 fix.** The `event.match_ended` payload is built AFTER the awaited PB writes complete. The payload's `pbDelta` includes the freshly-computed `dailyRank` from the PB service's single indexed scan — no cache dependency, no second round-trip.

**Where does the per-lap split + ghost replay data come from?** The sim resolver currently returns `SimResultRow[]` from `reefRaceSim.computeResults()` — a placement list with `score`, `scoreMs`, `placement` only. Phase 4 extends `SimResultRow` to surface the per-pet best-lap + streak data INLINE — no separate accessor that depends on `state.bodies` still being alive (C3 fix):

```ts
// SimResultRow extension, populated in computeResults() BEFORE teardown.
interface SimResultRow {
  // ... existing fields
  // Reef Race only — undefined for other activities:
  reefRace?: {
    bestLapMs: number;            // min(body.lapSplitsMs[])
    bestLapIndex: number;         // 0-indexed lap that produced the best split
    ghostReplayFrames: GhostFrame[];  // captured from the sim — see §1.4
    bestStreakThisMatch: number;  // C3 — embedded here, NOT looked up later
    currentStreakAtMatchEnd: number;  // for completeness; not surfaced
  };
}
```

This is the **C3 fix**: `computeResults()` is called BEFORE `endRound()` clears `state.bodies`, so it can safely read every body's streak + ghost frames + lap splits while the data is still alive. The reward pipeline then operates on `simResults[i].reefRace` — a plain JS object with no live-state dependency. There is NO `getStreaksByPet(roomId)` accessor; it was removed from the v1 plan because it created an ordering dependency between sim teardown and reward credit.

### 1.4 Ghost replay capture (server-side)

Frame rate decision: **5 Hz capture, NOT 30 Hz.** Math:
- A clean lap is ~25–35 sec on a 6000 wu perimeter at the 360 wu/s top speed (`REEF_MAX_SPEED`); 3 laps = 75–105 sec total.
- Best lap is one of those — typical ~25–35 sec.
- 30 Hz × 30 sec × 4 fields × 4 bytes (encoded) = ~14 KB. After JSONB packing on PG: ~16 KB.
- 5 Hz × 30 sec = 150 frames × ~24 bytes serialized = ~3.6 KB stored. 200 frames worst-case (40 sec lap) = 4.8 KB.
- Client interpolates between bracketing frames in `ReefRaceGhost.tsx:findGhostFrames()` (already lerp-correct for arbitrary frame rate per `reef-race-config.ts:GHOST_SAMPLE_HZ = 10`); doubling the bracketing gap from 100 ms → 200 ms is invisible at the kart's 360 wu/s top speed (the kart moves ~72 wu in 200 ms — well below the per-frame visual fidelity needed for a transparent ghost on a 300 wu wide track).
- **5 Hz balances storage size with smooth playback.** `GHOST_SAMPLE_HZ = 10` in `reef-race-config.ts:219` (client-side mirror) updates to **5** in the same diff so client and server agree.

Capture mechanism — new module-level state on `ReefBody`:

```ts
// In reef-race-sim.ts, ReefBody interface (line 180 area), ADD:
/** Ring buffer of frames for the CURRENT lap. Cleared on lap-up AND on
 *  sub-MIN_LAP discard (C1 fix). */
currentLapFrames: GhostFrame[];
/** Snapshot of currentLapFrames at the moment the BEST lap closed. null until first lap finished. */
bestLapFrames: GhostFrame[] | null;
/** Best lap ms seen so far (used to gate bestLapFrames replacement without
 *  allocating). */
bestLapMsSoFar: number | null;
```

Frame sampling — added inside `tick()` between physics integration and snapshot broadcast, gated by tick-modulo:

```ts
// REEF_SIM_HZ = 30. Sample every 6th tick = 5 Hz.
if (state.tick % 6 === 0) {
  for (const body of state.bodies.values()) {
    if (!body.alive || body.dnf || body.finishedAt !== null) continue;
    body.currentLapFrames.push({
      t: now - body.lapStartedAt,  // lap-relative ms — see §1.5 for why
      x: body.x,
      z: body.y,                    // sim-Y → Three.js-Z
      rot: body.rot,
    });
    // S6 — guarantee the very first frame has t=0 by writing a synthetic
    // frame at lapStartedAt the first time we sample after a lap-up. See §1.5.
  }
}
```

Frame capture cap: hard limit 250 frames per body (= 50 sec lap @ 5 Hz). At cap, oldest frame drops (FIFO `shift()`). 50 sec is safely above legitimate lap times; a 50+ sec "lap" is either a reset or a hazard-stuck body — the cap saves the LAST 50 sec which is what we'd want to surface anyway. **N5 acceptance:** PB lap by definition is the player's fastest; the worst-case frame budget is never the saved one. We're capping the WORK of capture, not the SIZE of the saved blob.

Per-frame allocation guard: `currentLapFrames` is initialized as `[]` at body init, reused via `push` + `shift` only. The `GhostFrame` object literal in the push site IS one allocation per body per tick-modulo-6 — that's 8 bodies × 5 Hz = 40 allocations/sec. Acceptable; the alternative (a typed-array ring buffer) is over-engineered for 200 short-lived frames per match.

#### 1.4a — C1 FIX: clear frames in BOTH lap-completion branches

The existing `resolveCheckpoints` at `sim.ts:1543-1568` has TWO terminal branches when a lap completes:

```ts
// EXISTING (sim.ts:1543-1556) — sub-MIN_LAP discard branch:
if (lapMs < REEF_MIN_LAP_MS) {
  // ... anti-cheat flag + log
  body.lapStartedAt = now;        // reset for next attempt
  body.nextCheckpoint = 1;        // roll back
  // C1 FIX — MUST clear ghost frame buffer; otherwise stale frames
  // from this discarded attempt mix with the next attempt's frames at
  // t≈14000ms, breaking findGhostFrames' linear scan with non-monotonic t.
  body.currentLapFrames.length = 0;
  break;
}

// EXISTING success path (sim.ts:1558-1568) — PLUS Phase 4 additions:
body.lap += 1;
body.lapSplitsMs.push(lapMs);
body.lapStartedAt = now;

// Phase 4 — if this lap is the best so far, snapshot the frames.
const isBestLapSoFar = body.bestLapMsSoFar === null || lapMs < body.bestLapMsSoFar;
if (isBestLapSoFar) {
  body.bestLapMsSoFar = lapMs;
  // CLONE the array — currentLapFrames clears next, the snapshot must persist.
  body.bestLapFrames = body.currentLapFrames.slice();
}
// C1 — same clear in the success branch.
body.currentLapFrames.length = 0;

// S1 FIX — clear apex verdicts at lap boundary so the next lap's
// hairpin reads a fresh verdict, not the previous lap's stale entry.
body.lastApexVerdictByHairpin.clear();
```

Both branches MUST clear `currentLapFrames`. Test §7.2 adds an explicit case for the discard branch.

`SimResultRow.reefRace.ghostReplayFrames` is populated from `body.bestLapFrames` inside `computeResults()` (C3 fix — embedded into the result row, not looked up later).

### 1.5 Frame coordinate system — lap-relative `t`

`t` in the captured frame is **milliseconds since `body.lapStartedAt`** (start of the SOURCE lap), NOT wall-clock. Rationale:
- The client's existing `ReefRaceGhost.tsx:101-110` does `Date.now() - raceStartMs % pathDuration`. With lap-relative `t`, the ghost loops over a ~30 sec lap regardless of when the original PB was set (yesterday vs. now).
- Without lap-relative `t`, the client would have to subtract `path[0].t` every frame — the existing code already does (`path[0].t + (elapsedMs % pathDuration)`), so lap-relative just keeps the math the same.
- `findGhostFrames(path, ghostMs)` is unchanged.

**S6 fix — synthetic t=0 frame.** The first sample after `lapStartedAt` is set lands at `now - lapStartedAt = (tickInterval × ticksUntilNextSample)` — typically ~200 ms. To make the ghost start at `t=0` in lockstep with the player's own kart, add a one-shot synthetic frame at lap-up:

```ts
// In the lap-up SUCCESS branch (and at race start in addBody),
// AFTER clearing currentLapFrames, write a t=0 anchor frame so the
// next captured frame is the SECOND in the array, not the first.
body.currentLapFrames.push({ t: 0, x: body.x, z: body.y, rot: body.rot });
```

This is one extra allocation per lap (negligible) and removes the visible "ghost starts late" artifact called out in S6.

### 1.6 PB load path

In `apps/api/src/services/activity/activity-ws-hub.ts:539-557` (the snapshot.init send), after the `reefRacingProfiles` block, add:

```ts
// Phase 4 — pull self pet's PB ghost replay (Reef Race only). Sent once per
// snapshot.init for the SELF pet only (not other racers — too crowded per
// spec §2). Skipped for guests + bots (no PB row).
const selfBestLapGhost =
  room.activityId === 'reef-race' && ws.data.identity
    ? await loadPersonalBestGhostFrames(ws.data.identity.petId)
    : undefined;
```

`loadPersonalBestGhostFrames(petId): Promise<GhostFrame[] | undefined>`:
- Reads the single row for `(petId, activityId='reef-race')`.
- Returns `ghostReplayData.frames` (typed cast).
- Returns `undefined` on any error (logged via `console.warn`, NOT alertError — missing PB is the common case for fresh pets).
- Hot path: ~50 ms first call, cached for subsequent loads of the same room (cache key: petId). A small in-memory `Map<petId, {frames, expiresAt}>` with 5-min TTL is enough — no eviction loop needed (RAF natural gc when room ends + map size is bounded by concurrent players).
- **S4 FIX.** `maybeUpdatePersonalBest` calls `invalidatePbGhostCache(petId)` on successful upsert (§1.2). Subsequent reconnects within the 5-min TTL will see the fresh ghost on snapshot.init.

The frames are then propagated into `RoomMeta.selfBestLapGhost` (new optional field — see §6). The hub's `safeSend` block at line 540-565 gets `selfBestLapGhost` added to the inner `room` object.

**Sizing check:** ~5 KB per snapshot.init × 8 players = 40 KB total per room. Snapshot.init runs once per WS connect; this is a one-shot cost, not per-tick. Within budget.

### 1.7 Bot pets — skip PB

Bot pets (`subjectType === 'bot'`) are skipped at:
- `maybeUpdatePersonalBest` call site in `reward-pipeline.ts` — same `isBot` check that already exists at line 241-242.
- `loadPersonalBestGhostFrames` — bots never have rows because they were never written.

---

## 2. Personal best (PB) ghost — client side

### 2.1 Store wiring

`apps/web/src/stores/activity.ts`:
- The `selfBestGhostPath` field already exists in `ReefRaceState` (line 86) — Phase 4 wires the `snapshot.init` handler to populate it from `RoomMeta.selfBestLapGhost`.
- Add to `applyServerFrame` switch (around line 800+ — find the `snapshot.init` case): when `frame.room.selfBestLapGhost && frame.room.selfBestLapGhost.length > 1`, call `setGhostPath(frame.room.selfBestLapGhost)`. Otherwise leave `selfBestGhostPath: null`.
- After every match-end the client may receive a refreshed PB (if just set this match) — extend `event.match_ended` payload (§6) to optionally carry `pbDelta.newGhostFrames`. When present, call `setGhostPath(frame.pbDelta.newGhostFrames)` so the next match (without WS reconnect) shows the freshly-set ghost.

### 2.2 ReefRaceGhost.tsx — minimal changes

The component is **already correct in shape**. Phase 4 changes:

- L168-172: ADD a new prop / store subscription `enabled: boolean` to gate rendering. Read from a new client-only setting `useGameStore((s) => s.settings.reefRaceShowGhost)` (default `true`). When `false`, return `null` early.
- L101-133 `useFrame`: ADD lap-boundary fade. The component currently shows the ghost continuously; Phase 4 spec says "fades in/out per lap". Use a simple per-frame opacity ramp:
  - During the first 0.5 sec of each LOCAL lap: alpha 0 → 0.45 (linear).
  - During the last 0.5 sec of each lap: alpha 0.45 → 0 (linear).
  - Mid-lap: alpha 0.45 (constant).
  - Lap boundary detected via `useActivityStore((s) => s.entities.get(s.selfPetId)?.lap)`. The component subscribes via `useFrame` reads `useActivityStore.getState()` (no React re-render on lap change — cheap).
  - Apply the alpha by writing `mat.opacity = alpha * GHOST_OPACITY` on each material once per frame. The materials already have `transparent: true` set.
- Per-frame mat traversal — to avoid traversing the cloned scene tree every frame, **cache the material list in a `useMemo`** at clone time. Phase 4 adds:
  ```ts
  const ghostMaterials = useMemo<THREE.MeshStandardMaterial[]>(() => {
    const out: THREE.MeshStandardMaterial[] = [];
    clonedScene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (Array.isArray(m)) m.forEach((mm) => out.push(mm as THREE.MeshStandardMaterial));
      else if (m) out.push(m as THREE.MeshStandardMaterial);
    });
    return out;
  }, [clonedScene]);
  ```
  Then `useFrame` does `for (const mat of ghostMaterials) mat.opacity = alpha * GHOST_OPACITY;` — O(meshCount), no traverse.

### 2.3 Mount in ReefRaceScene

`apps/web/src/lib/three/activities/reef-race/ReefRaceScene.tsx`:

Add an import + a single `<ReefRaceGhost raceStartMs={raceStartMs} />` mount inside the existing scene tree, after `<ReefRacePlayer>` and before `<ReefRacePickups>` (so the ghost renders behind pickups but in front of the track). `raceStartMs` is plumbed via the existing scene props (already passed for player kart timing).

### 2.4 "Distracting or motivational?" — decision

**Default ON, with per-user toggle.** The ghost is the canonical mechanic in every kart racer (Mario Kart Time Trials, F-Zero), and it's behind a low-opacity transparent material the player can ignore. The HUD adds a small toggle: `show ghost` checkbox in the existing settings drawer (`apps/web/src/components/game/settings-modal.tsx` if present, or a new section in `reef-race-hud.tsx` overflow menu).

State: `gameStore.settings.reefRaceShowGhost: boolean` (default `true`), persisted to localStorage via the existing zustand persist middleware (verified pattern from `useGameStore`).

`ReefRaceGhost` returns `null` early when toggle is off, so per-frame work goes to zero.

### 2.5 During lap N, ghost replays from PB lap

The ghost path stored is the SINGLE BEST LAP (~25-35 sec of frames). During the player's current lap it loops over that single lap. After lap N completes, IF the player just set a new lap PB, the freshly-captured frames from this match are ALREADY available client-side via `event.match_ended.pbDelta.newGhostFrames` (sent at match-end, not mid-match). The current-match-mid-race ghost stays the pre-existing PB.

(We considered live mid-match swap from "lap N's frames" → "fresh just-completed lap" but: (a) it adds protocol surface, (b) the visual impact is small — by the time the player completes a lap, the next lap is already starting and the ghost is right behind them either way, (c) the audit risk of mid-match server-side ghost computation isn't worth it. Persist on match-end only.)

---

## 3. Checkpoint streak counter

### 3.1 "Perfect line" definition (canonical)

A checkpoint cross is **clean** when, AT THE MOMENT OF CROSSING, the body is inside the apex inner zone for the corresponding hairpin. Concretely:

- The two hairpin checkpoint indices are `[3, 9]` (defined in `reef-race-config.ts:APEX_HAIRPIN_CP_INDICES = [3, 9]`).
- Non-hairpin checkpoints (the other 10 of 12) are clean **automatically** if the body is on-track and made the legitimate sequence cross. Rationale: requiring an apex line on a straight is degenerate. The streak measures hairpin discipline + non-cheating progression; it does NOT punish breaking the racing line on a straight.
- Hairpin checkpoints are clean ONLY when the body's most recent apex verdict for that lap+hairpin was `'clean'` (set in `resolveApex` at `sim.ts:2210-2221`).

Per the streak's intended UX of "perfect line", the test is:

```ts
function isCheckpointCrossClean(body: ReefBody, cpIdx: number): boolean {
  if (!APEX_HAIRPIN_CP_INDICES.includes(cpIdx)) return true;  // non-hairpin: auto-clean
  // S1 FIX — key by (lap, cpIdx) to avoid stale verdicts from previous lap.
  const key = `${body.lap}-${cpIdx}`;
  return body.apexCheckedThisLap.has(`${body.lap}:${cpIdx}`)
      && body.lastApexVerdictByHairpin.get(key) === 'clean';
}
```

`body.lastApexVerdictByHairpin: Map<string, 'clean' | 'wide'>` is a NEW per-body field (initialized empty in `addBody()`, updated in `resolveApex` whenever a verdict fires, **keyed by `${body.lap}-${cpIdx}` to avoid cross-lap collision** — S1 fix). The map is also cleared in the lap-up branch (§1.4a) for belt-and-suspenders safety.

The `apexCheckedThisLap` set (existing) is already cleared at lap boundary in `resolveCheckpoints` (sim.ts:1567). Phase 4 adds the parallel `lastApexVerdictByHairpin` map clear in the SAME location (§1.4a code block).

### 3.2 Per-body sim state

```ts
// On ReefBody (reef-race-sim.ts:180-region) ADD:
/** Current run of consecutive clean checkpoint crosses. Resets on dirty cross. */
currentStreak: number;
/** High-water mark of currentStreak across the entire match. */
bestStreakThisMatch: number;
/** Whether the last hairpin verdict per (lap, hairpin) was 'clean'.
 *  S1 FIX — keyed by `${lap}-${cpIdx}` (was `cpIdx` only — collided across laps). */
lastApexVerdictByHairpin: Map<string, 'clean' | 'wide'>;
```

All cleared in `addBody()` next to the existing initializers.

### 3.3 Streak update on checkpoint cross

Inside `resolveCheckpoints` (`sim.ts:1490-1592`), AFTER the legit-crossing block (around line 1535 where `body.nextCheckpoint = (wasCheckpoint + 1) % REEF_CHECKPOINT_COUNT`) and BEFORE the lap-completion check at line 1537:

```ts
// Phase 4 — streak update.
const cpIdx = wasCheckpoint;  // the checkpoint we just CROSSED (not the next one)
const clean = isCheckpointCrossClean(body, cpIdx);
if (clean) {
  body.currentStreak += 1;
  if (body.currentStreak > body.bestStreakThisMatch) {
    body.bestStreakThisMatch = body.currentStreak;
  }
  // Edge-trigger event broadcast on milestone hits (5/10/20/30/36). Avoid
  // per-checkpoint broadcasts — too noisy. Total checkpoints in 3 laps =
  // 12 × 3 = 36, so milestones at 5/10/20/30 + perfect at 36.
  // S2 FIX — milestone count compressed from 7 to 5 to match 5-tier union.
  if (STREAK_MILESTONES.includes(body.currentStreak)) {
    this.broadcastFn(state.roomId, {
      type: 'event.streak_milestone',
      petId: body.petId,
      streak: body.currentStreak,
      kind: streakMilestoneKind(body.currentStreak),  // 'tier-1'|'tier-2'|'tier-3'|'tier-4'|'perfect'
    });
  }
} else {
  // Reset on dirty cross.
  body.currentStreak = 0;
}
```

**S2 FIX.** `STREAK_MILESTONES = [5, 10, 20, 30, 36]` and `streakMilestoneKind()` map (constants in `reef-race-config.ts` server-side):

```ts
export const STREAK_MILESTONES = [5, 10, 20, 30, 36] as const;
export type StreakMilestoneKind = 'tier-1' | 'tier-2' | 'tier-3' | 'tier-4' | 'perfect';

export function streakMilestoneKind(streak: number): StreakMilestoneKind {
  if (streak >= 36) return 'perfect';
  if (streak >= 30) return 'tier-4';
  if (streak >= 20) return 'tier-3';
  if (streak >= 10) return 'tier-2';
  return 'tier-1';  // streak >= 5
}
```

Clients import the same constants from `packages/shared/src/activities/reef-race-streak.ts` (NEW shared module) for HUD label + glow tier mapping (N4 fix). No client-side duplication; shared is the single source of truth.

**Hairpin verdict timing:** apex resolution happens in step 5b BEFORE checkpoint resolution in step 5c (per the existing comment at `sim.ts:917-922` "Phase 2 audit G4 — apex-penalty ... Apex verdicts are evaluated BEFORE checkpoints"). So when `resolveCheckpoints` reads `lastApexVerdictByHairpin`, the value is current to THIS tick. ✓ ordering correct.

**100% perfect:** total checkpoints in 3 laps = 36. Streak ≥ 36 at match-end = perfect race. Reward: see §3.4.

### 3.4 Bonus tokens for 100% perfect streak — C3 FIX (no late accessor)

Reward configuration in `packages/shared/src/activities/activities.ts` for `reef-race.rewardConfig`:

```ts
// ADD to ActivityRewardConfig:
perfectStreakBonusTokens?: number;  // default 25
```

In `reward-pipeline.ts` `computeBreakdown()`:

```ts
// C3 FIX — read bestStreakThisMatch from the SimResultRow (embedded at
// computeResults() time, BEFORE state.bodies teardown). NO live accessor.
const bestStreak = simResult.reefRace?.bestStreakThisMatch ?? 0;
const perfectStreakBonus =
  bestStreak >= TOTAL_CHECKPOINTS_PER_RACE  // 36
    ? rewardConfig?.perfectStreakBonusTokens ?? 0
    : 0;
```

The pipeline NEVER calls `getStreaksByPet(roomId)` or any other live-state accessor. The data flow is:

```
sim.computeResults(room)
  └─ walks state.bodies WHILE ALIVE
  └─ embeds bestLapMs, ghostFrames, bestStreakThisMatch into SimResultRow.reefRace
  └─ returns SimResultRow[]
                ↓
sim.endRound()  ← may clear state.bodies; doesn't matter, data already extracted
                ↓
issueRewardsForRoom({ simResults })
  └─ reads simResults[i].reefRace.* — plain JS, no live state lookup
  └─ awaits maybeUpdatePersonalBest() per pet (parallel)
  └─ builds event.match_ended.pbDelta with deterministic dailyRank
  └─ broadcasts per-recipient match-end frames
```

This makes the perfect-lap bonus + PB write + dailyRank computation **ordering-independent** with respect to sim teardown. C3 fix complete.

`computeBreakdown` input grows `bestStreakThisMatch?: number` (default 0 — non-Reef-Race activities omit it, no behaviour change). The `RewardBreakdown` adds `perfectStreakBonus: number` (sums into the same breakdown total).

### 3.5 HUD streak indicator

`apps/web/src/components/game/reef-race-hud.tsx`:

- Read `useActivityStore((s) => s.reefRace?.selfStreak ?? 0)`.
- Render a small chip near the placement tile (top-right of HUD): `🔥 STREAK: 7`.
- Light up at milestones using the SHARED tier kind from `streakMilestoneKind(streak)` (§3.3) — single source of truth, no client-side milestone re-derivation (N4 fix). Tier-1 amber, tier-2 orange, tier-3 red, tier-4 gold, perfect rainbow gradient. CSS class table indexed by tier — no per-frame work.
- Resets to 0 visually with a brief flash (CSS keyframe `streak-reset 200ms`) when the value drops to 0 — gives the player feedback that they just lost the streak.

### 3.6 Store wiring for streak

`apps/web/src/stores/activity.ts`:

```ts
// ADD to ReefRaceState:
selfStreak: number;
selfBestStreakThisMatch: number;
```

Updated by:
- `event.streak_milestone` handler — sets `selfStreak: streak` when `petId === selfPetId`.
- The streak counter is also surfaced via `EntityDelta.changed.streak` (server adds to delta when changed) so non-milestone increments propagate. Client filters to self pet inside `applyEntityDelta`.

### 3.7 Per-tick / per-checkpoint event cost

- `event.checkpoint_clean` is **NOT broadcast** — too noisy (36 events per match × 8 players = 288 events/match). Streak state is in `EntityDelta.changed.streak` instead.
- `event.streak_milestone` IS broadcast (≤5 milestones × 8 players = ≤40 events/match — bandwidth trivial).
- `body.currentStreak` ALWAYS goes into `EntityDelta` snapshot diff (added to the existing `buildSnapshot()` output at `sim.ts:1780-1807`) — same shape as `driftSparks`.
- Cost analysis: 12 cps × 3 laps × 8 players = 288 streak field updates per match. Each is a 1-byte int change; well within the existing 5 Hz delta bandwidth.

### 3.8 Per-body teardown

Per-body cleanup (the `addBody` path's mirror) lives in `removeBody` / room teardown. The streak state is in fields directly on the `ReefBody` object — when the body is removed from `state.bodies`, the `lastApexVerdictByHairpin` Map is GC'd along with the body. No explicit cleanup needed.

**C3 corollary.** Even if `state.bodies` is cleared in `endRound`, the streak data lives ALSO in `SimResultRow.reefRace.bestStreakThisMatch` (extracted at `computeResults()` time). The reward pipeline operates on the extracted data, never on the live body.

---

## 4. Lobster of the day

### 4.1 Aggregator

New service module `apps/api/src/services/activity/reef-race-daily-best-service.ts`:

```ts
export interface DailyBestLapEntry {
  rank: number;
  petId: string;
  petName: string;
  bestLapMs: number;
  bestLapRecordedAt: string;  // ISO
  /** Owner's wallet address — surfaced for "Lobster of the day" cosmetic. */
  walletAddress: string | null;
}

export interface DailyBestLapSnapshot {
  generatedAt: string;
  /** ISO timestamp of the cutoff (NOW - 24h). */
  windowStart: string;
  totalEntries: number;
  entries: DailyBestLapEntry[];
}

/** 60s in-memory cache. Same TTL pattern as activity-leaderboard-service.ts:56.
 *  C2/S4 FIX — invalidated by maybeUpdatePersonalBest on successful upsert. */
export async function getDailyBestLapSnapshot(limit?: number): Promise<DailyBestLapSnapshot>;
export function invalidateDailyBestLapCache(): void;
```

**Important — separation of concerns (C2 fix):**
- The 60s cache here serves the PUBLIC `/api/leaderboard/reef-race/daily-best-lap` endpoint (§4.2). It is invalidated on every successful PB upsert so users hitting the page see fresh data within one round-trip after their lap.
- The per-pet `dailyRank` returned in `event.match_ended.pbDelta.dailyRank` is computed via a SEPARATE, non-cached indexed scan inside `maybeUpdatePersonalBest` (§1.2). This avoids any race between the PB write and the cache rebuild — the rank is computed in the SAME async chain as the write, against the freshly-written row.

SQL (Drizzle equivalent):

```sql
SELECT pb.pet_id, pb.best_lap_ms, pb.best_lap_recorded_at, p.name, w.address AS wallet_address
FROM reef_race_personal_bests pb
JOIN pets p ON p.id = pb.pet_id
LEFT JOIN wallets w ON w.subject_type = 'pet' AND w.subject_id = pb.pet_id
WHERE pb.best_lap_recorded_at > NOW() - INTERVAL '24 hours'
  AND pb.activity_id = 'reef-race'
  -- Bot + guest carve-outs (mirror activity-leaderboard-service.ts:117-120).
  AND NOT EXISTS (SELECT 1 FROM pets gp WHERE gp.id = pb.pet_id AND gp.is_guest = true)
  -- Bots are excluded by the §1.7 "skip bot writes" — no row exists, so no SQL filter needed.
ORDER BY pb.best_lap_ms ASC
LIMIT 100;
```

Index from §1.1 (`idx_reef_race_pb_recorded_lap`) covers this exactly. Query plan: index-only scan + nested-loop join on `pets` (PK) and `wallets` (subject composite). At 1000 PB rows / day this is sub-millisecond; cache absorbs the duplicate hits.

### 4.2 API route

`apps/api/src/routes/leaderboard.ts`:

```ts
// S5 FIX — separate limiter, NOT shared with /agents. 60/min/IP each gives
// power users on multi-tab leaderboard page the headroom they need.
const dailyBestLapLimiter = createRateLimiter({ maxPerWindow: 60, windowMs: 60_000 });

leaderboardRoutes.get('/reef-race/daily-best-lap', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!dailyBestLapLimiter.check(ip)) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const limit = clampInt(c.req.query('limit'), 100, 1, 100);
  const snap = await getDailyBestLapSnapshot(limit);
  c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  return c.json(snap);
});
```

Public — no auth — matching the brand stance "high-visibility public surface". Both endpoints (`/agents` and `/reef-race/daily-best-lap`) honor the brand priority #3 60-req/min budget independently, so a tab rendering both surfaces never blows a single bucket.

### 4.3 `/leaderboard` page UI

`apps/web/src/app/leaderboard/page.tsx`:

Add a TAB GROUP at the top with two tabs:

- **Agents** (existing — composite scoring, default).
- **Lobster of the day 🦞** — fetches `GET /api/leaderboard/reef-race/daily-best-lap`, renders a single ranked list with columns: rank · pet name · best lap (formatted m:ss.cc) · "set N hours ago" · wallet (shortened).

The top entry gets a special "🦞 LOBSTER OF THE DAY" gold-bordered card (matches the agent leaderboard's medal cards aesthetic). Ranks 2–100 in compact rows.

`useQuery` cache: `['leaderboard', 'reef-race', 'daily']`, `staleTime: 60_000` (matches server cache + the existing agents tab pattern).

Empty state copy: "No best laps in the last 24 hours yet — start a Reef Race round and set the bar."

### 4.4 Anti-cheat audit for public daily leaderboard

Risk: a player completes a single fast lap, drops out, locks in a top time, dominates the daily board.

**Mitigations:**

1. **Match-finish gate.** PB writes happen INSIDE `issueRewardsForRoom` which only runs after `endRound()` in the sim, which only fires when the match ENDED (all racers finished/DNF or hard timeout reached at `sim.ts:1719-1727`). A player who disconnects mid-race never reaches PB write.
2. **MIN_LAP_MS already enforced.** `validateLapTime(lapMs)` at `sim.ts:1543` discards laps under 15 sec — flagged as `underminlap` anti-cheat. Fast-time exploits via teleport/clip already blocked at the source. **C1 ensures discarded-lap frames don't contaminate the next attempt's PB.**
3. **Anti-cheat flag check.** A pet with ≥1 anti-cheat flag this match has their PB write SKIPPED. New check in `reward-pipeline.ts` PB pass: `if (body.flagCount > 0) skip`. Trades small honest-mistake recall (a single false-positive flag denies a legit PB) for ironclad cheater exclusion. Acceptable trade — there's always tomorrow's PB.
4. **Subject-type filter** mirrors the existing pattern (`subjectType !== 'bot'`, `is_guest = false` excluded — see §4.1 SQL).
5. **No anonymous submission.** The route is read-only (`GET`); the only write path is the sim → reward pipeline → DB, which can't be triggered without a participant slot.

---

## 5. Match-end screen

### 5.1 Existing component review

`activity-results-modal.tsx` shows: placement banner, portrait, stats, podium, rewards, PB callout (already), CTAs. Subtitle hard-coded "BUMPER SHELLS" — must vary by `activityId`.

### 5.2 Phase 4 additions

Three new optional sections that render only when their data is present:

**(a) PB delta** — replace the existing "★ NEW PERSONAL BEST ★" callout (lines 794-813) with a richer block when `activityId === 'reef-race'`:

```
🏆 NEW PERSONAL BEST
12.34s  (was 12.89s, −0.55s)
```

When the player has NO prior PB: "🏆 PERSONAL BEST SET — 12.34s".

**(b) Streak milestone** — new section after rewards, fires when `bestStreakThisMatch > 0`:

```
⚡ PERFECT LINE STREAK
Best run: 18 checkpoints
```

When streak hit max (36): "⚡ PERFECT LAP — 36/36 checkpoints clean (+25 🪙)".

**(c) Daily rank** — new section after streak, fires when the just-set PB lands in the daily top 10:

```
🎖 #7 LOBSTER OF THE DAY
Beat the 24h best by 0.12s? Try again tomorrow.
```

**C2 FIX.** Daily rank is computed server-side INSIDE `maybeUpdatePersonalBest` at PB-write time (single indexed scan, no cache dependency) and returned as part of the awaited result. The pipeline embeds it into `event.match_ended.pbDelta.dailyRank`. The modal reads it from the per-pet match-end frame. The rank is **deterministic on the very match that earned it** — no race window with the cache.

### 5.3 Data sources

- All three pull from existing store primitives:
  - `useActivityStore((s) => s.rewardPreview)` — extended to include `pbDelta` + `streakBest` + `dailyRank` (event payload shape change in §6).
  - `useActivityStore((s) => s.reefRace.selfBestStreakThisMatch)` — for (b).
  - The authoritative replace via `GET /api/activities/:id/rooms/:roomId/results` returns the same shape so the modal can swap in authoritative numbers (matches the existing pattern at line 254-263).

### 5.4 Store extensions

```ts
// In ReefRaceState (activity.ts:80-92):
selfStreak: number;                 // §3.6
selfBestStreakThisMatch: number;    // §3.6
selfDailyBestLapRank: number | null;  // populated on event.match_ended
```

Match-end handler in `applyServerFrame` switch updates these from `event.match_ended.pbDelta` / `streakBest` / `dailyRank` (the latter sourced from the awaited PB-write result, NOT the public cache — C2 fix).

### 5.5 "Reef Race" subtitle fix

Replace the hard-coded `'BUMPER SHELLS'` at line 649 with:

```ts
const activityLabel = activityId === 'reef-race' ? 'REEF RACE' : 'BUMPER SHELLS';
```

(Per zero-laziness policy — found a stale string while reading the file, fix it now.)

### 5.6 Reduced-motion respected

The new sections inherit the existing `phases.callout` / animation gating — `prefers-reduced-motion` collapses them to instant fade-in same as the existing PB callout.

### 5.7 Visual density check

With all three optional sections firing PLUS the existing modal content (placement banner, portrait, stats, podium, rewards, CTAs), the modal becomes scroll-heavy on small screens. Implementation MUST mockup the worst case (all three fire on a 720p mobile viewport) before writing modal CSS. If overflow risk, collapse PB delta + streak + daily rank into a single "Reef Race highlights" panel with three rows.

---

## 6. Snapshot/protocol additions

`packages/shared/src/activities/protocol.ts`:

### 6.1 New event types

```ts
| {
    /**
     * Phase 4 — streak milestone (5/10/20/30/36 clean checkpoint
     * crosses in a row). Edge-triggered. HUD shows a glow + sound.
     * S2 FIX — milestones compressed from 7 to 5 to match tier-kind union.
     */
    type: 'event.streak_milestone';
    petId: string;
    streak: number;
    kind: 'tier-1' | 'tier-2' | 'tier-3' | 'tier-4' | 'perfect';
  }
```

NOTE: `event.checkpoint_clean` is INTENTIONALLY NOT added — bandwidth would be 36×8/match. Streak progression rides `EntityDelta.changed.streak`.

### 6.2 EntityDelta extension

`EntityDelta.changed` is already an open `[k: string]: unknown` record — Phase 4 adds:

```ts
// Implicit (already typed open) fields the server now writes:
//   streak: number          - current streak run
//   bestStreak: number      - high-water this match
```

Client-side TypeScript narrowing happens in `applyEntityDelta` (activity.ts) — same pattern as `driftSparks` (line 332-335 / 349-351). Old clients ignore the new fields (no runtime error, no display).

### 6.3 RoomMeta extension

```ts
// In RoomMeta interface (protocol.ts:138-184), ADD after reefRacingProfiles:
/**
 * Phase 4 — self pet's PB ghost replay frames. `null` for non-Reef-Race
 * rooms or pets without a PB row. ~3-5 KB at 5 Hz capture. Sent ONCE in
 * snapshot.init — never updated mid-match. Self pet only (no rivals).
 */
selfBestLapGhost?: GhostFrame[];
```

Where `GhostFrame` is moved from the client-only `reef-race-types.ts:73-80` to `packages/shared/src/activities/protocol.ts` so the server can import the same type. The client file re-exports for backward compat.

### 6.4 Match-end extension — S7 FIX (per-recipient semantics)

```ts
// In RewardPreview (protocol.ts:128-135), ADD optional fields:
export interface RewardPreview {
  placement: number;
  tokens: number;
  leaderboardPoints: number;
  isPersonalBest?: boolean;
  firstPlayOfDayBonus?: boolean;
  focusBonus?: boolean;
  // Phase 4 additions — Reef Race only.
  pbDelta?: {
    newMs: number;       // the new best lap (or current if no improvement)
    oldMs: number | null;  // null = first PB ever
    /**
     * S7 FIX — Replay frames for the freshly-set PB. Included ONLY in the
     * recipient's OWN match-end frame (i.e., the player who set the PB
     * receives their frames; rivals receive pbDelta WITHOUT newGhostFrames).
     * The server emits per-recipient match-end frames via safeSend(ws, …),
     * gating this field on `ws.data.identity.petId === pbDelta.petId`. */
    newGhostFrames?: GhostFrame[];
    /** C2 FIX — daily rank for the just-set PB (1-100), null if off-board.
     *  Computed in maybeUpdatePersonalBest via single indexed scan against
     *  the freshly-written row. NOT cached. */
    dailyRank: number | null;
  };
  streakBest?: number;     // best streak this match
  perfectLapBonus?: number;  // +tokens credited for ≥36 streak (0 otherwise)
}
```

**S7 FIX — broadcast semantics, explicit.** `event.match_ended` is emitted via the existing per-recipient `safeSend(ws, frame)` pattern (NOT room-wide `broadcastFn`). For each WS connection in the room:

```ts
for (const ws of room.connections) {
  const recipientPetId = ws.data.identity?.petId;
  const ownResult = simResults.find(r => r.petId === recipientPetId);
  const matchEndedFrame = {
    type: 'event.match_ended',
    rewardPreview: {
      ...ownResult.rewardPreview,
      pbDelta: ownResult.pbDelta && {
        ...ownResult.pbDelta,
        // ONLY include newGhostFrames for the pet that earned the PB.
        newGhostFrames: ownResult.pbDelta.newGhostFrames,  // already gated upstream
      },
    },
  };
  safeSend(ws, matchEndedFrame);
}
```

Total per-match WS payload: ~5 KB ghost frames × 1 recipient (the PB-setter) = ~5 KB peak. Other recipients get a pbDelta block of ~50 bytes. Bandwidth-bounded, no N² blowup.

`event.match_ended` already has `rewardPreview: RewardPreview` — no envelope change.

### 6.5 Authoritative `GET /api/activities/:id/rooms/:roomId/results` extension

Add the same optional fields to the response per-row shape (`activities.ts:731-744`):

```ts
{
  ...existing fields,
  // Reef Race only — null otherwise:
  bestLapMs: number | null,        // body.bestLapMsSoFar
  pbDelta: { newMs, oldMs, dailyRank } | null,
  streakBest: number | null,
  perfectLapBonus: number | null,
}
```

**C2 fix.** `dailyRank` here is sourced from the same `maybeUpdatePersonalBest` result as the WS event — when the user re-fetches via this endpoint after match-end, the value matches what they saw in the WS frame. The endpoint does NOT call `getDailyBestLapSnapshot()` to compute rank (would re-introduce the cache race); it joins to a per-pet `match_pb_rank` column on `activity_results` written by the pipeline.

Phase 4 stores the per-match streak best AND the dailyRank-at-match-end on NEW columns:

```sql
-- match_best_streak — Reef Race only, null for other activities.
ALTER TABLE activity_results ADD COLUMN match_best_streak integer;
COMMENT ON COLUMN activity_results.match_best_streak IS
  'Reef Race only — best consecutive clean checkpoint crosses this match. Null for other activities.';

-- match_pb_daily_rank — Reef Race only, null when no PB improvement.
ALTER TABLE activity_results ADD COLUMN match_pb_daily_rank integer;
COMMENT ON COLUMN activity_results.match_pb_daily_rank IS
  'Reef Race only — daily-best-lap rank (1-100) earned by this match if it set a new PB. Null otherwise.';
```

**S3 FIX.** Renamed `best_streak` → `match_best_streak` to disambiguate from "personal best streak" (which we don't track yet). Comment makes the Reef-Race-only nature explicit.

Migration generated in same `0005` file as §1.1 (additive, no destructive change). Reward pipeline writes both columns in the same `INSERT ... VALUES` at `reward-pipeline.ts:274-289`.

---

## 7. Tests

### 7.1 PB persistence (server)

`apps/api/src/services/activity/__tests__/reef-race-personal-best-service.test.ts` (NEW):

- `maybeUpdatePersonalBest writes new row when no PB exists` — assert `improved=true, dailyRank=1` (only entry).
- `maybeUpdatePersonalBest UPDATES row when newBestLapMs < existing` — assert `improved=true, previousMs=<old>`.
- `maybeUpdatePersonalBest NO-OP when newBestLapMs >= existing` — assert `improved=false, dailyRank=null`.
- `maybeUpdatePersonalBest skipped for bots` — call site test in `reward-pipeline.test.ts`.
- `maybeUpdatePersonalBest stores ghostReplayData verbatim` — round-trip a 200-frame array.
- `maybeUpdatePersonalBest invalidates daily-best-lap cache on improvement` — write a PB, immediately re-query `getDailyBestLapSnapshot()`, assert new entry visible (C2 fix test).
- `maybeUpdatePersonalBest invalidates pb-ghost cache on improvement` — write a PB, call `loadPersonalBestGhostFrames(petId)`, assert returns the freshly-set frames (S4 fix test).
- `maybeUpdatePersonalBest computes correct dailyRank against existing rows` — seed 5 rows, write a PB that lands rank 3, assert `dailyRank=3`.
- `loadPersonalBest returns the row for a pet` / `returns null when none`.
- DB-mocked via the same `mock()` pattern as `reward-pipeline.test.ts:16` (Bun test `mock` helper).

### 7.2 Sim — frame capture

`apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` ADD:

- `captures ghost frames at 5 Hz for the active body` — drive 60 ticks (2 sec at 30 Hz), expect ~10 frames in `body.currentLapFrames`.
- `clears currentLapFrames on lap-up` — drive a full lap, then assert length is 1 after the lap-up tick (the synthetic t=0 anchor — S6 fix).
- **`clears currentLapFrames on under-MIN-LAP lap discard` (C1 FIX TEST)** — drive a fake start-line cross at lapMs=5000 (< MIN_LAP_MS=15000), assert `body.currentLapFrames.length === 0` after the discard, then drive a legit lap and assert `bestLapFrames` contains ONLY frames from the legit lap (no Frankenstein).
- `bestLapFrames captures from FIRST lap if it's the only/best lap` — drive 1 lap, assert `body.bestLapFrames` has the captured array.
- `bestLapFrames REPLACED when later lap is faster` — drive 2 laps with the second one shorter, assert bestLapFrames matches the second lap.
- `SimResultRow.reefRace.ghostReplayFrames is populated by computeResults` — full integration through the public sim accessor (C3 fix integration).
- `SimResultRow.reefRace.bestStreakThisMatch is populated by computeResults` — drive a perfect run, assert `simResult.reefRace.bestStreakThisMatch === 36`.
- `SimResultRow.reefRace data persists after endRound clears state.bodies` — call computeResults, then endRound, assert simResults still has the embedded data (C3 fix lifecycle test).

### 7.3 PB load (snapshot.init)

`apps/api/src/services/activity/__tests__/activity-ws-hub.test.ts` ADD:

- `snapshot.init carries selfBestLapGhost when pet has a PB row` — fixture: insert row, connect WS, assert frame.
- `snapshot.init omits selfBestLapGhost for non-Reef-Race rooms`.
- `snapshot.init omits selfBestLapGhost for bots`.
- `snapshot.init omits selfBestLapGhost for guest sockets without ws.data.identity` — no error, no frame field.

### 7.4 Streak counter

`reef-race-sim.test.ts` ADD:

- `currentStreak increments on consecutive clean checkpoint crosses`.
- `currentStreak resets to 0 on a wide hairpin verdict`.
- `bestStreakThisMatch is the high-water mark`.
- `non-hairpin checkpoints count as clean automatically` — drive a pure-straight lap, expect streak to advance.
- `event.streak_milestone fires at 5, 10, 20, 30, 36 only` — drive 36 clean crosses, assert exactly 5 events with kinds tier-1, tier-2, tier-3, tier-4, perfect (S2 fix test).
- **`streak survives lap boundary if the lap-up checkpoint is clean` (S1 FIX TEST)** — fixture: enter lap-1 final hairpin clean, cross start/finish, enter lap-2 first hairpin → assert verdict map clear at lap-up AND streak += 1 only when the new-lap apex resolves clean.
- `lastApexVerdictByHairpin keyed by (lap, cpIdx) prevents cross-lap stale read` — fixture: lap 1 hairpin 9 verdict 'clean', lap 2 enters cp 9 BEFORE resolveApex re-fires, assert isCheckpointCrossClean returns false (key `2-9` not present, NOT a stale `9` hit).

### 7.5 Lobster of the day

`apps/api/src/services/activity/__tests__/reef-race-daily-best-service.test.ts` (NEW):

- `getDailyBestLapSnapshot returns rows ordered by bestLapMs ASC`.
- `getDailyBestLapSnapshot excludes rows older than 24h`.
- `getDailyBestLapSnapshot excludes guest pets`.
- `getDailyBestLapSnapshot caches for 60s` — assert second call within window doesn't re-query DB (mock SELECT counter).
- `getDailyBestLapSnapshot honors limit param` — insert 150 rows, request limit=10, expect 10 entries.
- `invalidateDailyBestLapCache forces fresh read` — populate cache, invalidate, assert next call re-queries DB.

`apps/api/src/routes/__tests__/leaderboard.test.ts` (NEW or extended):

- `GET /api/leaderboard/reef-race/daily-best-lap returns 200 + correct shape`.
- `GET /api/leaderboard/reef-race/daily-best-lap rate-limits at 60/min/IP via dailyBestLapLimiter (S5 fix)` — assert NOT shared with /agents bucket (drain 60 on /agents, then /reef-race/daily-best-lap still allowed).
- `GET /api/leaderboard/reef-race/daily-best-lap public — no auth required`.

### 7.6 Match-end results

`apps/api/src/services/activity/__tests__/reward-pipeline.test.ts` ADD:

- `issueRewardsForRoom credits perfect-lap bonus when bestStreak >= 36` — assert tokens include +25.
- `issueRewardsForRoom skips perfect-lap bonus when bestStreak < 36`.
- `issueRewardsForRoom triggers PB write when newBestLapMs < priorBestMs` — assert `maybeUpdatePersonalBest` mock awaited (C2 fix test).
- `issueRewardsForRoom skips PB write for bots`.
- `issueRewardsForRoom emits pbDelta.newGhostFrames in PB-setter's match-end frame ONLY` (S7 fix test) — assert recipient WS gets frames; rival WS does not.
- `issueRewardsForRoom embeds dailyRank from awaited PB write into match-end frame` (C2 fix test) — assert `pbDelta.dailyRank` equals the rank returned by the (mocked) `maybeUpdatePersonalBest`.
- `issueRewardsForRoom reads bestStreakThisMatch from SimResultRow.reefRace, not from a live accessor` (C3 fix test) — fixture mocks state.bodies as cleared post-computeResults; assert pipeline still credits the bonus.

### 7.7 Anti-cheat — PB skip on flagged match

`reward-pipeline.test.ts` ADD:

- `issueRewardsForRoom skips PB write when pet has ≥1 anti-cheat flag in the match`.

### 7.8 Client store

`apps/web/src/stores/__tests__/activity.test.ts` (if exists, else add new):

- `setGhostPath populates reefRace.selfBestGhostPath`.
- `event.streak_milestone updates selfStreak when self pet`.
- `EntityDelta.changed.streak updates entity.streak`.
- `event.match_ended.pbDelta.dailyRank updates selfDailyBestLapRank`.

---

## 8. Risks + mitigations

| Risk | Mitigation |
|---|---|
| **DB write at match end** | 1 INSERT per pet per match (PB) + 1 UPDATE per `activity_results` (perfect bonus column) + 1 indexed scan for dailyRank. Bound: ~5 matches/min × 8 players = 40 writes/min + 40 scans/min. Trivial vs. Supabase paid-tier capacity. |
| **`ghost_replay_data` JSONB size** | 5 Hz capture cap = 250 frames × ~24 B serialized = 6 KB worst case. Storage at 1000 active pets = 6 MB total — negligible on Supabase. JSONB compression makes it ~half that on disk. |
| **Mid-match server crash kills replay capture** | The current frame ring buffer is in-process. A crash loses the in-progress lap's frames — same blast radius as the existing replay log buffer (already accepted risk per `activity-room-manager.ts:887` flush-on-end semantics). PB stays as the previous match's. |
| **Anti-cheat for daily leaderboard** | (1) PB only writes after match ENDS (no premature disconnect), (2) `MIN_LAP_MS=15s` blocks teleport laps via existing `validateLapTime` AND C1 fix prevents discarded-lap frame contamination, (3) any pet with anti-cheat flag in the match has PB write skipped, (4) bot + guest carve-outs in SQL. |
| **Per-body streak state cleanup** | Streak fields live on the `ReefBody` object — automatic GC when `state.bodies` is cleared in `endRound`. **C3** ensures the data is extracted into `SimResultRow.reefRace` BEFORE teardown so the reward pipeline never depends on live state. Same pattern as `apexCheckedThisLap`. |
| **PB ghost on LIVE rivals** | Spec: self only. Server NEVER sends `selfBestLapGhost` for any pet other than the connecting one's identity. WS hub gates on `ws.data.identity.petId`. **S7** clarifies match-end ghost frames also gate on per-recipient identity. |
| **Per-frame allocation regression** | Frame capture allocates ONE GhostFrame literal per body per (tick % 6) — 5 Hz × 8 bodies = 40 allocs/sec. Below the per-frame budget. Material list is memoized in `ReefRaceGhost.tsx:useMemo`. |
| **Stat-driven body multipliers don't apply to streak** | Confirmed: streak is a pure mechanic over checkpoint-cross transitions; no body multipliers needed. Stat-tweaked body just makes hitting the apex easier (Phase 3 effect), which is fine. |
| **Frame rate change (10 → 5 Hz) breaks existing client expectations** | Verified: `findGhostFrames` lerps for arbitrary rate. The `GHOST_SAMPLE_HZ` constant on the client is documentation only — no integer divisions hard-code 10. Updating the constant in same diff keeps docs honest. |
| **`event.match_ended` payload bigger** | Reef-race only. New `pbDelta.newGhostFrames` is ~5 KB, fires at most ONCE per match (and only when PB improved). **S7** confirms per-recipient delivery — only the PB-setter receives the frames. Per-match, per-recipient cost. |
| **3da rule** | `ReefRaceGhost.tsx` + `ReefRaceScene.tsx` mount = 3D code. `3da` MUST be spawned to write/edit those changes. PB write, streak sim, leaderboard route, modal extensions are NOT 3D — orchestrator owns. |
| **Daily-best-lap cold cache** | First request after server restart hits PG with the index-only scan. Worst case <50 ms at 1000 PB rows. 60s cache absorbs the rest. |
| **Daily-best-lap cache stale post-write** | **C2 fix.** `invalidateDailyBestLapCache()` called from `maybeUpdatePersonalBest` on every successful upsert; next public read sees fresh data within one round-trip. |
| **dailyRank race with public cache** | **C2 fix.** `dailyRank` in match-end payload is computed via single indexed scan inside `maybeUpdatePersonalBest`, NOT via the cached snapshot. Always reflects the just-written row. |
| **PB ghost cache stale post-write** | **S4 fix.** `invalidatePbGhostCache(petId)` called from `maybeUpdatePersonalBest`; reconnect within 5-min TTL sees freshly-set ghost. |
| **Sub-MIN_LAP frame contamination** | **C1 fix.** `body.currentLapFrames.length = 0` cleared in BOTH the discard branch (sim.ts:1554 area) AND the success branch — guaranteed monotonic `t` in saved replay. |
| **Streak-cross-lap stale verdict** | **S1 fix.** `lastApexVerdictByHairpin` keyed by `${lap}-${cpIdx}` AND cleared at lap-up. No cross-lap collision possible. |
| **Rate-limiter contention with /agents** | **S5 fix.** Separate `dailyBestLapLimiter` instance; multi-tab leaderboard browsing doesn't blow the agents budget. |
| **Migration order** | `0005_reef_race_personal_bests.sql` is purely additive (new table + two new columns on activity_results). `bun run db:push` applies cleanly. Per CLAUDE.md, run before deploy. |
| **Same-diff doc updates** | `GameFeatures.md` (PB ghost, streak, daily-fastest-lap, perfect-lap bonus), `ARCHITECTURE.md` (new table, new route, new event types, new columns), `3dStructure.md` (PB ghost mounted in scene), `town-guide.ts` knowledge[] (4 substantive entries — see §11). All MUST land same diff per project rules. |

---

## 9. File-by-file scope

| Path | Type | Owner | Lines (est) | Notes |
|---|---|---|---|---|
| `packages/database/src/schema/reef-race-personal-bests.ts` | NEW | orchestrator | ~50 | New PG table + types |
| `packages/database/src/schema/index.ts` | MOD | orchestrator | +1 | export new schema |
| `packages/database/src/schema/activity-results.ts` | MOD | orchestrator | +6 | add `match_best_streak` + `match_pb_daily_rank` columns (S3 fix) |
| `packages/database/drizzle/0005_reef_race_personal_bests.sql` | NEW | orchestrator | ~35 | additive migration (table + 2 columns + comments) |
| `packages/database/drizzle/meta/0005_snapshot.json` | NEW | orchestrator | ~120 | drizzle-kit auto-generated |
| `packages/shared/src/activities/protocol.ts` | MOD | orchestrator | +55 | move `GhostFrame` here, add `selfBestLapGhost` to RoomMeta, extend RewardPreview (incl. dailyRank, S7 per-recipient newGhostFrames), add `event.streak_milestone` |
| `packages/shared/src/activities/reef-race-streak.ts` | NEW | orchestrator | ~30 | shared `STREAK_MILESTONES`, `streakMilestoneKind` (N4 single-source-of-truth) |
| `packages/shared/src/activities/activities.ts` | MOD | orchestrator | +5 | `perfectStreakBonusTokens` in reef-race rewardConfig |
| `apps/web/src/lib/three/activities/reef-race/reef-race-types.ts` | MOD | 3da | +5 | re-export GhostFrame from shared |
| `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts` | MOD | orchestrator | +3 | `GHOST_SAMPLE_HZ` 10 → 5 + comment update |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceGhost.tsx` | MOD | 3da | +40 | per-lap fade, material list memo, settings gate, mount-only-if-self |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceScene.tsx` | MOD | 3da | +5 | mount `<ReefRaceGhost />` |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | MOD | orchestrator | +130 | frame capture (incl. C1 dual-branch clear + S6 synthetic t=0 anchor), streak fields (S1 keyed by lap+cp), `event.streak_milestone` broadcast (S2 5-tier), EntityDelta.streak field, `computeResults()` embeds reefRace block into SimResultRow (C3) |
| `apps/api/src/services/activity/sim/reef-race-config.ts` | MOD | orchestrator | +20 | `STREAK_MILESTONES`, `streakMilestoneKind`, `TOTAL_CHECKPOINTS_PER_RACE`, `GHOST_CAPTURE_HZ`, `MAX_GHOST_FRAMES_PER_LAP` |
| `apps/api/src/services/activity/reef-race-personal-best-service.ts` | NEW | orchestrator | ~140 | `maybeUpdatePersonalBest` (with awaited dailyRank scan + dual cache invalidation per C2/S4), `loadPersonalBest`, `loadPersonalBestGhostFrames` + 5-min in-memory cache + `invalidatePbGhostCache` |
| `apps/api/src/services/activity/reef-race-daily-best-service.ts` | NEW | orchestrator | ~110 | `getDailyBestLapSnapshot`, 60s cache, `invalidateDailyBestLapCache` |
| `apps/api/src/services/activity/reward-pipeline.ts` | MOD | orchestrator | +70 | thread `simResult.reefRace` into pipeline, perfect-lap bonus computation (C3 — read from SimResultRow not live accessor), AWAITED PB write per pet (C2), per-recipient match-end emit (S7 — `safeSend(ws, …)` gated on identity), anti-cheat-flag PB skip, write `match_best_streak` + `match_pb_daily_rank` columns |
| `apps/api/src/services/activity/activity-room-manager.ts` | MOD | orchestrator | +5 | call `computeResultsFn(room)` BEFORE `endRound` (already the case — verify ordering); pass `simResults` directly to pipeline (no `getStreaksByPet` accessor — C3) |
| `apps/api/src/services/activity/activity-ws-hub.ts` | MOD | orchestrator | +15 | load self-pet PB ghost, attach to RoomMeta in snapshot.init |
| `apps/api/src/routes/leaderboard.ts` | MOD | orchestrator | +40 | new `GET /reef-race/daily-best-lap`, NEW `dailyBestLapLimiter` (S5 — does not share with `agentLeaderboardLimiter`), response shape |
| `apps/api/src/routes/activities.ts` | MOD | orchestrator | +30 | extend `GET /:id/rooms/:roomId/results` to read Phase-4 columns directly from activity_results (no JOIN to PB row needed for rank — C2: rank is already persisted on the per-match row) |
| `apps/web/src/stores/activity.ts` | MOD | orchestrator | +60 | `selfStreak`, `selfBestStreakThisMatch`, `selfDailyBestLapRank` in ReefRaceState; handlers for `event.streak_milestone`, EntityDelta.streak, snapshot.init `selfBestLapGhost`, match-end `pbDelta.newGhostFrames` |
| `apps/web/src/components/game/reef-race-hud.tsx` | MOD | orchestrator | +35 | streak indicator chip + tier-coded glow (imports `streakMilestoneKind` from shared — N4) + reset flash |
| `apps/web/src/components/game/activity-results-modal.tsx` | MOD | orchestrator | +90 | activity label fix, PB delta block, streak section, daily rank section, plumb authoritative response |
| `apps/web/src/app/leaderboard/page.tsx` | MOD | orchestrator | +120 | tab group (Agents | Lobster of the day), daily-best-lap fetch hook, ranked table component |
| `packages/agent-templates/src/locations/town-guide.ts` | MOD | orchestrator | ~25 | knowledge[] — 4 substantive entries per §11 (S8 fix) |
| `apps/api/src/services/activity/__tests__/reef-race-personal-best-service.test.ts` | NEW | orchestrator | ~160 | §7.1 (incl. C2/S4 cache-invalidation tests, dailyRank scan test) |
| `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | MOD | orchestrator | +160 | §7.2 + §7.4 cases (incl. C1 discard test, S1 lap-keyed verdict test, C3 lifecycle test) |
| `apps/api/src/services/activity/__tests__/activity-ws-hub.test.ts` | MOD | orchestrator | +60 | §7.3 cases (incl. guest socket no-error case) |
| `apps/api/src/services/activity/__tests__/reef-race-daily-best-service.test.ts` | NEW | orchestrator | ~110 | §7.5 (incl. invalidate test) |
| `apps/api/src/routes/__tests__/leaderboard.test.ts` | NEW or MOD | orchestrator | +70 | §7.5 route tests (incl. S5 separate-bucket test) |
| `apps/api/src/services/activity/__tests__/reward-pipeline.test.ts` | MOD | orchestrator | +110 | §7.6 + §7.7 cases (incl. C2 awaited-PB test, C3 SimResultRow-not-live-accessor test, S7 per-recipient frame test) |
| `apps/web/src/stores/__tests__/activity.test.ts` | NEW or MOD | orchestrator | +50 | §7.8 |
| `GameFeatures.md` | MOD | orchestrator | +30 | Phase 4 mechanics: PB ghost, streak, lobster-of-the-day, perfect-lap bonus |
| `ARCHITECTURE.md` | MOD | orchestrator | +25 | new table + route + event in tables of routes/DB; new columns on activity_results |
| `3dStructure.md` | MOD | 3da | +12 | PB ghost mount, fade timeline, opacity budget, settings gate |

**TOTAL CODE EST:** ~1200 lines added/modified, ~720 lines test, 3 doc updates.

---

## 10. New tables (DB migration)

### 10.1 `reef_race_personal_bests` — full schema

See §1.1. Drizzle file at `packages/database/src/schema/reef-race-personal-bests.ts`.

### 10.2 Generated SQL

```sql
-- packages/database/drizzle/0005_reef_race_personal_bests.sql

CREATE TABLE IF NOT EXISTS "reef_race_personal_bests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "pet_id" uuid NOT NULL,
  "activity_id" text NOT NULL DEFAULT 'reef-race',
  "best_lap_ms" integer NOT NULL,
  "best_lap_recorded_at" timestamptz NOT NULL DEFAULT now(),
  "source_room_id" uuid,
  "ghost_replay_data" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reef_race_personal_bests_pet_fk"
    FOREIGN KEY ("pet_id") REFERENCES "pets"("id"),
  CONSTRAINT "reef_race_personal_bests_room_fk"
    FOREIGN KEY ("source_room_id") REFERENCES "activity_rooms"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_reef_race_pb_pet_activity"
  ON "reef_race_personal_bests" ("pet_id", "activity_id");

CREATE INDEX IF NOT EXISTS "idx_reef_race_pb_recorded_lap"
  ON "reef_race_personal_bests" ("best_lap_recorded_at" DESC, "best_lap_ms" ASC)
  WHERE "activity_id" = 'reef-race';

-- Phase 4 — best-streak surfaced on per-match results so /results endpoint can
-- return it without a JOIN. Nullable so legacy rows backfill as null.
-- S3 FIX — renamed best_streak → match_best_streak for clarity.
ALTER TABLE "activity_results"
  ADD COLUMN IF NOT EXISTS "match_best_streak" integer;
COMMENT ON COLUMN "activity_results"."match_best_streak" IS
  'Reef Race only — best consecutive clean checkpoint crosses this match. Null for other activities.';

-- C2 FIX — daily-best-lap rank for the just-set PB persisted on the per-match
-- row so /results endpoint can return it without a cache round-trip.
ALTER TABLE "activity_results"
  ADD COLUMN IF NOT EXISTS "match_pb_daily_rank" integer;
COMMENT ON COLUMN "activity_results"."match_pb_daily_rank" IS
  'Reef Race only — daily-best-lap rank (1-100) earned by this match if it set a new PB. Null otherwise.';
```

Migration is **purely additive** — no DROPs, no data rewrites, no destructive ALTER. Safe to run on prod via `bun run db:push` per CLAUDE.md "Database migrations".

### 10.3 Migration ordering

- Migration 0005 lands first.
- Server code that READS `reef_race_personal_bests` ships next (after migration confirmed live in prod via `psql \dt`).
- Server code that WRITES `reef_race_personal_bests` ships in the same deploy as the read-side (writers don't fire until a Reef Race match ends, by which time the table exists).
- Client code (modal, leaderboard tab, ghost mount) ships in the same deploy. Ghost component returns `null` cleanly when `selfBestLapGhost` is `undefined` → backwards-compatible with old servers.

---

## 11. Town Guide knowledge entries (S8 fix)

`packages/agent-templates/src/locations/town-guide.ts` `knowledge[]` MUST add the following four substantive entries (per CLAUDE.md mandatory town-guide-knowledge-sync rule). These cover every player-facing surface introduced in Phase 4 — Nori can answer "what is the ghost?", "what's the streak about?", "where do I find lobster of the day?", and "what just happened in my match-end?".

```ts
// In packages/agent-templates/src/locations/town-guide.ts knowledge[]:

`Reef Race PB ghost: when you've finished at least one Reef Race match
and set a personal best lap, your fastest lap replays as a translucent
sea-horse ghost on every subsequent run. Only YOU see your own ghost —
not other racers'. The ghost fades in over the first 0.5 sec of each
lap and out over the last 0.5 sec. Toggle it off in Reef Race settings
if it distracts you (default ON). Beating your ghost = setting a new PB.`,

`Reef Race streak counter: the HUD chip in the top-right shows your
current run of consecutive clean checkpoint crosses. A cross is "clean"
when you're inside the apex zone for hairpin checkpoints (cps 3 and 9
on each lap), and automatically clean for the 10 non-hairpin checkpoints.
Wide on a hairpin = streak resets to 0. Total checkpoints in a 3-lap race
is 36; hitting 36 = perfect race = +25 ClawToken bonus. Milestone glows
fire at 5, 10, 20, 30, and 36.`,

`Lobster of the Day: the public /leaderboard page has two tabs —
"Agents" (the existing free contribution-based ranking) and "Lobster
of the Day" (Reef Race fastest single lap in the last 24 hours, top
100). The #1 entry gets a gold "🦞 LOBSTER OF THE DAY" card. Updates
every 60 seconds + within one round-trip of any new PB. Anti-cheat:
sub-15-second laps are discarded, anti-cheat-flagged matches don't
write a PB, bots and guests are excluded.`,

`Reef Race match-end summary: after every Reef Race match the results
modal can show up to three Reef-Race-specific sections in addition to
the standard placement / podium / rewards. (1) PB delta — your new
fastest lap and the previous best, with the time saved. (2) Perfect-line
streak — your best run of clean checkpoint crosses this match, and the
+25 token bonus if you hit 36/36. (3) Daily rank — if your new PB lands
in the top 100 fastest laps of the last 24 hours, the modal shows your
"#N LOBSTER OF THE DAY" rank.`,
```

Test `system-npc-seeder` re-chunks these into RAG on next API boot — verify by chatting "tell me about the ghost" with Nori after deploy.

---

## Out of scope (do NOT expand Phase 4)

- Per-rival ghosts (only self ghost — too crowded per spec §2).
- Animated ghost trail (the `<Trail>` is for the live player only — ghost has no trail per existing comment in `ReefRaceGhost.tsx:16`).
- Final art for ghost (semi-transparent sea_horse.glb is the ship-art).
- Replay-of-best-lap viewer (ghost is the LIVE-during-race surface; deferring a video replay).
- Daily-best-lap social card / share image (post-Phase-4 polish).
- Cross-activity perfect streaks / leaderboards beyond Reef Race.
- Live mid-match ghost-path swap when current lap beats PB (deferred per §2.5).
- Bot ghosts (bots have no PB by design).
- Daily-best-lap notification system (no email / push — pure pull surface).
