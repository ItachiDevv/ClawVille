# Reef Race — Phase 4 (FINAL) detailed implementation plan

**Status:** Plan locked 2026-04-24. Awaiting audit.
**Owners:** orchestrator (PB persistence + streak sim hooks + leaderboard route + match-end UI), 3da (PB ghost client wiring + fade), reef-race-bot (no scope — bots have no PB ghost / no streak rewards).
**Previous phases:** 1 (drift + launch boost) merged; 2 (slipstream + apex + ribbons + hazards + placement-weighted items) merged; 3 (stat connection) merged. All on master via `worktree-fix-bumper-build`.
**Plan reference:** `.claude/plans/reef-race-real-racing.md` §Phase 4.

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

**Decision (locked, see §1.1):** create a NEW table `reef_race_personal_bests` for the per-lap-best + ghost replay payload. DO NOT extend `activity_results` — that table is per-match (one row per finish), Phase 4 needs per-pet (one row per lifetime PB lap) and a JSONB blob whose size (~13 KB) doesn't belong in a per-match row.

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

Decision rationale: extending `activity_results` was rejected because (a) one row per match vs. one row per lifetime-best-lap is a different cardinality, (b) ghost replay JSONB (~13 KB compressed) bloats the per-match row that's hot for leaderboard scans, (c) per-match `score_ms` is a finish time (3-lap total) not a single lap; we'd be conflating two metrics. New table is additive, has a clean unique constraint, and indexes are tiny.

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
  // ordering index-only.
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
}

/** Atomic upsert: write only when newBestLapMs < existing.bestLapMs. */
export async function maybeUpdatePersonalBest(input: PbWriteInput): Promise<PbWriteResult>;

/** Read latest PB for pet (hot path: snapshot.init for self pet). */
export async function loadPersonalBest(petId: string): Promise<ReefRacePersonalBest | null>;
```

Implementation notes:
- `maybeUpdatePersonalBest` uses `INSERT ... ON CONFLICT (pet_id, activity_id) DO UPDATE SET ... WHERE EXCLUDED.best_lap_ms < reef_race_personal_bests.best_lap_ms RETURNING ...` — single round-trip atomic compare-and-set. The `RETURNING` lets us know whether the row actually got updated (improved=true) vs. predicate matched but kept (improved=false).
- Bots are skipped at the call site (`participant.subjectType === 'bot'`). Guests are NOT skipped — guests can have PBs (matches §0.4 reward logic; guests still earn tokens, but their daily-leaderboard surface fires the same anti-bot SQL filter as `activity-leaderboard-service.ts:117-120`).

### 1.3 When PB is UPDATED

In `apps/api/src/services/activity/reward-pipeline.ts` `issueRewardsForRoom()`:

- After the existing `db.transaction` block that writes `activity_results` rows (line 223-331), add a fire-and-forget pass that walks `simResults` and, for `room.activityId === 'reef-race'` only, calls `maybeUpdatePersonalBest()` for each non-bot participant with a complete lap.
- The PB write is INTENTIONALLY OUTSIDE the rewards transaction. Rationale: PB write failure must not roll back the actual reward credit (token debit). PB is best-effort — re-deriveable from replay log + `activity_results` if needed.
- Per the task constraint (`ALL new DB writes are async fire-and-forget`): the PB write is `void maybeUpdatePersonalBest(...)`. Errors get console.error + `alertError({severity: 'warning'})`. We do NOT await it.

**Where does the per-lap split + ghost replay data come from?** The sim resolver currently returns `SimResultRow[]` from `reefRaceSim.computeResults()` — a placement list with `score`, `scoreMs`, `placement` only. Phase 4 extends `SimResultRow` (or adds a parallel `getReefRacePerLapResults(roomId): ReefRacePerLapResult[]` accessor on `reefRaceSim`) to surface:

```ts
interface ReefRacePerLapResult {
  petId: string;
  bestLapMs: number;            // min(body.lapSplitsMs[])
  bestLapIndex: number;         // 0-indexed lap that produced the best split
  ghostReplayFrames: GhostFrame[];  // captured from the sim — see §1.4
}
```

`reefRaceSim.getReefRacePerLapResults(roomId)` is implemented in §1.4. The reward pipeline calls it once per Reef Race room and joins to `simResults` by `petId` for the PB pass.

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
/** Ring buffer of frames for the CURRENT lap. Cleared on lap-up. */
currentLapFrames: GhostFrame[];
/** Snapshot of currentLapFrames at the moment the BEST lap closed. null until first lap finished. */
bestLapFrames: GhostFrame[] | null;
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
  }
}
```

Frame capture cap: hard limit 250 frames per body (= 50 sec lap @ 5 Hz). At cap, oldest frame drops (FIFO `shift()`). 50 sec is safely above legitimate lap times; a 50+ sec "lap" is either a reset or anti-cheat triggered (`MIN_LAP_MS = 15s` is the floor; the implicit ceiling is the soft timeout at 90 sec for the whole 3-lap race).

Per-frame allocation guard: `currentLapFrames` is initialized as `[]` at body init, reused via `push` + `shift` only. The `GhostFrame` object literal in the push site IS one allocation per body per tick-modulo-6 — that's 8 bodies × 5 Hz = 40 allocations/sec. Acceptable; the alternative (a typed-array ring buffer) is over-engineered for 200 short-lived frames per match.

On lap completion (`reef-race-sim.ts:1558` after `body.lap += 1`):

```ts
// If this lap is the best so far, snapshot the current-lap frames.
const isBestLapSoFar =
  body.bestLapFrames === null || lapMs < Math.min(...body.lapSplitsMs.slice(0, -1)) ;
//                                                  ↑ everything except the just-pushed lap
if (isBestLapSoFar) {
  // CLONE the array — currentLapFrames clears next, the snapshot must persist.
  body.bestLapFrames = body.currentLapFrames.slice();
}
body.currentLapFrames.length = 0;  // truncate-in-place; keeps the array reference
```

(Refinement: avoid `Math.min(...body.lapSplitsMs.slice(0, -1))` allocating — track `body.bestLapMsSoFar: number | null` field updated inline.)

`reefRaceSim.getReefRacePerLapResults(roomId)` walks `state.bodies`, picks the body with `bestLapFrames !== null`, returns the array of `{petId, bestLapMs, bestLapIndex, ghostReplayFrames}`.

### 1.5 Frame coordinate system — lap-relative `t`

`t` in the captured frame is **milliseconds since `body.lapStartedAt`** (start of the SOURCE lap), NOT wall-clock. Rationale:
- The client's existing `ReefRaceGhost.tsx:101-110` does `Date.now() - raceStartMs % pathDuration`. With lap-relative `t`, the ghost loops over a ~30 sec lap regardless of when the original PB was set (yesterday vs. now).
- Without lap-relative `t`, the client would have to subtract `path[0].t` every frame — the existing code already does (`path[0].t + (elapsedMs % pathDuration)`), so lap-relative just keeps the math the same.
- `findGhostFrames(path, ghostMs)` is unchanged.

### 1.6 PB load path

In `apps/api/src/services/activity/activity-ws-hub.ts:539-557` (the snapshot.init send), after the `reefRacingProfiles` block, add:

```ts
// Phase 4 — pull self pet's PB ghost replay (Reef Race only). Sent once per
// snapshot.init for the SELF pet only (not other racers — too crowded per
// spec §2). Skipped for guests + bots (no PB row).
const selfBestLapGhost =
  room.activityId === 'reef-race' && ws.data.identity
    ? await loadPersonalBestGhostFrames(ws.data.identity.petId)  // see below
    : undefined;
```

`loadPersonalBestGhostFrames(petId): Promise<GhostFrame[] | undefined>`:
- Reads the single row for `(petId, activityId='reef-race')`.
- Returns `ghostReplayData.frames` (typed cast).
- Returns `undefined` on any error (logged via `console.warn`, NOT alertError — missing PB is the common case for fresh pets).
- Hot path: ~50 ms first call, cached for subsequent loads of the same room (cache key: petId). A small in-memory `Map<petId, {frames, expiresAt}>` with 5-min TTL is enough — no eviction loop needed (RAF natural gc when room ends + map size is bounded by concurrent players).

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
  // Was apex resolved as 'clean' for this lap+hairpin?
  return body.apexCheckedThisLap.has(`${body.lap}:${cpIdx}`)
      && body.lastApexVerdictByHairpin.get(cpIdx) === 'clean';
}
```

`body.lastApexVerdictByHairpin: Map<number, 'clean' | 'wide'>` is a NEW per-body field (initialized empty in `addBody()`, updated in `resolveApex` whenever a verdict fires). The `apexCheckedThisLap` set is already checked at `sim.ts:2205` — Phase 4 ADD a parallel verdict-kind cache because today only "was checked" is recorded, not "what was the verdict".

### 3.2 Per-body sim state

```ts
// On ReefBody (reef-race-sim.ts:180-region) ADD:
/** Current run of consecutive clean checkpoint crosses. Resets on dirty cross. */
currentStreak: number;
/** High-water mark of currentStreak across the entire match. */
bestStreakThisMatch: number;
/** Whether the last hairpin verdict per (lap, hairpin) was 'clean'. */
lastApexVerdictByHairpin: Map<number, 'clean' | 'wide'>;
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
  // Edge-trigger event broadcast on milestone hits (5/10/15/20). Avoid
  // per-checkpoint broadcasts — too noisy. Total checkpoints in 3 laps =
  // 12 × 3 = 36, so milestones at 5/10/15/20/25/30 + perfect at 36.
  if (STREAK_MILESTONES.includes(body.currentStreak)) {
    this.broadcastFn(state.roomId, {
      type: 'event.streak_milestone',
      petId: body.petId,
      streak: body.currentStreak,
      kind: streakMilestoneKind(body.currentStreak),  // 'tier-1' | ...
    });
  }
} else {
  // Reset on dirty cross.
  body.currentStreak = 0;
}
```

`STREAK_MILESTONES = [5, 10, 15, 20, 25, 30, 36]` and `streakMilestoneKind()` map are constants in `reef-race-config.ts` (server) — clients need a parallel constant set ONLY for the HUD label (a one-line string-map, not full event semantics).

**Hairpin verdict timing:** apex resolution happens in step 5b BEFORE checkpoint resolution in step 5c (per the existing comment at `sim.ts:917-922` "Phase 2 audit G4 — apex-penalty ... Apex verdicts are evaluated BEFORE checkpoints"). So when `resolveCheckpoints` reads `lastApexVerdictByHairpin`, the value is current to THIS tick. ✓ ordering correct.

**100% perfect:** total checkpoints in 3 laps = 36. Streak ≥ 36 at match-end = perfect race. Reward: see §3.4.

### 3.4 Bonus tokens for 100% perfect streak

Reward configuration in `packages/shared/src/activities/activities.ts` for `reef-race.rewardConfig`:

```ts
// ADD to ActivityRewardConfig:
perfectStreakBonusTokens?: number;  // default 25
```

In `reward-pipeline.ts` `computeBreakdown()`:

```ts
const perfectStreakBonus =
  input.bestStreakThisMatch >= TOTAL_CHECKPOINTS_PER_RACE  // 36
    ? rewardConfig?.perfectStreakBonusTokens ?? 0
    : 0;
```

`computeBreakdown` input grows `bestStreakThisMatch?: number` (default 0 — non-Reef-Race activities omit it, no behaviour change). The `RewardBreakdown` adds `perfectStreakBonus: number` (sums into the same breakdown total). The room manager passes the per-pet streak from sim to the pipeline:

```ts
// In activity-room-manager.ts where computeResultsFn is called:
const simResults = this.computeResultsFn(room);
const perLap = reefRaceSim.getReefRacePerLapResults(room.id);  // §1.3
const streaksByPet = reefRaceSim.getStreaksByPet(room.id);     // NEW accessor
issued = await issueRewardsForRoom({
  room,
  simResults,
  reefRacePerLap: perLap,
  reefRaceStreaks: streaksByPet,  // Map<petId, {currentStreak, bestStreakThisMatch}>
});
```

`reefRaceSim.getStreaksByPet(roomId)` is a new accessor (cheap — walks `state.bodies`).

### 3.5 HUD streak indicator

`apps/web/src/components/game/reef-race-hud.tsx`:

- Read `useActivityStore((s) => s.reefRace?.selfStreak ?? 0)` (new field — see §3.6).
- Render a small chip near the placement tile (top-right of HUD): `🔥 STREAK: 7`.
- Light up at milestones: glow color goes amber (5/10), red (15/20), gold (25/30), rainbow gradient (36+). Use a CSS class table indexed by tier — no per-frame work.
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
- `event.streak_milestone` IS broadcast (≤7 milestones × 8 players = ≤56 events/match — bandwidth trivial).
- `body.currentStreak` ALWAYS goes into `EntityDelta` snapshot diff (added to the existing `buildSnapshot()` output at `sim.ts:1780-1807`) — same shape as `driftSparks`.
- Cost analysis: 12 cps × 3 laps × 8 players = 288 streak field updates per match. Each is a 1-byte int change; well within the existing 5 Hz delta bandwidth.

### 3.8 Per-body teardown

Per-body cleanup (the `addBody` path's mirror) lives in `removeBody` / room teardown. The streak state is in fields directly on the `ReefBody` object — when the body is removed from `state.bodies`, the `lastApexVerdictByHairpin` Map is GC'd along with the body. No explicit cleanup needed.

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

/** 60s in-memory cache. Same TTL pattern as activity-leaderboard-service.ts:56. */
export async function getDailyBestLapSnapshot(limit?: number): Promise<DailyBestLapSnapshot>;
export function invalidateDailyBestLapCache(): void;
```

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
// New route at the public-leaderboard mount point.
leaderboardRoutes.get('/reef-race/daily-best-lap', async (c) => {
  const ip = getClientIp(c.req.raw.headers);
  if (!agentLeaderboardLimiter.check(ip)) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const limit = clampInt(c.req.query('limit'), 100, 1, 100);
  const snap = await getDailyBestLapSnapshot(limit);
  c.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  return c.json(snap);
});
```

Same rate limiter as `/agents` (60/min/IP per CLAUDE.md priority #3). Public — no auth — matching the brand stance "high-visibility public surface".

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
2. **MIN_LAP_MS already enforced.** `validateLapTime(lapMs)` at `sim.ts:1543` discards laps under 15 sec — flagged as `underminlap` anti-cheat. Fast-time exploits via teleport/clip already blocked at the source.
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

Daily rank is computed server-side at PB-write time and returned in `event.match_ended.pbDelta.dailyRank` (see §6).

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

Match-end handler in `applyServerFrame` switch updates these from `event.match_ended.pbDelta` / `streakBest` / `dailyRank`.

### 5.5 "Reef Race" subtitle fix

Replace the hard-coded `'BUMPER SHELLS'` at line 649 with:

```ts
const activityLabel = activityId === 'reef-race' ? 'REEF RACE' : 'BUMPER SHELLS';
```

(Per zero-laziness policy — found a stale string while reading the file, fix it now.)

### 5.6 Reduced-motion respected

The new sections inherit the existing `phases.callout` / animation gating — `prefers-reduced-motion` collapses them to instant fade-in same as the existing PB callout.

---

## 6. Snapshot/protocol additions

`packages/shared/src/activities/protocol.ts`:

### 6.1 New event types

```ts
| {
    /**
     * Phase 4 — streak milestone (5/10/15/20/25/30/36 clean checkpoint
     * crosses in a row). Edge-triggered. HUD shows a glow + sound.
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

### 6.4 Match-end extension

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
    /** Replay frames for the freshly-set PB; null when no improvement. */
    newGhostFrames?: GhostFrame[];
  };
  streakBest?: number;     // best streak this match
  perfectLapBonus?: number;  // +tokens credited for ≥36 streak (0 otherwise)
  dailyRank?: number | null;  // 1-100 if PB lap landed in top 100, else null
}
```

`event.match_ended` already carries `rewardPreview: RewardPreview` — no envelope change.

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

Sourced from `activity_results` row + a JOIN to `reef_race_personal_bests` keyed on `(pet_id, activity_id='reef-race')` (left join — null when no PB row). Daily rank is computed by ranking the row against `getDailyBestLapSnapshot()` — done in-memory, no SQL window function needed (snapshot is cached).

Phase 4 stores the per-match streak best on a NEW column `activity_results.best_streak`:

```sql
ALTER TABLE activity_results ADD COLUMN best_streak integer;  -- nullable; legacy rows = null
```

Migration generated in same `0005` file as §1.1 (additive, no destructive change). Reward pipeline writes it in the same `INSERT ... VALUES` at `reward-pipeline.ts:274-289`.

---

## 7. Tests

### 7.1 PB persistence (server)

`apps/api/src/services/activity/__tests__/reef-race-personal-best-service.test.ts` (NEW):

- `maybeUpdatePersonalBest writes new row when no PB exists`
- `maybeUpdatePersonalBest UPDATES row when newBestLapMs < existing`
- `maybeUpdatePersonalBest NO-OP when newBestLapMs >= existing` (returns improved=false)
- `maybeUpdatePersonalBest skipped for bots` — call site test in `reward-pipeline.test.ts`
- `maybeUpdatePersonalBest stores ghostReplayData verbatim` — round-trip a 200-frame array.
- `loadPersonalBest returns the row for a pet` / `returns null when none`.
- DB-mocked via the same `mock()` pattern as `reward-pipeline.test.ts:16` (Bun test `mock` helper).

### 7.2 Sim — frame capture

`apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` ADD:

- `captures ghost frames at 5 Hz for the active body` — drive 60 ticks (2 sec at 30 Hz), expect ~10 frames in `body.currentLapFrames`.
- `clears currentLapFrames on lap-up` — drive a full lap, then assert length is 0 after the lap-up tick.
- `bestLapFrames captures from FIRST lap if it's the only/best lap` — drive 1 lap, assert `body.bestLapFrames` has the captured array.
- `bestLapFrames REPLACED when later lap is faster` — drive 2 laps with the second one shorter, assert bestLapFrames matches the second lap.
- `getReefRacePerLapResults emits per-pet best with frames` — full integration through the public sim accessor.

### 7.3 PB load (snapshot.init)

`apps/api/src/services/activity/__tests__/activity-ws-hub.test.ts` ADD:

- `snapshot.init carries selfBestLapGhost when pet has a PB row` — fixture: insert row, connect WS, assert frame.
- `snapshot.init omits selfBestLapGhost for non-Reef-Race rooms`.
- `snapshot.init omits selfBestLapGhost for bots`.

### 7.4 Streak counter

`reef-race-sim.test.ts` ADD:

- `currentStreak increments on consecutive clean checkpoint crosses`
- `currentStreak resets to 0 on a wide hairpin verdict`
- `bestStreakThisMatch is the high-water mark`
- `non-hairpin checkpoints count as clean automatically` — drive a pure-straight lap, expect streak to advance.
- `event.streak_milestone fires at 5, 10, 15, 20, 25, 30, 36 only` — drive 36 clean crosses, assert exactly 7 events.
- `streak survives lap boundary if the lap-up checkpoint is clean` — fixture: enter lap-N final hairpin clean, cross start/finish, assert streak += 1.

### 7.5 Lobster of the day

`apps/api/src/services/activity/__tests__/reef-race-daily-best-service.test.ts` (NEW):

- `getDailyBestLapSnapshot returns rows ordered by bestLapMs ASC`
- `getDailyBestLapSnapshot excludes rows older than 24h`
- `getDailyBestLapSnapshot excludes guest pets`
- `getDailyBestLapSnapshot caches for 60s` — assert second call within window doesn't re-query DB (mock SELECT counter).
- `getDailyBestLapSnapshot honors limit param` — insert 150 rows, request limit=10, expect 10 entries.

`apps/api/src/routes/__tests__/leaderboard.test.ts` (NEW or extended):

- `GET /api/leaderboard/reef-race/daily-best-lap returns 200 + correct shape`
- `GET /api/leaderboard/reef-race/daily-best-lap rate-limits at 60/min/IP`
- `GET /api/leaderboard/reef-race/daily-best-lap public — no auth required`

### 7.6 Match-end results

`apps/api/src/services/activity/__tests__/reward-pipeline.test.ts` ADD:

- `issueRewardsForRoom credits perfect-lap bonus when bestStreak >= 36` — assert tokens include +25.
- `issueRewardsForRoom skips perfect-lap bonus when bestStreak < 36`.
- `issueRewardsForRoom triggers PB write when newBestLapMs < priorBestMs` — assert mock called.
- `issueRewardsForRoom skips PB write for bots`.
- `issueRewardsForRoom emits pbDelta.newGhostFrames when PB improved` — assert event payload.

### 7.7 Anti-cheat — PB skip on flagged match

`reward-pipeline.test.ts` ADD:

- `issueRewardsForRoom skips PB write when pet has ≥1 anti-cheat flag in the match`.

### 7.8 Client store

`apps/web/src/stores/__tests__/activity.test.ts` (if exists, else add new):

- `setGhostPath populates reefRace.selfBestGhostPath`
- `event.streak_milestone updates selfStreak when self pet`
- `EntityDelta.changed.streak updates entity.streak`

---

## 8. Risks + mitigations

| Risk | Mitigation |
|---|---|
| **DB write at match end** | 1 INSERT per pet per match (PB) + 1 UPDATE per `activity_results` (perfect bonus column). Bound: ~5 matches/min × 8 players = 40 writes/min. Trivial vs. Supabase paid-tier capacity. |
| **`ghost_replay_data` JSONB size** | 5 Hz capture cap = 250 frames × ~24 B serialized = 6 KB worst case. Storage at 1000 active pets = 6 MB total — negligible on Supabase. JSONB compression makes it ~half that on disk. |
| **Mid-match server crash kills replay capture** | The current frame ring buffer is in-process. A crash loses the in-progress lap's frames — same blast radius as the existing replay log buffer (already accepted risk per `activity-room-manager.ts:887` flush-on-end semantics). PB stays as the previous match's. |
| **Anti-cheat for daily leaderboard** | (1) PB only writes after match ENDS (no premature disconnect), (2) `MIN_LAP_MS=15s` blocks teleport laps via existing `validateLapTime`, (3) any pet with anti-cheat flag in the match has PB write skipped, (4) bot + guest carve-outs in SQL. |
| **Per-body streak state cleanup** | Streak fields live on the `ReefBody` object — automatic GC when `state.bodies` is cleared in `endRound`. No explicit teardown. Same pattern as `apexCheckedThisLap`. |
| **PB ghost on LIVE rivals** | Spec: self only. Server NEVER sends `selfBestLapGhost` for any pet other than the connecting one's identity. WS hub gates on `ws.data.identity.petId`. |
| **Per-frame allocation regression** | Frame capture allocates ONE GhostFrame literal per body per (tick % 6) — 5 Hz × 8 bodies = 40 allocs/sec. Below the per-frame budget. Material list is memoized in `ReefRaceGhost.tsx:useMemo`. |
| **Stat-driven body multipliers don't apply to streak** | Confirmed: streak is a pure mechanic over checkpoint-cross transitions; no body multipliers needed. Stat-tweaked body just makes hitting the apex easier (Phase 3 effect), which is fine. |
| **Frame rate change (10 → 5 Hz) breaks existing client expectations** | Verified: `findGhostFrames` lerps for arbitrary rate. The `GHOST_SAMPLE_HZ` constant on the client is documentation only — no integer divisions hard-code 10. Updating the constant in same diff keeps docs honest. |
| **`event.match_ended` payload bigger** | Reef-race only. New `pbDelta.newGhostFrames` is ~5 KB, fires at most ONCE per match (and only when PB improved). Per-match cost, not per-tick. |
| **3da rule** | `ReefRaceGhost.tsx` + `ReefRaceScene.tsx` mount = 3D code. `3da` MUST be spawned to write/edit those changes. PB write, streak sim, leaderboard route, modal extensions are NOT 3D — orchestrator owns. |
| **Daily-best-lap cold cache** | First request after server restart hits PG with the index-only scan. Worst case <50 ms at 1000 PB rows. 60s cache absorbs the rest. |
| **Migration order** | `0005_reef_race_personal_bests.sql` is purely additive (new table + new column on activity_results). `bun run db:push` applies cleanly. Per CLAUDE.md, run before deploy. |
| **Same-diff doc updates** | `GameFeatures.md` (PB ghost, streak, daily-fastest-lap), `ARCHITECTURE.md` (new table, new route, new event types), `3dStructure.md` (PB ghost mounted in scene), `town-guide.ts` knowledge[] (new "Lobster of the day" surface for orientation). All MUST land same diff per project rules. |

---

## 9. File-by-file scope

| Path | Type | Owner | Lines (est) | Notes |
|---|---|---|---|---|
| `packages/database/src/schema/reef-race-personal-bests.ts` | NEW | orchestrator | ~50 | New PG table + types |
| `packages/database/src/schema/index.ts` | MOD | orchestrator | +1 | export new schema |
| `packages/database/src/schema/activity-results.ts` | MOD | orchestrator | +3 | add `bestStreak: integer` column |
| `packages/database/drizzle/0005_reef_race_personal_bests.sql` | NEW | orchestrator | ~30 | additive migration (table + column) |
| `packages/database/drizzle/meta/0005_snapshot.json` | NEW | orchestrator | ~120 | drizzle-kit auto-generated |
| `packages/shared/src/activities/protocol.ts` | MOD | orchestrator | +50 | move `GhostFrame` here, add `selfBestLapGhost` to RoomMeta, extend RewardPreview, add `event.streak_milestone` |
| `packages/shared/src/activities/activities.ts` | MOD | orchestrator | +5 | `perfectStreakBonusTokens` in reef-race rewardConfig |
| `apps/web/src/lib/three/activities/reef-race/reef-race-types.ts` | MOD | 3da | +5 | re-export GhostFrame from shared |
| `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts` | MOD | orchestrator | +3 | `GHOST_SAMPLE_HZ` 10 → 5 + comment update |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceGhost.tsx` | MOD | 3da | +40 | per-lap fade, material list memo, settings gate, mount-only-if-self |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceScene.tsx` | MOD | 3da | +5 | mount `<ReefRaceGhost />` |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | MOD | orchestrator | +120 | frame capture, streak fields, accessors `getReefRacePerLapResults` + `getStreaksByPet`, `event.streak_milestone` broadcast, EntityDelta.streak field |
| `apps/api/src/services/activity/sim/reef-race-config.ts` | MOD | orchestrator | +20 | `STREAK_MILESTONES`, `streakMilestoneKind`, `TOTAL_CHECKPOINTS_PER_RACE`, `GHOST_CAPTURE_HZ`, `MAX_GHOST_FRAMES_PER_LAP`, `PB_GHOST_PER_FRAME_BYTES_BUDGET` |
| `apps/api/src/services/activity/reef-race-personal-best-service.ts` | NEW | orchestrator | ~120 | `maybeUpdatePersonalBest`, `loadPersonalBest`, `loadPersonalBestGhostFrames` + 5-min in-memory cache |
| `apps/api/src/services/activity/reef-race-daily-best-service.ts` | NEW | orchestrator | ~110 | `getDailyBestLapSnapshot`, 60s cache, invalidate hook |
| `apps/api/src/services/activity/reward-pipeline.ts` | MOD | orchestrator | +60 | thread per-lap + streaks into pipeline, perfect-lap bonus computation, fire-and-forget PB write, daily-rank computation, anti-cheat-flag PB skip |
| `apps/api/src/services/activity/activity-room-manager.ts` | MOD | orchestrator | +15 | call `getReefRacePerLapResults` + `getStreaksByPet` and pass into `issueRewardsForRoom` |
| `apps/api/src/services/activity/activity-ws-hub.ts` | MOD | orchestrator | +15 | load self-pet PB ghost, attach to RoomMeta in snapshot.init |
| `apps/api/src/routes/leaderboard.ts` | MOD | orchestrator | +35 | new `GET /reef-race/daily-best-lap`, register limiter, response shape |
| `apps/api/src/routes/activities.ts` | MOD | orchestrator | +30 | extend `GET /:id/rooms/:roomId/results` to join PB row + return Phase-4 fields |
| `apps/web/src/stores/activity.ts` | MOD | orchestrator | +60 | `selfStreak`, `selfBestStreakThisMatch`, `selfDailyBestLapRank` in ReefRaceState; handlers for `event.streak_milestone`, EntityDelta.streak, snapshot.init `selfBestLapGhost`, match-end `pbDelta.newGhostFrames` |
| `apps/web/src/components/game/reef-race-hud.tsx` | MOD | orchestrator | +35 | streak indicator chip + tier-coded glow + reset flash |
| `apps/web/src/components/game/activity-results-modal.tsx` | MOD | orchestrator | +90 | activity label fix, PB delta block, streak section, daily rank section, plumb authoritative response |
| `apps/web/src/app/leaderboard/page.tsx` | MOD | orchestrator | +120 | tab group (Agents | Lobster of the day), daily-best-lap fetch hook, ranked table component |
| `packages/agent-templates/src/locations/town-guide.ts` | MOD | orchestrator | +6 | knowledge[] entry: "Lobster of the day" surface + perfect-lap bonus |
| `apps/api/src/services/activity/__tests__/reef-race-personal-best-service.test.ts` | NEW | orchestrator | ~120 | §7.1 |
| `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | MOD | orchestrator | +130 | §7.2 + §7.4 cases |
| `apps/api/src/services/activity/__tests__/activity-ws-hub.test.ts` | MOD | orchestrator | +50 | §7.3 cases |
| `apps/api/src/services/activity/__tests__/reef-race-daily-best-service.test.ts` | NEW | orchestrator | ~100 | §7.5 |
| `apps/api/src/routes/__tests__/leaderboard.test.ts` | NEW or MOD | orchestrator | +60 | §7.5 route tests |
| `apps/api/src/services/activity/__tests__/reward-pipeline.test.ts` | MOD | orchestrator | +80 | §7.6 + §7.7 cases |
| `apps/web/src/stores/__tests__/activity.test.ts` | NEW or MOD | orchestrator | +40 | §7.8 |
| `GameFeatures.md` | MOD | orchestrator | +30 | Phase 4 mechanics: PB ghost, streak, lobster-of-the-day, perfect-lap bonus |
| `ARCHITECTURE.md` | MOD | orchestrator | +20 | new table + route + event in tables of routes/DB |
| `3dStructure.md` | MOD | 3da | +12 | PB ghost mount, fade timeline, opacity budget, settings gate |

**TOTAL CODE EST:** ~1100 lines added/modified, ~600 lines test, 3 doc updates.

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
ALTER TABLE "activity_results"
  ADD COLUMN IF NOT EXISTS "best_streak" integer;
```

Migration is **purely additive** — no DROPs, no data rewrites, no destructive ALTER. Safe to run on prod via `bun run db:push` per CLAUDE.md "Database migrations".

### 10.3 Migration ordering

- Migration 0005 lands first.
- Server code that READS `reef_race_personal_bests` ships next (after migration confirmed live in prod via `psql \dt`).
- Server code that WRITES `reef_race_personal_bests` ships in the same deploy as the read-side (writers don't fire until a Reef Race match ends, by which time the table exists).
- Client code (modal, leaderboard tab, ghost mount) ships in the same deploy. Ghost component returns `null` cleanly when `selfBestLapGhost` is `undefined` → backwards-compatible with old servers.

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
