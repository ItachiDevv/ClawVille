# Reef Race v2 — Slalom River Rewrite

> Status: SPEC LOCKED 2026-04-28. Implementation in progress on branch `reef-race-v2`.
> User direction: replace boring oval with Mario-Kart-tier slalom river, leverage CC0 assets aggressively.

## Locked Design

| Decision | Value | Notes |
|---|---|---|
| Track shape | **Gentle slalom curve** (single spline path) | No branching v1 — adds bot AI complexity |
| Race duration | **~60 seconds** | Same as current 3-lap oval, lap counter retired |
| Corridor width | **Wide (4-5 karts abreast)** | Mario Kart-style overtake space |
| Obstacles | **Static + Animated mix** | Coral/rocks/kelp + vortices/jellyfish drift |
| Verticality | **YES — jump ramps + dive-under arches** | ⚠️ Largest sim change — adds Y-axis physics |
| End condition | **All-finish placement, wait at line + timeout** | Finished racers spectate; per-player or global timeout for stalled |

## What Carries Over (no change)

- Server-authoritative 30 Hz tick sim
- 30 Hz client→server input, 20 Hz server→client snapshots (S1 will bump to 30 Hz)
- 6-power-up catalog (turbo, shield, ink, jelly, tide wave, whirlpool)
- 8-player matches, bot backfill, 5-flag anti-cheat (with the 2026-04-28 physics-flag carve-out)
- Reward + leaderboard pipeline
- Match-end results modal
- Activity store + WebSocket protocol (snapshot.delta shape unchanged)

## Drift Mechanic — RETIRED (2026-04-28)

Drift makes no thematic sense for an underwater glider/surf game. **Replaced entirely by JUMP.** Everything below DELETES with the v2 sim:

- `body.drift` state machine + `tickDriftState`
- All `DRIFT_*` constants (bias, charge ticks, spark tiers, boost mults)
- `<ReefRaceDriftSparks>` HUD component
- Drift validators in anti-cheat
- Bot drift logic in `reef-race-bot.ts`
- `event.drift_boost` event in protocol
- The earlier `minSlideSpeed` reinject bumper-bug also retires — that code lived in the drift slide path

## Jump Mechanic — NEW (locked 2026-04-28)

**Shift = JUMP** (replaces drift). Jump is for OBSTACLE AVOIDANCE, not boost. Decisions:

| Decision | Value |
|---|---|
| Impulse | **Fixed** — one tap = same height every time. Predictable, accessible (Mario Kart style) |
| Cooldown | **No cooldown but must land first** — `body.airborneTicks > 0` blocks new jump. No air-spam |
| Steering while airborne | **~30% turn authority** — `REEF_AIRBORNE_STEER_MULT = 0.30`. Mid-air correction allowed but punishes bad timing |
| XZ velocity in air | **Preserved fully** — jump only adds Y impulse, doesn't kill horizontal motion |
| Ramps vs manual jump | **Ramps inject larger forced impulse** (~2.5× manual). Ramps still matter; can't skip them by self-jumping |
| Server authority | Server owns `body.vyAxis` entirely — client press just sets `ACTION_BIT_JUMP` one-shot, server decides if/when to apply. **Cheat-proof by construction** |

New constants in `reef-race-config.ts`:
- `REEF_JUMP_IMPULSE_MANUAL` — target peak height ~60 wu
- `REEF_JUMP_IMPULSE_RAMP` — target peak height ~150 wu (~2.5× manual)
- `REEF_GRAVITY` — calibrated so manual airtime ~0.6s, ramp airtime ~1.2s
- `REEF_AIRBORNE_STEER_MULT = 0.30`

Bot AI: bots jump-to-clear visible obstacles in their lookahead window AND always take ramps (skill ceiling 0 per spec, jump-decisions are server-side anyway).

HUD: `SHIFT · DRIFT` chip → `SHIFT · JUMP`. Drift sparks bar deletes.

Action bit reassignment in `useActivityInput.ts`:
- `ACTION_BIT_DRIFT (bit 2)` → `ACTION_BIT_JUMP (bit 2)` — same bit, same Shift binding, different server semantic. No protocol change.

## What Gets Rewritten

### Sim (server)

| File | Change |
|---|---|
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | Drop ellipse. Adopt spline-based track with arclength progress. Add Y-axis (gravity, jumps, dive-under triggers). |
| `apps/api/src/services/activity/sim/reef-race-config.ts` | `REEF_TRACK_A`/`B` ellipse → spline control points. Add `REEF_GRAVITY`, `REEF_JUMP_IMPULSE`, ramp/arch zone definitions. |
| `apps/api/src/services/activity/anti-cheat/reef-race.ts` | `validateCheckpointSequence` → `validateProgressMonotonic`. Lap-time validator retires; replaced by per-segment time check. |
| `apps/api/src/services/activity/bots/reef-race-bot.ts` | Race-line on ellipse → race-line along spline. Add jump-ramp targeting + obstacle avoidance. |

### Client (3D + HUD)

| File | Change |
|---|---|
| `apps/web/src/lib/three/activities/reef-race/ReefRaceTrack.tsx` | Procedural ellipse → spline-mesh river bed + walls + decoration anchors |
| `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx` | Add Y-axis interp, jump anim, splash-down particle on landing |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceCheckpoints.tsx` | Lap markers → finish-line gate + progress markers |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceHazards.tsx` | Add jump ramp, dive arch, vortex, jellyfish meshes |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceScene.tsx` | New skybox, water shader, fog, caustics |
| `apps/web/src/components/game/reef-race-hud.tsx` | Lap counter → progress bar (% along river). Wait-at-finish overlay. |

### Protocol (`packages/shared/src/activities/protocol.ts`)

Mostly unchanged — `EntityDelta` already carries `x`, `y` (re-purposed as XZ in Three.js). Add:

- `EntityDelta.changed.height` (Y-axis) — number, optional, only sent when airborne or in dive zone
- `EntityDelta.changed.progress` (0..1 spline arclength fraction) — replaces `lap`
- `event.crossed_finish { petId, totalMs, placement }` — replaces `event.lap_completed` for the finish event
- `event.finish_wait_started { petId, msRemaining }` — new, fired when first racer finishes; UI shows countdown for stragglers

## Asset Strategy

**Don't model from scratch.** Pull from CC0 sources. Inventory below researched 2026-04-28 by asset-hunt agent.

### Top 10 priority downloads

1. **Coast Sand 04** (Polyhaven, CC0) — primary seabed PBR — https://polyhaven.com/a/coast_sand_04
2. **Animated Cute Fish Pack** (Quaternius, CC0) — 52 fish + props for instanced schools — https://quaternius.com/packs/cutefish.html
3. **Caustic Textures** (OpenGameArt, CC0) — water-surface light pattern — https://opengameart.org/content/caustic-textures
4. **Kenney Nature Kit** (CC0) — 330 assets, repurpose for coral / kelp / arches — https://kenney.nl/assets/nature-kit
5. **Kenney Pirate Kit** (CC0) — banners + gates for finish-line — https://kenney.nl/assets/pirate-kit
6. **Animated Jellyfish** (Sketchfab Deivid, verify CC-BY) — animated hazard — https://sketchfab.com/3d-models/jellyfish-c8ba1a3e4ca54af099e62cd89ba1b661
7. **Animated Kelp** (Sketchfab JosephWPugsley, verify) — bone-animated kelp banks — https://sketchfab.com/3d-models/animated-kelp-74c400fd4d81469199268ac27451d03f
8. **Sunken Shipwreck** (Sketchfab DogOnAKeyboard, verify) — debris hero piece + jump-ramp source mesh — https://sketchfab.com/3d-models/sunken-shipwreck-2326266a1f3f4b4db76da807f824f76e
9. **Whale Lowpoly** (OpenGameArt, CC0) — distant silhouette — https://opengameart.org/content/whale-lowpoly
10. **Lowpoly Coral** (Sketchfab assetfactory, verify) — bank pillars — https://sketchfab.com/3d-models/lowpoly-coral-864594b70b6740efa479f259de547fbc

### Source pool

| Source | URL | Notes |
|---|---|---|
| Quaternius | https://quaternius.com/ | CC0 packs. Ships FBX/OBJ/Blend — Blender batch GLB export needed (reuse `scripts/blender-build-guide.py` pattern) |
| Polyhaven | https://polyhaven.com/ | CC0 HDRI + textures. **No native underwater HDRI** — fake with tinted blue sky + dense fog |
| Kenney | https://kenney.nl/ | All CC0. Nature Kit + Pirate Kit + Animal Pack Redux best for us |
| OpenGameArt | https://opengameart.org/ | Mixed licenses, filter for CC0 |
| Sketchfab CC0 filter | https://sketchfab.com/3d-models?features=downloadable&licenses=322a749bcfa841b29dff1e8a1bb74b0b | **License is per-model** — must verify before download |
| Poly.pizza | https://poly.pizza/ | Aggregator of Quaternius + Kenney + community as direct GLB |
| ~~KayKit~~ | https://kaylousberg.itch.io/ | **Zero aquatic packs — dropped from source list** |

### Asset categories with picks

#### River bed / seabed textures (Polyhaven, all CC0)
- Coast Sand 04 — 8K, coarse coastal sand + shell debris (best match)
- Coast Sand 01, 05 — alts
- Gravelly Sand — transition strips
- Use 1K or 2K in-engine; 8K wastes Iris Xe

#### River bank / obstacles
- Animated Cute Fish Pack (Quaternius CC0) — schools + props
- Lowpoly Coral (Sketchfab) — bank pillars
- Low Poly Rock Formation (Sketchfab) — partially submerged rocks
- Animated Kelp (Sketchfab) — bone-animated swim
- Seaweed (poly.pizza) — alt static
- Sunken Shipwreck (Sketchfab) — debris + ramp source
- Lowpoly Treasure Chests (Sketchfab) — decoration
- Kenney Nature Kit + Animal Pack Redux (CC0) — repurpose pool

#### Hazards
- Animated Jellyfish (Sketchfab Deivid) — high-value animated
- Low-poly Jellyfish (840-tri, GLB direct) — alt
- Water Bubbles (Sketchfab) — bubble-column hazard
- Vortex/whirlpool: **build procedurally** with swirling caustics texture on a disc + TSL — no good free vortex GLB exists

#### Track decoration
- Coral arch: repurpose Kenney Nature Kit arch trees, OR 2 large coral pillars + crossbar
- Jump ramps: split shipwreck hull fragments in Blender
- Finish gate: Kenney Pirate Kit banners (sea-themed)

#### Skybox / HDRI / caustics (all CC0)
- No native underwater HDRI — use tinted blue Polyhaven sky (e.g. Kloppenheim 02) + heavy exponential fog
- Caustic Textures (OGA) — tileable PNG
- Caustics with Color Split (OGA) — RGB-shifted variant for chromatic aberration
- Seamless Water Tiles (OGA) — surface
- Animated Water Texture 128px (OGA) — loopable for caustic animation via UV offset

#### Background sea life (decorative, no collision)
- Animated Cute Fish Pack (Quaternius) — primary instanced schools
- Quaternius Animated Fish Pack (7) — alt
- Whale Shark / Great White (Sketchfab) — distant silhouettes
- Whale Lowpoly (OGA CC0) — confirmed CC0 distant figure
- Plankton particles: **build as Three.js Points** with alpha sprite — no model needed

### Pipeline notes (load-bearing)

- **Sketchfab license MUST be re-verified per-model** on download page (filter by Downloadable + CC0/CC-BY)
- **Quaternius ships FBX/OBJ/Blend not GLB** — batch convert via Blender headless: `blender -b -P export_glb.py`. Reuse pattern in `scripts/blender-build-guide.py`
- Track per-asset tri count + license + source in this doc as we add them. New section below for the running ledger.

### Asset Ledger (filled as we download)

| Asset | Slot | Source | License | Tris | Local path |
|---|---|---|---|---|---|
| Surfboard 1 (default) | Player kart | Saritasa / Anna Denisova (Sketchfab) | CC-BY 4.0 | 3,220 | `apps/web/public/models/reef-race/surfboards/surfboard_1.glb` (653 KB) |
| Surfboard 2 (cosmetic) | Cosmetic catalog | same | CC-BY 4.0 | 3,220 | `surfboards/surfboard_2.glb` (665 KB) |
| Surfboard 3 (cosmetic) | Cosmetic catalog | same | CC-BY 4.0 | 3,220 | `surfboards/surfboard_3.glb` (667 KB) |
| Surfboard 4 (cosmetic) | Cosmetic catalog | same | CC-BY 4.0 | 3,220 | `surfboards/surfboard_4.glb` (660 KB) |

**Surfboard pipeline notes:**
- Source pack `~/Downloads/game_ready__free_surfboards.glb` (8 MB, 5 meshes incl. sand display base)
- FBX zip `~/Downloads/game-ready-free-surfboards.zip` (46 MB) kept as fallback if a GLB texture/material breaks in Three.js
- Split via `scripts/split-surfboards.mjs` using `@gltf-transform/functions` `prune()` + `dedup()` — drops sand display base, splits into 4 self-contained GLBs, prunes unused materials/textures (~80% size reduction per board: 8 MB pack → 660 KB per board file)
- Each board: 1 mesh, 1 material, 3 textures (color + normal + roughness)
- Color textures still 2K — flag for downscale-to-1K if Iris Xe upload time is noticeable in production
- Attribution: `apps/web/public/models/reef-race/surfboards/ATTRIBUTIONS.md` per CC-BY 4.0 §3(a). In-game cosmetic card MUST display credit string from that file.
- **Replaces** the procedural `BoxGeometry(2.5, 0.25, 5)` "Reef Glider" in current `ReefRacePlayer.tsx` — first non-cosmetic visual upgrade for Reef Race v2.

**Tri-budget reallocation (was 24k for 8 karts, now 25.6k):**
- Current scene budget headroom is 114k tris — 1.6k extra for surfboards is rounding error. No reallocation actually needed.

**Hard tri budget for the whole scene** (Iris Xe constraint): 220k tris total, 70 draw calls. Reef Race v2 budget allocation:

| Slot | Tris | Notes |
|---|---|---|
| River bed mesh | 8k | Procedural spline + extruded cross-section |
| River bank meshes (L+R) | 16k | Modular segment instancing |
| Skybox | 0 | Cubemap, no geometry |
| Water surface (animated) | 4k | Subdivided plane, vertex shader animation |
| Coral / rock / kelp obstacles | 30k | ~15 unique meshes × instancing |
| Jump ramps (3-5 instances) | 8k | One mesh, instanced |
| Dive arches (2-3 instances) | 6k | One mesh, instanced |
| Vortex / jellyfish (animated) | 6k | Skinned + particle hybrid |
| 8 karts (lobster + glider) | 24k | 1.5k tris × 8, plus glider boards |
| Pickup boxes (10) | 4k | Existing |
| Particles (bubbles, plankton) | 0 | Points material |
| HUD / overlays | 0 | DOM |
| **Headroom** | **~114k** | Buffer for unknowns |

Stays comfortably under budget.

## Phased Implementation

### Phase 1 — Foundation (target: 2-3 days)

- [ ] Spline math primitives in `reef-race-spline.ts` (centerline, arclength, tangent at t, normal at t, distance-to-spline)
- [ ] Replace ellipse collision with spline-bank distance + perp normal
- [ ] Lap counter → arclength progress
- [ ] Bug 1 fix: cap `minSlideSpeed` post-wall-hit (per 3da diagnosis)
- [ ] Update bots for spline race-line
- [ ] Update tests — ellipse-shape tests retire, spline-shape tests added
- [ ] Placeholder visual: render spline as flat textured river with low gray walls

**Ship gate:** races complete end-to-end, bots traverse the slalom, player can drive forward, finish line works.

### Phase 2 — Verticality + Obstacles (target: 2-3 days)

- [ ] Y-axis sim: `body.y` (height), `body.vy_axis` (vertical velocity), gravity
- [ ] Jump ramp trigger zones (impulse `body.vy_axis += JUMP_IMPULSE`)
- [ ] Dive-arch trigger zones (collision plane lifts during transit, kart goes UNDER)
- [ ] Animated obstacles (vortex spin field, jellyfish drift wave)
- [ ] Static obstacle placement along spline arclength
- [ ] Pickup box re-placement along spline
- [ ] Anti-cheat tune for verticality (don't flag jump-arc velocity)

**Ship gate:** karts can jump ramps, dive under arches, dodge obstacles. Bots use jumps strategically.

### Phase 3 — Visual + Smoothness (target: 2-3 days)

- [ ] Asset import sweep (Quaternius + KayKit + Sketchfab CC0)
- [ ] Blender pass: decimate, retex, GLB-export with Draco
- [ ] Skybox + HDRI lighting (Polyhaven underwater HDR)
- [ ] Water surface shader (caustics, vertex wave, foam at bow)
- [ ] Underwater fog + god rays
- [ ] **Smoothness S0** — Catmull-Rom interp on rotation, jitter buffer
- [ ] **Smoothness S1** — snapshot 20→30 Hz, INTERP_DELAY 100→85 ms
- [ ] **Camera spring** — critically-damped chase + look-at
- [ ] **FOV pump** — 65°→78° at speed, 88° on drift-boost release
- [ ] **Camera bank/roll** — 3-8° opposite turn
- [ ] **Speed lines** + radial chromatic aberration at >80% top speed
- [ ] **Wake/spray particles** behind kart on drift/boost
- [ ] **Audio Doppler** on engine pitch, low-pass filter for underwater feel

**Ship gate:** scene reads as "underwater Mario Kart," motion feels silky.

### Phase 4 — Polish (target: 1-2 days)

- [ ] Wait-at-finish state on server (body.state = 'waiting')
- [ ] Wait-at-finish overlay on client (countdown, current standings)
- [ ] Per-player + global timeout (e.g. 20s after first finisher)
- [ ] Tutorial card update (jumps, ramps, dive-arches in copy)
- [ ] Bot AI difficulty tune
- [ ] `GameFeatures.md` + `3dStructure.md` + `ARCHITECTURE.md` doc updates
- [ ] Bug bash + 3da viewport screenshot QA pass

**Ship gate:** ready to merge to master.

### Phase 5 — Smoothness S3-S5 (target: 1 week, AFTER Phase 4 ships)

- [ ] Extract `applyIntentForTick` + `integrateMotion` to shared `packages/reef-sim/`
- [ ] Audit determinism (`Math.random` seed, `Date.now` → tick #, Map iteration)
- [ ] Client-side prediction with seq # + reconciliation
- [ ] Smoothing offset on misprediction (decay over 150ms)

**Ship gate:** input lag perceived as zero. This is the final "feels like Rocket League" delivery.

## Architecture (3da-designed 2026-04-28)

Full design at `.claude/plans/reef-race-v2-spline-architecture.md`. Decisions:

- **Spline**: Catmull-Rom, open, 16 control points (14 interior + 2 phantoms). Width interpolated per CP.
- **Arclength**: 1000-entry LUT built once at boot (adaptive Simpson integration), frozen after. Newton inversion ~6 iter, ~240 calls/sec at 8 bodies.
- **Verticality**: separate `body.heightOffset` + `body.vyAxis` + `body.airborneTicks` fields. XZ sim untouched. Server owns vyAxis entirely (cheat-proof).
- **Wall collision**: replaces `enforceWallClamp` with `closestPointOnSpline` + lateral overshoot push. Keeps `minSlideSpeed` reinject WITH the cap fix (Bug 1).
- **Bot AI**: race-line from spline curvature (high curve → inside offset). Lookahead at t+0.03. Always take jump ramps. Pickup deviation only if box within 3× POWERUP_RADIUS of lookahead AND <40% width drift.
- **Anti-cheat**: `validateProgressMonotonic` (t-regression <2% of track) replaces `validateCheckpointSequence`. Per-segment time check replaces lap-time validator. Position+velocity validators unchanged.
- **Migration**: new `reef-race-spline-sim.ts` alongside ellipse sim, behind `REEF_RACE_USE_SPLINE=true` env flag. Instant rollback. Ellipse deleted only after Phase 1 ship gate met.

## Risks Flagged

1. **Newton convergence on tight S-curves** — if track folds within 88 wu of itself in XZ, Newton can pick the wrong segment. Verify control-point spacing before lock.
2. **Prototype spline math standalone first** — plot curve, verify `closestPointOnSpline` on all 16 CPs, validate `tFromArclength(arclengthFromT(t)) ≈ t` within 0.001 round-trip. Before ANY sim code is touched.
3. **Open-spline endpoint phantoms** — place t=1 phantom 200 wu past finish in last-segment direction; collinear phantom produces degenerate finish-line tangent.
4. **Bot obstacle avoidance deferred to Phase 2** — Phase 1 bots follow race-line only; obstacles placed off racing line so bots naturally miss them.

## Working Branch

`reef-race-v2` — `.claude/worktrees/reef-race-v2/`

## Last Updated

2026-04-28 — initial spec lock
