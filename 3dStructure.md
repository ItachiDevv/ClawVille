# ClawVille — 3D World Structure

> **Last Audited:** 2026-05-10 — `WorldLabel` (apps/web/src/lib/three/world-labels-overlay.tsx) crash fix: `<WorldLabel>` body returned `createPortal(<div>…</div>)` from inside the R3F-reconciled Canvas tree. R3F's reconciler walks portal children and threw "Div is not part of the THREE namespace", which surfaced to the user as the Next.js "This page couldn't load" error boundary on `/game`. Fix: `WorldLabel` now creates a per-label `<div>` in the overlay container and renders children via `react-dom/client` `createRoot`, mirroring drei `<Html>`'s pattern. Component returns `null` to R3F so the reconciler has nothing to walk. The single-overlay projection (`WorldLabelsOverlayMount` useFrame, NDC z>1 cull, ≥0.5px transform-write threshold) and `useWorldLabel` registry are unchanged. divRef wiring switched from `<div ref={divRef}>` JSX to imperative `(divRef as any).current = div` so the projection still writes display/transform on the real DOM node. Prior: 2026-05-08 — Pets→Avatars rename pass (concerns 1a–1h, see ARCHITECTURE.md and GameFeatures.md for full list). 3D-relevant renames: `apps/web/src/lib/three/player-pet.tsx` → `player-avatar.tsx`, store fields `petPosition`/`petSpeed` → `avatarPosition`/`avatarSpeed`, components `PetStatusBar`/`PetChatBar` → `AvatarStatusBar`/`AvatarChatBar`, store `usePetStore` callsites still using `pet`/`pets` lowered into avatar variants. The `avatar_type`/`avatar_url` columns on the `avatars` table — describing renderable model format `glb`/`vrm` — keep their names since "avatar" there refers to the visual asset. Real script files retain their names: `scripts/seed-bot-pets.ts` (real file referencing the bots-as-avatars pool), etc. **Note:** historical "Last Audited" entries below describe state at time of audit; do not rewrite. Prior: 2026-04-30 — SPEC 3 Ramps GLB swap: procedural triangle-prism wedges REPLACED with real GLB asset `bemsx_ramp_jump` (Sketchfab) at `apps/web/public/models/reef-race/scenery/ramp-jump.glb` (453KB, 165 tris, 712 verts, 7 WebP textures 1024px, 2 material groups: Frame/Material.026 + Floor/Material.025). Orientation: +Z=travel (player rides up toward +Z), +Y=up, GLB bbox post-transform X≈21.4m × Y≈10.0m × Z≈21.1m (GLB meters). Pivot: bottom-front-center anchored to spline t-position at y=0 via T_pivot=(-0.88,+0.23,+11.34). Scale=18 → ~385wu wide × 180wu tall × 380wu travel. Draw calls: 2 (one per material group, all instances merged) — down from 6 procedural wedges. Ramp count: driven dynamically by `buildSplineRampsClient()` (currently 6, coordinator bumping to 20). Architecture: `RampsInner` (useGLTF + Suspense-wrapped) + per-material extraction using `extractAndTransformByMaterial()` mirroring rocky-cliffs.tsx pattern; `mergeGeometries(allInstances)` per material; 2 `<mesh>` elements in `<Ramps>` wrapper. File: `apps/web/src/lib/three/activities/reef-race/ramps.tsx`. Iris Xe safe: plain Mesh + MeshStandardMaterial cloned from GLB, no InstancedMesh+ShaderMaterial, no drei Text/Billboard, zero per-frame allocs. Prior: SPEC 3 Ramps in Reef Race: 6 wedge meshes (`ramps.tsx`, triangle-prism BufferGeometry 300×400×60wu, `#c9884a` MeshStandardMaterial, placed at t=0.09/0.22/0.35/0.50/0.65/0.78 along spline); server `resolveRamps()` in spline-sim step 5d; `event.ramp_launch` ServerFrame union member; screen-shake infrastructure in `ReefRaceScene.tsx` (`shakeRef` + `triggerScreenShake` callback); extended 16° nose-up tilt (RAMP_NOSE_UP_RAD=0.28) for 0.35s post-launch; particle burst via `triggerBurst()` on self-player. Build: 7/7 tasks green, TypeScript clean. 5/5 new ramp unit tests pass, 187/187 total tests pass. Prior: SPEC 2 Milady VRM rider in Reef Race (VRM component architecture, wipeout/victory triggers, VRMCharacterAnimator surfaceClip field). Prior: iter-9 Reef Race v2 canyon widen + spline-following ground (sequential 1 Implementer → 1 Auditor per concern, both APPROVED).
> User feedback addressed: (1) "river still needs to be wider" → halfWidths × 1.5 from iter-8 (lagoon/finish 2200→**3300**, kelp 1325→**1990**, shipwreck 1100→**1650**, coral 880→**1320**) in `track-layout.ts`. Cumulative ×2.1 from iter-5. (2) "ground needs to be cut in two pieces that both end at the rock border — German River reference" → GroundShader REBUILT as **spline-following ribbon**: rectangular `PlaneGeometry` strips DELETED (`GROUND_W_SEGS`/`GROUND_L_SEGS`/`GROUND_X_OFFSET` constants gone), replaced with `buildGroundRibbonGeo(side, samples=128, widthSegs=64)` sweeping along `clientSpline`. Each cross-section's inner edge tracks `hw + 873wu` (max cliff outer envelope: 600 lateralMax + 173 rock body half + 100wu safety buffer), outer edge at `+ GROUND_W (6000wu)`. Two ribbon meshes (sign ±1) — left + right — each ENDS AT THE CLIFF BORDER organically as halfWidth varies. Vertex shader's `displacementMask = smoothstep(1100, 1900, abs(x))` REMOVED (set to 1.0) since new geometry is always outside corridor — hills displaced fully everywhere on the ground. Tri budget: 32,768 (down from ~65k rectangular). Tests updated: track-layout widthAt range 2100-2300→**3200-3400**, spline-sim wall-clamp body x=2700→**4000** with bound <2400→<**3500**. Build PASS (31 routes, TypeScript clean), 33/33 tests pass. **Iris Xe safe**: plain Mesh + plain ShaderMaterial (existing `_groundShaderMat` reused). Prior iter-8 audit follows.
>
> **Prior Audited:** 2026-04-29 — iter-8 Reef Race v2 polish team-pass (sequential Implementer→Auditor per concern, two concerns parallel since file-disjoint).
> User feedback addressed: (1) "land continuously over and covering the river" → ground inner edge moved 1300→**3050wu** with 77wu safety buffer past max rock outer envelope (max corridor 2200 + max cliff lateralMax 600 + rock body half-width 173 = 2973wu max envelope; 3050 ≥ 2973 → ground sits ALONGSIDE the canyon, never overlaps water). `GROUND_X_OFFSET 4300→6050` in river-scene.tsx. (2) "still not wide enough" → all halfwidths × 1.4 (lagoon/finish 1575→**2200**, kelp 945→**1325**, shipwreck 787→**1100**, coral 630→**880**) in `packages/shared/src/reef-race/track-layout.ts` REEF_RACE_DEFAULT_TRACK + REEF_RACE_SEGMENTS. (3) "rock borders wider" → cliff `LATERAL_MAX 200` constant replaced with **VARIABLE per-section `lateralMax(sectionIdx)`** in [180, 600]wu via mulberry32 hash (seeded sectionIdx + 7919). German River reference: cliff bands now bulge in/out organically along spline; thin-band sections press 167wu INTO corridor at choke (intentional canyon press-in, server sim still uses halfWidth so racing line unaffected). Cliff scale range widened SCALE_MIN 50→**40**, SCALE_MAX 70→**90** for height variance. (4) "0 vertical variation" → water-surf.tsx vertex shader now adds 3-octave sin Y displacement capped at ±8wu (peaks at y=-192, safe inside cliff baseline at y=-200; periods 1257/2094/3142wu visible as forward-scrolling bumps along Z race axis at chase cam). (5) "white caps look like 2003 PS2" → fragment shader replaces narrow `smoothstep(0.55,0.62)` with widened `smoothstep(0.40,0.78)` × scale-24 cluster modulation noise (5.4× softer transitions, organic patches replace linear stripes); iter-4 multi-layer bank-edge foam turbulence RESTORED (12% UV band, dual simplex scales 60+150, dual speeds 1.2/2.0, weights 0.6/0.4, creamy `vec3(1.0,0.97,0.92)`, mixed AFTER Phong glint as final layer per pattern memory `procedural-water-shader-foam-stripes.md`). 5 snoise calls per fragment, Iris Xe Gen 12 budget verified. Phong glint scalar 0.28→0.50 (Critic-mandated for chase-cam visibility). Tests updated: track-layout widthAt range 1500-1650→**2100-2300**, spline-sim wall-clamp <1800→<**2400**. Build PASS (23/23 pages, TypeScript clean), 33/33 tests pass. **Iris Xe safe** end-to-end: plain ShaderMaterial via drei factory, plain Mesh, plain MeshStandardMaterial via mergeGeometries (2 draw calls); no InstancedMesh+ShaderMaterial; `import * as THREE from 'three'`. Prior iter-7 audit line follows.
>
> **Prior Audited:** 2026-04-29 — iter-7 Reef Race v2 visual rework (collaborative ultrathink team).
> Two parallel implementations per slice (water + rocks), Critic agents picked winners, Auditor agents applied fixes.
> **Water:** inline `_waterShaderMat` in river-scene.tsx (vignette+stripes) → `<WaterSurf />` from new `water-surf.tsx`. Drei `shaderMaterial()` factory + `extend()`. Wave Race 64-style depth gradient via edge-distance `min(uv.x,1-uv.x)` with `smoothstep(0.0,0.25)` mixing `#7fdfff` shallow → `#1d6f8a` deep. Multi-scale simplex noise (12+8) replaces aliasing-prone scales 56/20. Soft white-cap foam `smoothstep(0.55,0.62)`. Pulsing edge foam (`edgeFoam*0.65` mix). Phong sun glint `pow(dot(reflect(-uSunDir,(0,1,0)),viewDir),32)*0.50*depthFactor`. No vertex Y displacement (would clip cliff face at WATER_Y=-200).
> **Rocks:** procedural `rocky-banks.tsx` (5-vertex stepped profile triangle strip, "faceted blob") → `<RockyCliffs />` from new `rocky-cliffs.tsx`. Real Quaternius CC0 boulder GLBs (`cliff-rock-{1,2,3}.glb`) downloaded + optimized via gltf-transform. Tiled along spline as 36 sections × 3 vertical rows (y=0 ground, y=-100 mid, y=-200 waterline) × 2 sides = ~58K tris merged via `mergeGeometries` to **2 draw calls**. `MeshStandardMaterial(#8a6e5c, roughness=0.9, flatShading=true)`. Source GLB cloned BEFORE mutation (avoids `useGLTF` cached-scene-mutation bug). `scenes` array `useMemo`-gated (no rebuild on parent re-render). Cleanup disposes merged geometries on unmount.
> **Files deleted:** `rocky-banks.tsx`, `water-material.tsx` (dead code from earlier iter), `water-arcade.tsx` + `rocky-cluster.tsx` (parallel-implementation losers — kept as memory `.md` for pattern reuse). **river-scene.tsx surgery:** removed inline `_waterVertexShader` / `_waterFragmentShader` / `_waterShaderMat` / `_waterGeo` / `WaterRibbon` / `buildWaterRibbonGeo` / `RIBBON_SAMPLES`; imports replaced (`RockyBanks` → `RockyCliffs` + `WaterSurf`); JSX `<RockyBanks /><WaterRibbon />` → `<RockyCliffs /><WaterSurf />`. WATER_Y=-200 still single source of truth (also exported from water-surf.tsx; matched in racing-karts.tsx). Build green (23/23 pages, TypeScript clean). Iris Xe safe: plain ShaderMaterial via drei + plain Mesh + plain MeshStandardMaterial throughout. **Memory entries** added: `patterns/surf-game-water-shader.md`, `patterns/spline-tiled-cc0-cliffs.md`, `patterns/arcade-cel-water.md`, `patterns/instanced-boulder-cluster-cliff.md`, `gotchas/useGLTF-scene-mutation-clone-first.md`, `gotchas/phong-glint-reflects-away-from-chase-cam.md`. Prior audit line follows.
>
> **Prior Audited:** 2026-04-29 — iter-6 Y-cascade: WATER_Y -40→**-200** (200wu dramatic ravine); BRIDGE_H 10→**80** (280wu clearance); river bed position-y -50→**-250**; RockyBanks PROFILE_Y [+10,0,-15,-35,-50]→[**+30,0,-180,-220,-250**]; PROFILE_D_OFFSET v3 -60→**-100**, v4 -30→**-50**; racing-karts.tsx WATER_Y -40→**-200** (cascade complete); camera presets updated (cinematic altitude 60→**150**, target y -35→**-100**, orbit radius 700→**1200**; side-on target y 0→**-50**). Build: all 23 pages green. See §12.4 iter-6 Y-cascade. Prior iter-5 wire-up entry follows. iter-5 wire-up: WATER_Y +40→-40 cascade in river-scene.tsx; SandRibbon removed (replaced by RockyBanks); RockyBanks wired into RiverScene JSX; RacingKarts wired into RiverScene JSX; BRIDGE_H 100→10; tree spawner scales bumped (pine 2.5-3.5→17-22, leafy 2.2-3.2→25-32). racing-karts.tsx local WATER_Y=40 was fixed in iter-6. See §12.4 for Y-cascade history. Prior: iter-5 corridor + ground reshape. **Reef Race corridor ×1.5 (compounding to ~2.1× original):** `REEF_RACE_SEGMENTS` + all 16 `REEF_RACE_DEFAULT_TRACK` CPs updated: lagoon/finish 700→**1050**, kelp 420→**630**, shipwreck 350→**525**, coral 280→**420**. Corridor now 2100wu wide at lagoon/finish (Mario Kart-wide feel; ±200wu slalom CPs at 19% of half-width — racing-line guidance, not chokepoints). **Ground plane narrowed** from 12000×24000 (96×192 segs, 36864 tris) to **4000×24000** (32×192 segs, **12288 tris** — ×0.33 width saves 24576 tris). Design rationale: player perspective is always down the centerline; 4000wu corridor (±2000wu from center) leaves 950wu per side for grass + scenery, cinematic-correct. **Displacement mask** adjusted: `smoothstep(700,1500)` → `smoothstep(1100,1900)` (hills only at outer edge band, river stays flat). **Bank shadow** adjusted: `smoothstep(700,1300)` → `smoothstep(1050,1800)`. Vertex shader comment updated (river "±1050wu"); JSDoc geometry budget updated. Sim tests: 33/33 pass, wall-clamp test body.x 1100→1900, closestDist<800→<1200. widthAt(0)/widthAt(1) assertions 630-770→1000-1100. Build: all 23 pages green. Prior: terrain-shader.tsx migrated from plain THREE.ShaderMaterial to drei shaderMaterial() factory + extend() modern R3F pattern. TerrainMaterial = shaderMaterial({uTime:0}, vert, frag, onInit) where onInit sets side=FrontSide + fog=true. extend({TerrainMaterial}) registers <terrainMaterial> JSX element. Ref typed as InstanceType<typeof TerrainMaterial>; uTime updated via matRef.current.uTime=elapsed (zero allocation, drei proxies to uniforms). TypeScript augmentation uses ThreeElements['shaderMaterial'] base — JSX.IntrinsicElements causes compile error in .tsx module augmentation. Module-scope _terrainGeo unchanged (36 864 tris, built once). Visual output pixel-identical — same GLSL, same noise frequencies, same colors. Build: all 22 pages green. Prior: water-material.tsx extracted from river-scene.tsx — WaterMaterial now uses drei shaderMaterial() factory + extend() modern R3F pattern; WaterSurface component exported from same file. Prior: RacingKarts component added — 5 animated surfboard karts along v2 centripetal Catmull-Rom spline; see §12.4 RacingKarts section. Prior: Reef Race v2 visual overhaul iter-4 — bank foam + ground terrain + width ×1.4 + animated karts. `river-scene.tsx` iter-4 changes: (1) **GroundShader** REPLACES flat `GroundPlane` — subdivided `PlaneGeometry(12000, 24000, 96, 192)` (36 864 tris) with `ShaderMaterial`: vertex value-noise Y displacement ±50wu gated by `smoothstep(700.0, 1500.0, abs(position.x))` so hills attenuate to flat within 700wu of centerline; fragment 3-tone blend `grassLight #8bc848 / grassDark #5e9e2e / dirtSandy #c5a572` via multi-octave value noise + berm highlight. (2) **Bank-edge foam upgrade** — replaced hard `step(edgeDist, 0.04)` with `1.0 - smoothstep(0.0, 0.12, edgeDist)` (12% UV width, soft falloff) + two animated simplex-noise turbulence layers (`foamTurb1` 60× 1.2×speed, `foamTurb2` 150× 2.0×speed) → creamy white `vec3(1.0, 0.97, 0.92)` churning foam at waterline. (3) **Water color brightened** — `uColorNear #4ec5e8→#5fdcff` (bright cartoon cyan), `uColorFar #2a8aaa→#3aaedf` (lighter mid-blue, avoids dark navy at glancing angles). (4) **AnimatedKarts REPLACES KartWakes** — 5 surfboard karts (`BoxGeometry(60,12,150)`) ride the spline with per-kart speed variation (`KART_SPEEDS` 0.047–0.053 arc-frac/s), lateral offsets (−120 to +120wu), wave-synced Y-bob, yaw from tangent, curvature banking ±0.35 rad. Module-scope `_kartT[]` progress array + scratch Vec3s — zero per-frame GC. 5 distinct color-tinted `MeshStandardMaterial`s. (5) **Width ×1.4 across all segments** — `REEF_RACE_SEGMENTS` and all 16 `REEF_RACE_DEFAULT_TRACK` CPs: lagoon 500→700, kelp 300→420, shipwreck 250→350, coral 200→280, finish 500→700. Tests updated. API tests: 33/33 pass, totalArcLength=18668wu. Build: 7/7 tasks green.
> - **GroundPlane** iter-3 entry superceded — see GroundShader note in iter-4 above.
> - **SandRibbon** (NEW): triangle-strip swept along `clientSpline` at `halfWidth+120 wu` on each side, `MeshLambertMaterial #e8d5a8` cream sand, y=0.5 (above river bed, below water).
> - **WaterRibbon** (REPLACES rectangle plane): triangle-strip swept along `clientSpline` at `halfWidth` exactly, `MeshLambertMaterial #4ec5e8` opaque cyan (removed transparency + depthWrite=false), y=40. 64 cross-sections = 126 tris.
> - **SkyDome**: unchanged from prior session.
> - **ScenerySpawner xJitter** bumped: pine=350wu, leafy=450wu, rock-1=200wu, rock-2=250wu, fence=80wu, grass=150wu (was 10-100wu — props were spawning IN the water).
> - **Bank walls** (SplineTrack `_bankMat` / `_v2BankMat` / preview `_bankMat`): recolored `0x6b5544` dark-brown → `0x7cb342` grass green so they blend with the ground plane instead of showing as dark stripe.
> - **HEMI_GROUND_COLOR**: `'#4a7c3f'` → `'#7cb342'` grass green in both `reef-race-config.ts` (production) and `preview/reef-race-v2/page.tsx` (preview).
> - **Vertex wave animation removed** from water (replaced by static ribbon geometry — shape change > animation for this round).
> - **Draw calls**: water(1)+sand(1)+ground(1)+dome(1)+scenery(≤6) = ≤10. **Tris delta**: water ribbon 128 tris, sand ribbon 128 tris, ground 2 tris — net -3840 tris vs old 4096-tri animated plane.
> See §12.4 Reef Race.) Prior: (Reef Race v2 river atmosphere — `river-scene.tsx` full rewrite to low-poly stylized river (Kagelok "The River" aesthetic). SkyDome: SphereGeometry BackSide vertexColors #cfe9ff→#5ab8e8. Water: MeshLambertMaterial flatShading #4ec5e8 y=40 with vertex wave animation. ScenerySpawner: 6 GLB prop types in Suspense(fallback=null). FOG_COLOR '#a8d8ff' sky-blue in both preview + production; HEMI_GROUND_COLOR '#4a7c3f' earthy green; preview FOG_FAR extended 22000→30000 for open vista.) Prior: Sandy treedome shipped + Pearl/Mrs.Puff scale repaired. User supplied 86MB `sandy_tree.glb` blender export; decimated via `@gltf-transform/cli optimize --simplify --simplify-ratio 0.4 --texture-compress webp --texture-size 1024 --compress draco` → `sandy-treedome.glb` 3.56MB (95.9% reduction). `BUILDING_MODELS['messaging-channels']`: `building-shell.glb` → `sandy-treedome.glb`. NPC scale repair: prior Pearl=80 / Mrs.Puff=1.45 targeted `CHARACTER_HEIGHT=96` but visually read tiny next to player VRM Kyoko (`PET_VRM_SCALE=112` → ~180wu rendered). Bumped 1.8×: Pearl `scaleOverride=80→150`, Mrs.Puff `scaleOverride=1.45→2.7`. ATTRIBUTION.md credits landon141 CC-BY for the dome with decimation note.) Prior: 2026-04-28 (Cosmetic render pipeline — Phase 3.3. Added §13 with CosmeticLoader architecture: 6 category renderers, GLSL aura (not TSL — WebGLRenderer world canvas), bone-anchor hat/glasses, particle pool integration, board context-gating, palette texture swap. See §13.) Prior: 2026-04-29 (Building GLB swap + NPC scaling fixes — 3 new Yanez Designs CC-BY building GLBs sourced from Sketchfab: `krusty-krab.glb` (7.6k tris, 1.55MB) for `mcp-tool-use`; `squidward-house.glb` (2.2k tris, 3.84MB) for `memory-rag`; `patricks-rock.glb` (3.5k tris, 3.8MB) for `agent-security`. `patty-building.glb` moved from `mcp-tool-use` → `cron-automation` (Pearl's downtown teen setting). `memory-rag` was `bb-building.glb`. `agent-security` was `building-cave.glb`. `messaging-channels` keeps interim `building-shell.glb` — sandy-treedome.glb blocked (manual Sketchfab download needed: https://sketchfab.com/3d-models/sandy-treedome-bf5893398ff3444ea4157682146ec5b7 CC-BY landon141). NPC scaling: Pearl (`cron-automation`) `scaleOverride=80` (all-SkinnedMesh, bind-pose bbox unreliable); Mrs. Puff (`app-publishing`) `scaleOverride=1.45` (INT16-quantized symmetric bbox — `computeNormalizedScale` used `maxY=33.18` giving 2× overscale at computed=2.89). Sandy T-pose fix deferred (sandy.glb is static 43KB geometry-only export with 0 animations, 0 skins — needs animated GLB). ATTRIBUTION.md updated with 3 new Yanez Designs credits.)
>
> **Prior Audited:** 2026-04-28 (Reef Race v2 spline track — Phase 1 "playable not pretty". Added `reef-race-spline-instance.ts` module-scope singleton; v2 river-bed dispatch behind `NEXT_PUBLIC_REEF_RACE_USE_SPLINE=true`; surfboard_1.glb player board + `entity.height` Y lift + jump nose-up tilt. Prev: 2026-04-26 (Reef Race fog/camera overhaul — full track always visible. Root cause: 1.5× track scale-up (A=1650, B=1050) moved the far side of the ellipse ~2100wu from the player; with chase cam 350wu behind, far-side geometry was 2450wu from camera — deep in the old fog band (near=1200, far=2700), appearing as a "black portal" as the player drove toward it. Fix: (1) `ReefRaceTrack.tsx` track ribbon material + guardrail material both set `fog=false` — racing surface/lane boundary always fully visible at any distance. (2) `reef-race-config.ts` fog pushed out: `FOG_NEAR=2000` (props crisp at normal racing range), `FOG_FAR=4500` (far-side karts visible with soft atmospheric haze). (3) `CAMERA_FAR=5000` (≥ FOG_FAR, Iris Xe rule). (4) `DIR_SHADOW_FAR + DIR_SHADOW_CAM_BOUNDS` bumped 3000→4000 to cover the full track diagonal. Coral InstancedMesh keeps `fog=true` for depth cue. See §12.4 Reef Race.) Prior: 2026-04-25 (NPC-mode default avatar flipped from `'lobster'` to `'milady_official_1'` in `apps/web/src/stores/npc.ts:475` (`spawnPlayerNpc()`). The player NPC now routes through `VRMNpcMesh`. Ported the jumpState/airborne/jumpY/bob block from `GLBNpcMesh` (lines 592-605) into `VRMNpcMesh` (arena-npcs.tsx ~932-952), dropping the GLB-only `+ 2` baseline and `- pivotOffsetY` because VRM feet are at Y=0 per spec — matches `player-avatar.tsx`'s VRM branch. See §3 Player NPC.)

> Prior audit 2026-04-24 (Reef Race player fix — `ReefRacePlayer.tsx` three bugs fixed: (1) **Interpolation**: 4-snapshot history ring + 100ms render delay ported from BumperShellsPlayer; entity positions lerp smoothly at 60fps from 15Hz server snapshots instead of teleporting. (2) **Facing source**: `group.rotation.y` now set from `entity.rot` (server-authoritative, only updates on player input) instead of `atan2(vx,vy)` which snapped on every knockback — bank tilt still uses velocity delta relative to facing. (3) **Species**: GLB path branches on `entity.species ?? 'lobster'` — seahorse players get `sea_horse.glb`, lobster-keyed avatars get `lobster.glb`. `applySwimmingAnim` used for both (bone name traversal is species-agnostic). NaN guard and lerpAngle shortest-arc lerp ported intact.) Prior: Reef Race track visibility fix: TubeGeometry replaced with flat ribbon BufferGeometry (normals +Y, DoubleSide); CatmullRom control points rebuilt to match server ellipse A=1100/B=700 — entity positions now land on-track. See §12.4.) Prior: Bumper Shells animation fixes — `worktree-fix-bumper-build`. Three bugs fixed: (1) **Facing source changed**: `BumperShellsPlayer` now reads `entity.rot` (server-authoritative, only updates on player input direction) instead of velocity-derived `atan2(vx, vy)`. Velocity was updated by knockback impulses → lobsters snapped facing on every collision ("spazzing"). Velocity magnitude is still used for idle/walk locomotion classification. NaN guard: `rot` treated as NaN only when `entity.rot === 0 AND velocity === 0` (initial spawn before first input). (2) **Combat animations wired**: `PLAYER_GROUP_MAP` module-scope `Map<avatarId, THREE.Group>` added to `BumperShellsPlayer.tsx`. Each player group exposes `triggerCombatAction(action)` which calls `animatorRef.current?.startAction(action, elapsed)`. `BumperShellsScene` `HitEventProcessor` now reads `h.srcPetId` → `triggerCombatAction('attack')`, `h.dstPetId` → `triggerCombatAction('hurt')` + `triggerHit()` on every hit event; `e.avatarId` → `triggerCombatAction('death')` on every elimination. `BumperHitEvent` type extended with optional `srcPetId?`/`dstPetId?`; `activity.ts` `event.hit` case threads them from the server frame. `LobsterAnimator.ACTION_DURATIONS`: attack=0.5s, hurt=0.3s, death=1.5s — `actionDone` guard returns to suggested idle/walk naturally. (3) **Death anim + gravity drop parallel**: `entity.alive` flip simultaneously starts `startAction('death', elapsed)` AND the gravity drop. Lobster tips sideways (body.rotation.z→π/2 via `animDeath`) while falling off disc — reads as "limp tumble". Both paths are orthogonal (animator: bone rotations in clonedScene child space; drop: group.position.y world space). Prior: Mobile explore-mode left joystick restored: `WASDCameraController` now reads `joystickVelocity` from game store each frame as a parallel input source for camera pan. Sign: `dx += joystickVelocity.x`, `dz += -joystickVelocity.y` (matches npc-controller.tsx sign convention where y<0=up). Magnitude clamped to ≤1 before scaling so partial-press analog pressure is preserved. `mobile-controls.tsx` left-joystick useEffect + render guard no longer gated on `isExplore`; building-entry E button still gated.) Prior: Bumper Shells scene FULL REBUILD — `feat/bumper-rebuild`. OrthographicCamera replaced with **PerspectiveCamera chase cam** (FOV 55°, arm 420wu, height 280wu, CHASE_CAM_LERP_ALPHA 5.0 exp decay). Camera shake on self-hit: SHAKE_MAX_DISPLACEMENT=18wu, SHAKE_DECAY=8/s. Screen-edge red DOM flash (FLASH_DURATION_S=0.35s). `BumperShellsArena` rebuilt: platform cylinder (64 segs, 24h, 4% bevel) + tile overlay (PlaneGeo 20×20 segs for lighting seam definition) + rim glow torus (MeshBasicMaterial additive cyan, opacity pulse) + bumper wall torus (MeshStandardMaterial metallic guardrail) + danger ring (pulsing red emissive) + 4 rim accent point lights (no shadow) + starfield 300 points (1 draw call) + void backdrop. `BumperShellsPlayer` rebuilt: drei `<Html>` name label with `anchorInFrontOfCamera` dot-product cull (safe on Iris Xe, NO drei Text); elimination = gravity drop (980wu/s²) + fade over 1s (vs. flat fade before); self-hit fires `onSelfHit` callback → shake + flash. `BumperShellsParticles`: BURST_POOL_SIZE 4→6, BURST_POINT_COUNT 16→12, upward-biased scatter directions. Fog: FOG_NEAR=900 / FOG_FAR=1800 (safe for perspective cam — arena disc 500wu fully visible). Shadow map 512→1024 (chase cam is much closer). Draw call budget: platform(1) + tile(1) + rim(1) + bumper-wall(1) + danger(1) + void(1) + stars(1) + hazard(2) + players(≤8) + pickups(≤6) + particles(6) = ≤28 base + ≤14 players/pickups = ≤42 total. Prior: Bumper Shells client-side interpolation — `BumperShellsPlayer.tsx` chunk #13: 4-slot snapshot history ring per entity, render at `now - 100ms`, linear lerp on x/z/vx/vz, shortest-angle rotation lerp. Zero per-frame allocations. Eliminates 15Hz teleport jitter at 60fps.) Prior: (Bumper Shells arena visibility fix: FOG_NEAR/FOG_FAR corrected from 200/900 to 1400/1500 — ortho camera at (0,1100,300) is ~1140wu from arena floor, all geometry was 100% fogged at old FAR=900. HEMI_INTENSITY 0.4→1.4, HEMI_SKY #1a3a5c→#4488cc, DIR_COLOR #80d4ff→#ffffff, DIR_INTENSITY 1.1→2.0, fill directional added at (-150,-200,-100) intensity 0.6, platform colour #1a2a3a→#1e3a5f, accent point distances 350-400→550-600 + intensities 0.5-0.6→1.0-1.2. See §12.1.) Prior: C6 asset pipeline: meshopt + WebP compression applied to all 54 eligible GLBs/VRMs. Total public asset bundle 45.9 MB → 14.5 MB (-68%, -31.4 MB). Key files: guide.glb 11.4 MB → 1.1 MB (-90%), guide-rigged.glb 5.7 MB → 1.3 MB (-77%), 8 Milady VRMs 11.7 MB → 2.4 MB (-80%). MeshoptDecoder registration added at app boot (meshopt-loader-setup.tsx + World3DCanvas import). VRM blendShapeMaster morph indices verified intact post-compression. No-gain files kept original (Draco-heavy geometry: building-chest, jellyfish, octopus_toy, pineapple-house, salty-spitoon, sea_horse). Script: `bun run assets:optimize` at repo root. See scripts/assets-optimize.ts.) Prior: Two VRM scale fixes: (1) `PET_VRM_SCALE=28` added to `player-avatar.tsx` — Milady player-avatar was using `reg.scale=13` (picker-only), rendering at ~21wu vs wandering NPCs at ~180wu. `PET_VRM_SCALE=28` targets 44.8wu matching lobster `AVATAR_SCALE=40`. (2) Picker camera lift — SelectAgentCanvas VRM OrbitControls target `[0,14,0]→[0,17,0]`, initial camera `[0,12,45]→[0,16,50]`. Mobile portrait cropped Milady from mid-thigh down; scale multiplier 2.1× unchanged, camera repositioned to center the viewport on torso instead of waist. §10 scale table updated (VRM_NPC_SCALE corrected 28→112 — was stale from pre-2× bumps). §11 camera table updated.) Prior: Sakura review fixes: `_skeletonUpdateFns` changed from Array to `Map<THREE.Skeleton, () => void>` — dispose() now restores via Map.forEach instead of index-aligned traversal, safe against scene graph mutations. Added dev-mode double-patch warning before `.bind()`. `VRMNpcMesh` lookAt/expressionManager nulling changed `undefined` → `null`; neither class exposes `dispose()` in three-vrm 3.5.2 (verified). `useEffect` changed to `useLayoutEffect` to close 1-frame window before browser paint. VRM cache path-collision invariant extended in §10: player-avatar does NOT use lookAt/expressionManager today, but if it ever does, wandering NPC paths (official_2/3/4/7/8) must not overlap the player-avatar's selected path.) Prior: Phase A+B initial FPS fixes — see §10 VRM Avatars + §11 Performance Budget for details.) (VRM facing formula corrected — was `atan2(vx, -vz)` which inverted east/west facing (Miladys walked backwards). Now `atan2(-vx, -vz)`. Proof: Three.js right-hand Y rotation is CCW viewed from above; rotating a -Z-facing VRM by +π/2 brings it to -X, not +X — so atan2(+1, 0)=+π/2 aimed the NPC AWAY from +X travel. Negating vx fixes the sign. GLB path `atan2(glbVx, glbVz)` untouched (+Z-forward models, correct). Hermitcrab scale reduced 4→2 — user reported still "HUGE" after the SkeletonUtils.clone fix exposed full animated skeleton extent. See §5 + §9.) Prior: Four town-center fixes: (1) Quest NPC crayfish target height 61→80wu (more visible). (2) TownDirectorySign doubled: POST_H 140→280, POST_SPACING 110→220, PLANK_H 80→160, font 18/13→40/28px, SIGN_Z -50→-120. BountyBoardObject removed from scene (modal still accessible via sidebar). (3) Auction dome DOME_Y +6→+12 (base mesh still clips sand). (4) Marketplace stall STALL_Y +2→+4 (floor misalignment). See §4 town-center table.) Also: SPECIES_WANDER_SCALE_OVERRIDE recalibrated after SkeletonUtils.clone fix: hermitcrab 16→4, lobster added at 22. Old values were calibrated against a frozen bind-pose (bones bound to another instance's skeleton); with bones now properly rebound, animated skinned mesh extends 4× further. See §9 NPC scale bullet.)
> **Prior Audited:** 2026-04-23 (Free roamers now patrol the town ring instead of crowding the center + velocity-driven facing kills "walking backwards" visual. **Annulus wander:** FREE_ROAMER_MIN_RADIUS=500 + FREE_ROAMER_MAX_RADIUS=1700 in `apps/api/src/services/npc-simulation.ts`. planCenterWander samples uniform area in the annulus via `r = sqrt(u*(Rmax²-Rmin²) + Rmin²)`. Miladys patrol the band between the town-center furniture cluster (Nori/podium/bazaar within ~300wu) and the 2176wu building ring. planApproachNearbyNpc keeps only the outer bound; a Milady may visit another wanderer passing through the inner circle, next plan tick snaps them back out. NPC_DEFINITIONS Milady home coords re-anchored to ring positions: Miu SW (1700,3200), Kyoko NE (3400,1900), Vivi NW (1700,1900), Maple SE (3400,3200), Ash N (2560,1700). patrolRadius 400 → 500. **Velocity-driven facing:** both VRMNpcMesh + GLBNpcMesh compute per-frame velocity (new pos - previous pos, captured BEFORE the lerp) and aim rotation along it via `atan2(vx,-vz)` for VRM (-Z forward after rotateVRM0) and `atan2(vx, vz)` for GLB crustaceans (+Z forward per preview calibration). Movement threshold 0.25 wu² prevents idle jitter from spinning bodies. Rotation lerp 8*dt → 12*dt so 180° path flips complete in ~0.25s (was 0.4s — the "moonwalk" window). Possessed NPC preserves server-provided facingAngle path (player input is camera-relative). See §5 Wandering NPCs + §4 Town Center.)
> **Prior Audited:** 2026-04-23 (Milady NPCs 4× size + free-roamers constrained to town-center ring + Nori weight=0 bug fix. **Milady scale:** VRM_NPC_SCALE 28 → 56 → 112 (two 2× bumps per user feedback). Miladys now render ~180 wu tall (4× the 45wu lobster baseline) so they read as the dominant human-scale cast. Registry scale=13 stays for the picker. **Free-roamer wander:** server NPC sim's free-roamer branch (id prefix `milady-` / `wanderer-`) previously took Miladys to the outer ~2176wu building ring via planVisitBuilding (60%) and anywhere in the 5120wu map via planWander (20%). Rewrote the free-roamer branch to pick between two new behaviors constrained inside FREE_ROAMER_MAX_RADIUS=900 of town-center (2560, 2560): (1) `planCenterWander` samples a point inside the 900wu disk via sqrt(random)×R for uniform area sampling; (2) `planApproachNearbyNpc` filters candidate NPCs by "also inside the 900wu ring" before pathfinding, so Miladys never chase a building resident out of the ring. Split is 50/50, building visits + global wander dropped entirely for free roamers. NPC_DEFINITIONS Milady home coords re-anchored inside the ring (Miu/Kyoko/Vivi/Maple/Ash now at ~300-600wu from town center) and patrolRadius 600/700 → 400 to match. **Nori cycle fix:** `VRMCharacterAnimator` equivalent — three.js's `AnimationAction.fadeIn()` multiplies by `action.weight`, so init setting `action.weight = 0` made `effectiveWeight = 0 × (0→1) = 0` forever on every cycle slot. CDP probe caught 9 actions "running" with mixer.time ticking but all effWeight=0.000. Fix: keep weight=1 (default) and gate inactive slots via `enabled = false`. `reset()` re-enables + zeros time so multi-frame clips restart from frame 0; fadeIn's 0→1 interpolant multiplies by intact weight=1 to give the full ramp. Wave clip stays chat-only (never .play()-ed at init; only `handleClick` starts it). See §4 Town Guide row + §10 VRM Avatars.)
> **Prior Audited:** 2026-04-23 (Nori cycling restored via safe continuous-play pattern + VRM NPCs no longer pan-disappear. **Nori cycle:** Reinstated the 9-clip pose cycle using continuous-play + weight blending instead of LoopOnce + 'finished' events. All 9 `CYCLE_CLIPS` actions are `.play()`-ed at init under `LoopRepeat`, `timeScale=1`, with `weight=0` for all but the first slot. A `SLOT_DURATION_SEC=5` timer (useFrame clock comparison, not setInterval) advances the cycle via `next.reset().fadeIn(0.5)` + `cur.fadeOut(0.5)`. Why this avoids the 8281162 regression: every action keeps writing through the crossfade, so the blend interpolates pose-A → pose-B instead of falling back to track-default (T-pose). Long clips (bellydancing 762fr, samba 595fr) are included but truncated to the 5s slot. Wave still interrupts via click → `cur.fadeOut(0.35)` + `wave.reset().fadeIn(0.35).play()`; on wave-'finished' the cycle resumes at the next slot. **VRM far-cull widened:** new `VRM_NPC_CULL_DIST_SQ = 10000*10000 = 100M` (vs GLB's 2500² = 6.25M) effectively disables far-cull for the 5 Milady wanderers. Previously, a camera orbit on the 5120wu map routinely pushed NPCs across the 2500wu ring, causing visible pop-in/pop-out as users rotated. With only 5 VRMs the always-on cost is bounded (~5 × 1ms spring at half-rate + mixer). Added defensive `vrm.scene.traverse(o => o.frustumCulled = false)` on every VRMNpcMesh mount — belt + suspenders against any three-vrm / post-processing pass that might flip it back on. See §4 Town Guide row + §10 VRM Avatars.)
> **Prior Audited:** 2026-04-23 (VRM crossfade silent-freeze fix — `VRMCharacterAnimator.update()` called `AnimationAction.crossFadeTo(next, 0.3, true)` without ever calling `.play()` on the incoming action. three.js's crossFadeTo schedules weight fades but does NOT start the incoming action — at init() only `idle.play()` runs; `walk` and `run` stay stopped. The first idle→walk transition faded idle's weight to 0 while walk's weight ramped to 1, but `walk.isRunning` stayed false, so walk tracks never wrote to Normalized_mixamorigHips. Symptom caught via CDP probe 2026-04-23: Milady VRM NPC with `wasMoving=true`, `currentAction='walk'`, `walk.isRunning=false`, `idle.timeScale=11.65` (warp residual), hip quaternion stuck at identity (0,0,0,1). The `wasMoving=true` flag on one but not all NPCs explained why users saw "some Miladys T-posed, some animating" — only NPCs whose server direction toggled hit the crossfade path. Fix: new `applyCrossfade(isMoving)` method does `next.reset().fadeIn(CROSSFADE_DURATION).play()` then `prev.fadeOut(CROSSFADE_DURATION)`. Also dropped `warp=true` — the Mixamo walk(1.03s)/idle(12s) ratio of ~11.65× persisted on outgoing timeScales across transitions. Shared between `update()` (full 60Hz mixer+vrm) and `updateMixerOnly()` (mixer 60Hz, spring 30Hz split). See §10 VRM Avatars.)
> **Prior Audited:** 2026-04-23 (Town Guide (Nori) animation regression fix — reverted `town-guide.tsx` from the broken 9-clip cycling pattern (commit 8281162) back to the pre-cycle single-frozen-pose pattern. Root cause: 1-frame POSE clips fire LoopOnce 'finished' almost immediately; during the 0.5s crossfade BOTH outgoing and incoming actions were at time=0 = T-pose neutral, producing visible T-pose reversion on every slot advance. Fix: `CLIP_IDLE='pose-hand-on-hips'` played LoopOnce with `timeScale=0` (frozen frame-0 pose forever). Wave-on-click crossfades idle→wave→idle. Also fixed silent breathing-animation loss: three.js GLTFLoader sanitizes bone names by stripping colons, so `mixamorig:Spine2` became `mixamorigSpine2` — lookup now checks both forms. Removed module-scope `CYCLE_CLIPS`/`LONG_CLIP_NAMES`/`LONG_CLIP_MAX_SEC`/`CYCLE_FADE`/`cycleActionsRef`/`cycleIndexRef`/`playCycleSlot`. See §4 Town Guide row.)
> **Prior Audited:** 2026-04-23 (VRM animation retargeter rewritten as direct port of Milady's retargetMixamoGltfToVrm — applies rest-pose-differential quaternion transform `q.premultiply(parentRestWorld).multiply(restRotInv)` + VRM-0 axis flip, fixes permanent T-pose caused by naive clone+rename. Mixer re-rooted at vrm.scene (was normalizedHumanBonesRoot). Cache in vrm-character-animator.ts now stores full GLTF ({scene, animations}) since retargeter needs animation.scene for rest-pose world quaternion queries. See §10 VRM Avatars.) Prior: Decoration merge spatial-chunking fix: iteration 3a merged all 80 decorations into one mesh per material (frustumCulled=false) → +33% tris, -2.6 FPS regression. Iteration 3b adds 3×3 spatial grid bucketing so each (cell, material) bucket gets a tight AABB and frustumCulled=true works correctly — off-screen cells are culled, restoring the pre-merge triangle budget for the spectator camera facing town center. See §10 "Decoration geometry merge".) Prior: VRM MToonNodeMaterial migration.
> **Prior Audited:** 2026-04-23 (Perf iteration 2 — idle-animation throttle. `applyStationaryIdleAnimation` (location NPCs) and `applyIdleAnimation` (wandering GLB NPCs in idle state) now run at 20Hz instead of 60Hz. Achieved by `(frame + seed) % 3 === 0` gate in both `arena-location-npcs.tsx NpcMesh.useFrame` and `arena-npcs.tsx GLBNpcMesh.useFrame`. All animation frequencies ≤1.3 rad/s — 20Hz sampling has 48× Nyquist margin, imperceptible difference. Walk animations unthrottled (8 rad/s squash/stretch needs 60Hz). AnimationMixer (Pearl Krabs) unthrottled (keyframe interpolation already efficient, skipping causes pose pops). Stagger by per-NPC seed prevents all 12 location NPCs updating on the same 3-frame slot. Expected: ~40% reduction in idle trig ops/frame across 18 wandering + 12 location NPCs.)
> **Prior Audited:** 2026-04-23 (Town Guide scale doubled 100→200 to make Nori more visible and match environment proportions. See §4 Town Guide row.)
> **Prior Audited:** 2026-04-23 (VRM T-pose root-cause fix — `mixamo-retarget.ts` was calling `humanoid.getRawBoneNode()` to resolve Mixamo → VRM bone targets, but @pixiv/three-vrm v3 drives animation through the *normalized* bone hierarchy (`Normalized_*` nodes under `VRMHumanoidRig`). The `AnimationMixer` writes to normalized bones; `vrm.update()` propagates them to raw bones each frame. Targeting raw bones directly is clobbered by `vrm.update()` on every frame — the normalizer reads the raw-bone rest pose and overwrites it. Fix: changed all `getRawBoneNode()` calls to `getNormalizedBoneNode()` in `retargetMixamoClip()`. Retargeted track names are now `Normalized_mixamorigHips.quaternion` etc., which `vrm.scene.getObjectByName()` resolves correctly since `VRMHumanoidRig` is a child of `vrm.scene`. Pearl Krabs and Flying Dutchman confirmed visible in their building slots (cron-automation + api-integrations). Pearl is in rest pose (non-T-pose, non-identity bone quaternions). VRM NPC bones should now animate after deploy. `skinnedCulled: 0` regression confirmed still holds. See §10 VRM Avatars.)
> **Prior Audited:** 2026-04-23 (Town Guide rewritten to Mixamo-rigged FBX pipeline — `guide.glb` (procedural skirt + arm rotations) replaced by `guide-rigged.fbx` + 11 Mixamo animation FBXs. Module-scope `Promise.all` loads all 12 FBX files in parallel; `AnimationMixer` drives `pose-hand-on-hips` (LoopOnce, timeScale=0 → freeze at frame 0) as default idle. Wave-on-click via crossfade idle→wave→idle (WAVE_FADE=0.35s). Procedural breathing additive over mixer via `mixamorig:Spine2` scale.y. Removed: procedural cylinder skirt, arm rotations, `guide.glb` / `useGLTF.preload`. Invariants preserved: `GROUND_Y=-2`, `GUIDE_Z=240`, `GUIDE_SCALE=100`, `frustumCulled=false` traverse, no drei Text/Billboard, no per-frame allocations. See §4 Town Guide row.)
> **Prior Audited:** 2026-04-23 (frustum-cull fix extended to ALL rigged clone sites — `arena-location-npcs.tsx`, `player-avatar.tsx`, `quest-npc.tsx`, `town-guide.tsx`, `auction-podium.tsx` now each call `c.traverse(o => { o.frustumCulled = false; })` immediately after their respective `scene.clone(true)` / `SkeletonUtils.clone()` call. Previous fix only covered `arena-npcs.tsx` + `vrm-loader.ts`. CDP probe confirmed `skinnedCulled` was 14 pre-fix (all from building-resident rigs). Post-fix target: 0. Rule: every clone site that produces a SkinnedMesh tree MUST apply this traverse — the fix is not location-specific, it's a global invariant for any rigged GLB clone.)
> **Prior Audited:** 2026-04-23 (NPC cull 2000→2500wu + label display-leak fix — 2 bugs fixed in `arena-npcs.tsx`: (1) `NPC_CULL_DIST_SQ` raised `2000→2500` (6_250_000) — camera at y≈600 means XZ distances to mid-world NPCs are 1300–2500wu; old 2000wu threshold culled them the moment the player was not standing directly beneath them. 2500wu covers ~half the map radius and matches fog effective visibility. `VRM_NPC_HALF_RATE_DIST_SQ` raised `800→1000` proportionally. (2) React memo label display-leak — `memo()` shallow-compare sees new `npc` object ref on every SSE snapshot and re-renders, re-applying the JSX inline `display: 'flex'` which clobbered the cull-frame `display: 'none'`. Transition-only guard then skipped re-writing because `group.visible` was already false. Fix: JSX default changed to `display: 'none'` in both `GLBNpcMesh` and `VRMNpcMesh`; useFrame cull blocks now always-write (`if (label.style.display !== X) label.style.display = X`) instead of transition-only — applied to both visible=false and visible=true branches in both components.)
> **Prior Audited:** 2026-04-21 (VRM NPC frustum-cull + T-pose + disappear-at-close-range regression — 4 bugs fixed in `vrm-loader.ts` + `arena-npcs.tsx`:
> 1. **Frustum culling on VRM SkinnedMesh** — VRM bind-pose bounding spheres don't encompass the animated pose; Three.js culled NPCs at close range or steep camera angles. Fix: `vrm.scene.traverse(o => { o.frustumCulled = false; })` added in `vrm-loader.ts` after `rotateVRM0`. Applied to every VRM loaded, including player avatar.
> 2. **Frustum culling on GLB SkinnedMesh clones** — same issue for animated GLB NPCs (Marlin/sweet_crab). Fix: `c.traverse(o => { o.frustumCulled = false; })` added in `GLBNpcMesh` useMemo after `scene.clone(true)`.
> 3. **Missing module-scope preloads for Vivi/Maple/Ash** — only milady_official_7 and milady_official_8 were preloaded at module scope; milady_official_2/3/4 cold-started, leaving Vivi/Maple/Ash in T-pose until Suspense resolved AND animation clips loaded (race condition vs. animator.init()). Fix: `preloadVRM` calls added for official_2, official_3, official_4.
> 4. **NPC_CULL_DIST_SQ too small** — several NPCs (Maple at world ~940,940 dist≈1329wu; Miu at world ~-1160,440 dist≈1242wu) spawn beyond the old 1200wu cull threshold. Their `group.visible` was set to `false` on the very first frame; VRM animators never ran, leaving permanent T-pose regardless of animation state. Fix: `NPC_CULL_DIST_SQ` raised `1200→2000` (squared); `VRM_NPC_HALF_RATE_DIST_SQ` raised `600→800` proportionally.
> Prior audit 2026-04-23 (Ghost-label regression fix — `arena-npcs.tsx`: drei `<Html>` is a DOM portal outside the Three.js scene graph; setting `group.visible=false` in the distance-LOD cull path does NOT propagate to the DOM div. All 10 building-ring NPCs (radius ~2176wu) are beyond the 1200wu cull threshold at startup, causing their 3D meshes to be hidden while floating labels persisted. Fix: `labelRef = useRef<HTMLDivElement>(null)` added to both `GLBNpcMesh` and `VRMNpcMesh`; cull block imperatively sets `labelRef.current.style.display = 'none'/'flex'` in sync with `group.visible`. Zero React re-renders — purely imperative DOM in useFrame. Same fix applied to all 18 wandering NPCs (10 building-anchored GLBs + 3 Milady VRM free wanderers + 5 crustacean/sea-creature free wanderers). Also: wandering NPC cast updated to 18 members — see §5 table.)
> Prior audit 2026-04-21 (Perf sweep — comprehensive R3F/Three.js pattern audit across all 14 three/ files. Fixes: terrain mesh cache added to arena-location-npcs.tsx (`intersectObject(mesh,false)` replaces scene-wide traversal); `distanceFactor` removed from npc-speech-bubbles.tsx `<Html>`; module-scope scratch vectors/matrices in click-to-move.tsx + trail-renderer.tsx; particle-system.tsx pool filter moved into useFrame state; matrixAutoUpdate=false applied to 9 newly-frozen categories of static meshes (bounty board, 80 decoration objects + children, underwater atmosphere planes/points, 7 light ray cones, podium steps/rim/cone/hitbox, 3×3 bazaar pedestal meshes); activity-indicators.tsx narrowed NPC store subscription to indicator-only fields; World3DCanvas.tsx `gl.setPixelRatio()` override removed (dpr prop handles clamping). TypeScript: 0 errors. See §11 Performance Budget for detail.)
> Prior audit 2026-04-22 (Town Guide skirt raised to natural waist: geometry widened to `CylinderGeometry(topR=0.19, botR=0.32, h=0.38)` and position moved from local y=-0.19 to y=-0.04 so the top edge sits at +0.15m above the Hips_04 joint (~15cm natural waist lift). Closes visible midriff gap between torso and skirt top. See §4 Town Guide row.)
> Prior audit 2026-04-22 (Town-center rework Phase 1 Rev 3b: Option C tuned — Town Guide pushed to `(0,-2,+240)` (was +100, which still left her inside the podium's 144u bottom-radius footprint from z=-94 to z=+194). At z=+240 she's ~46u south of the podium's ground edge, rendering fully in front. Player spawn moved to `(2560,2940)` = world `z=+380`, 140wu south of the guide. Marketplace anchor sizes unchanged. See §4.)
> Prior audit 2026-04-17 (Arrow up/down now drives explicit vertical swim; WASD restored to always-flat XZ camera-relative — mouse orbit no longer causes altitude drift. `camForward.y` is zeroed immediately (no camForwardY capture); `keyState.arrowup`/`arrowdown` accumulate `playerAltitude` when airborne. See §3 "Swim altitude.")
> Prior audit 2026-04-21 (2 Milady VRM wandering NPCs added to DEMO_NPCS: "Miu" species=milady_official_7 pos=(1400,3400) and "Kyoko" species=milady_official_8 pos=(3800,1200). `arena-npcs.tsx` now has `VRMNpcMesh` component parallel to `GLBNpcMesh`; `ArenaNpcs()` routes by `MODEL_REGISTRY[npc.species].avatar_type`. VRM_NPC_SCALE=28 targets 45wu matching lobster NPCs. §10 updated: VRMs no longer player-avatar-only. See §5 demo NPC table and §10.)
> Prior audit 2026-04-21 (Fixed charged-launch release bug: `holdMs` was zeroed in the same frame as SPACE release, making `< TAP_THRESHOLD` always true and the scaled-launch branch unreachable except via auto-launch. Fix: accumulate `holdMs` only while held; reset on new press in `case 'grounded'`, not on release. Player WASD now camera-relative (matching NPC mode) — old screen-relative was world-fixed after arrow-key orbit. VRM path updated alongside GLB path. See §3 "Jump System".)
> Prior audit 2026-04-21 (VRM Milady avatars added: 8 VRM player-avatar avatars, new `avatar_type` field on ModelRegistryEntry, `vrm-loader.ts` + `vrm-character-animator.ts` + `mixamo-retarget.ts` new files, 3 anime GLBs deleted. See §10 "VRM Avatars".)
> Prior audit 2026-04-21 (`JUMP_MIN_CHARGED_VZ` lowered 250→100 so release just past the tap threshold matches tap peak — removes the 6× step discontinuity at 200ms. See §3 "Jump System".)
> Prior audit 2026-04-21 (Charge scale switched from vz-linear to vz²-linear for linear peak perception. Camera now translates with target during high jumps to preserve orbit geometry. See §3 "Jump System".)
> Prior audit 2026-04-21 (Jump system switched from immediate-launch + seamless-thrust-upgrade to charge-and-release. Peak clamp removed; max charged peak ≈ 1500wu. Quick tap behavior unchanged. Idle rotation freeze added to player-avatar — avatar no longer snaps to +Z on WASD release. Charge bar UI added (`charge-bar.tsx`). See §3 "Jump System".)
> Prior audit 2026-04-17 (Jump system spec — three rounds of audit complete — two-stage SPACE input: tap = quick ballistic jump (~33 wu peak, ~1.1s airtime), hold = power thrust clamped at 140 wu peak, then ~3.15s slow underwater sink with full horizontal WASD control. Jump state is module-scoped (NOT Zustand). Physics tick runs in a dedicated `<JumpTicker />` component mounted BEFORE consumers so FPSFollowCamera + NPC render read current-frame state (no 1-frame lag). SPACE listener lives in `jump-state.ts` alongside its state; WASD listeners stay in their respective controllers, picking up the pre-existing target-guard fix. resetJump() hooks into all 4 controlMode mutation paths + enterBuilding. Keydown target-guard only (keyup always clears). FPSFollowCamera target.y tracks jumpState.heightOffset so avatar stays on-screen at peak. See §3 "Jump System".) **Implementation shipped 2026-04-17.** Physics verified: tap peak=33.69 wu (spec ~33), airtime=1.10 s (spec ~1.09); hold peak clamp=141.53 wu (within 1-frame DT overshoot, clamp fires correctly); mid-air re-press no-op confirmed. TypeScript build passes clean.
> Prior audit 2026-04-17 (Quest NPC relocated from (0,0) to (-110,-60) — was sitting on top of bazaar pedestals; now flanks the marketplace cluster to the west. See §4.)
> Prior audit 2026-04-16 (player NPC render gate: filter PLAYER_NPC_ID out of ArenaNpcs when controlMode !== 'npc'; same gate in updateFromSnapshot; fixes giant center lobster in agent mode)
> Prior audit 2026-04-17 (scale bug fix: AVATAR_SCALE 20→40. lobster.glb native height is 1.12 native units per GLTF accessor bounds; AVATAR_SCALE=20 gave 22.4 wu — half the intended 45 wu — making player avatar appear 2× smaller than wandering NPC lobsters which correctly normalize to 45 wu via computeNpcScale. Fix brings player avatar to 44.8 wu matching NPC target.)
> Prior audit 2026-04-16 (talk-to-character: building-zone proximity replaced by character-position proximity; character-positions.ts new shared module; TALK_RADIUS_WORLD=260; nearCharacter store field added)
> Prior audit 2026-04-16 (5 surgical visual fixes: Plankton scaleOverride=110, NPC name labels raised to constant y=150wu, Gary companion rotYOffset=-π/2, salty-spitoon rotYOffset=-π/2, boating-school rotYOffset flipped -π/2→+π/2 so classroom faces center)
> Prior audit 2026-04-16 (avatar scale-down pass 2: AVATAR_SCALE 33→20, TARGET_NPC_HEIGHT 75→45, CHARACTER_HEIGHT 90→55, SPEED 320→550, HARD_MAX arena-npcs 160→95, HARD_MAX arena-location-npcs 190→115, Larry scaleOverride 90→55, Karen scaleOverride 60→37)
> Prior audit 2026-04-16 (three fixes: pineapple decorative-mesh strip → height 800; NPC inset 128→600 wu; companion offsetX 60/80→180)
> Prior audit 2026-04-16 (avatar scale-down pass 1: AVATAR_SCALE 55→33, TARGET_NPC_HEIGHT 120→75, CHARACTER_HEIGHT 140→90, SPEED 200→320)
> Prior audit 2026-04-16: three building-level fixes in `arena-buildings.tsx`:
> A) Pivot recenter (rotation-aware) — `pivotOffsetX/Z = bbox_center_XZ * scale` is applied via a nested `<group position={[-pivotOffsetX, 0, -pivotOffsetZ]}>` **inside** the rotating outer group. Outer group sits at `(cx, y, cz)` with no offset; inner group carries the pivot correction so it rotates with the geometry. This ensures the bbox center lands exactly at `(cx, cz)` for **any** rotY — not just when pivotOffset≈0. The prior approach (subtracting offset from outer position) broke for `downtown-building.glb` (bbox center ~4120wu off-pivot) at rotY=-1.882, placing it 4856wu east and 4647wu south of the intended zone.
> B) Footprint cap — `MAX_FOOTPRINT = 1000` wu (tightened from 1400 during ring expansion).
> C) Boating-school rotation — `rotYOffset: -Math.PI/2` added to `app-publishing` BUILDING_MODELS entry; applied as `(rotY ?? 0) + (rotYOffset ?? 0)` in both normal and edit mode. Corrects for +X authoring convention on the vehicle GLB.)
> Source-of-truth audit of the scene graph actually rendered by `apps/web`.
> All constants, positions, rotations, and counts are pulled directly from
> code — verify any claim against the cited `file:line`.

---

## 1. World Dimensions & Coordinate System

**Source:** `apps/web/src/lib/pixi/tilemap-data.ts:6-10`

| Constant | Value |
|---|---|
| `TILE_SIZE` | `32` px |
| `MAP_COLS` | `160` |
| `MAP_ROWS` | `160` |
| `MAP_WIDTH` | `5120` (= 160 × 32) |
| `MAP_HEIGHT` | `5120` (= 160 × 32) |
| `HALF_W` | `2560` — `World3DCanvas.tsx:40` |
| `HALF_H` | `2560` — `World3DCanvas.tsx:41` |

### Game-space → 3D world conversion

- **Game-space (2D pixel plane):** `(0..5120, 0..5120)` — origin at top-left,
  +x = right, +y = down. Used by player, NPCs, click-to-move, building zones.
- **Three.js world (XZ plane):** `(-2560..+2560, -2560..+2560)` — origin at
  center, +X = right, +Z = *game-space down* (south).
- Conversion: `worldX = gameX - HALF_W; worldZ = gameY - HALF_H`
  (`World3DCanvas.tsx:291-293`, `player-avatar.tsx:84-86`,
  `arena-npcs.tsx:31-33`).
- Village center tile `(80, 80)` → world `(0, 0)` —
  `arena-buildings.tsx:48-50`, `arena-location-npcs.tsx:50-52`.

### Axes

| Axis | Meaning |
|---|---|
| `+X` | East (right on the 2D map) |
| `+Y` | Up (toward water surface) |
| `+Z` | South (down on the 2D map) |
| `-Z` | North (up on the 2D map) |

Sand floor sits at `y = -2` (`arena-terrain.tsx:203`). Buildings, NPCs, and
decorations ground to this plane.

---

## 2. Building Layout — Circular Ring

**Village center:** tile `(80, 80)` → world `(0, 0)`
(`arena-buildings.tsx:48-50`, `arena-location-npcs.tsx:50-52`,
`merged-seaweed.tsx:225-226`).

**Building target height:** `BUILDING_TARGET_HEIGHT = 800` world units
(`arena-buildings.tsx:44`). Every GLB is measured and scaled so its **Y-height
(not max-dim)** = 800. This was changed from `max(w,h,d)` normalization on
2026-04-16 scale-regression fix — wide/squat buildings (salty-spitoon,
boating-school) had their width > height, so the old approach crushed building
height far below 800.

**Footprint cap:** `MAX_FOOTPRINT = 1000` wu (`arena-buildings.tsx`). After
height normalization, if `max(scaledSx, scaledSz) > 1000`, scale is reduced so
the widest XZ dimension = 1000. Wide buildings (pineapple, salty-spitoon,
boating-school) are shrunk further and will stand somewhat shorter than 800 but
won't sprawl and visually dominate the ring. Tightened from 1400→1000 on
2026-04-16 ring expansion (56→68 tiles): at radius 68, circumference/10=1367 wu
per slot; a 1000 wu cap leaves a 367 wu (~11 tile) gap between buildings.

**Pivot correction (rotation-aware, XZ+Y):** `computeBuildingScale()` returns `{ scale, pivotOffsetX, pivotOffsetY, pivotOffsetZ }` where:
- `pivotOffsetX/Z = bbox_center_XZ * scale`
- `pivotOffsetY = bbox.min.y * scale`

The offsets are applied via a nested inner group **inside** the rotating outer group:
```
outer group: position=(cx, -2 + yOffset, cz), rotation=(0, rotY, 0)
  inner group: position=(-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ)
    primitive (GLB scene)
```
**XZ correction:** Because the inner group lives in the outer group's local (rotated) frame, the pivot correction rotates with the geometry. Net world XZ of the bbox center = `(cx, cz)` for any rotY. The prior approach subtracted from the outer group's world position, which broke for `downtown-building.glb` (bbox center ~4120wu east of scene pivot) at rotY=-1.882 — placing it 4856wu east and 4647wu south of the intended zone.

**Y correction (grounding):** `pivotOffsetY = bbox.min.y * scale` is the world-space distance from the GLB pivot to the geometry floor. Applying `-pivotOffsetY` on the inner group ensures the geometry floor always lands at the outer group's Y (-2 = sand floor), for all three authoring cases:
- `bbox.min.y > 0` (geometry authored above pivot, e.g. downtown-building had minY=+116/scale): inner shifts down by pivotOffsetY, cures floating
- `bbox.min.y = 0` (pivot at geometry floor): pivotOffsetY=0, no-op
- `bbox.min.y < 0` (geometry extends below pivot): inner shifts up, cures underground clipping

World-space floor proof: `-2 + (-pivotOffsetY) + pivotOffsetY = -2` ✓

**Bbox method:** `computeBuildingScale()` traverses only non-SkinnedMesh nodes
and transforms each geometry bbox into world space via `mesh.matrixWorld`
(with a `scene.updateMatrixWorld(true)` call first). Falls back to full
`Box3.setFromObject()` if no non-skinned geometry found. This avoids
bind-pose inflation on any rigged props inside building GLBs.

**Decorative mesh strip:** `stripDecorativeMeshes()` removes meshes whose
parent chain contains any name in the set
`DECORATIVE_PARENT_NAMES = {Flowers, Path, Skybox, Road, Sand}` (`arena-buildings.tsx:110`).
Applied before `stripGroundPlanes`. Two fixes:
1. pineapple-house.glb — `Flowers`+`Path` inflated XZ bbox to 1852×1415 wu,
   triggering MAX_FOOTPRINT=1000 and crushing height to ~432. After strip,
   bbox shrinks to ~SpongebobsHouse+Chimney (near 1:1 aspect) and height
   reaches the full 800 target.
2. chum-bucket.glb — `Skybox`+`Road`+`Sand` baked a huge blue dome + road
   + sand plane into the GLB; without stripping, the bucket rendered tiny
   inside a massive blue sphere. Strip removes the scenery so only the
   bucket normalizes to the 800 target.

**Ground plane strip:** `stripGroundPlanes()` removes flat meshes at the
bottom of each GLB before height normalization. The full-model bounds used
for the "is at bottom" threshold are computed from non-SkinnedMesh geometry
only (same traversal as `computeBuildingScale`). Previously used
`Box3.setFromObject()` which could inflate `fullHeight` for any rigged prop,
causing real structural geometry to be wrongly classified as a ground plane.
(`arena-buildings.tsx`).

### Ring geometry

- **Radius:** 68 tiles from center tile `(80, 80)`. (Expanded from 56 on 2026-04-16 to eliminate building overlap.)
- **Ring radius in world units:** 68 × 32 = **2176 wu**.
- **Angular spacing:** 36° (π/5 rad) — 10 evenly-spaced positions around
  the full circle.
- **Start angle:** θ = −π/2 (top center, north). Winding: clockwise.
- **Position formula:**
  `cx = round(80 + 68·cos(θ_i))`, `cy = round(80 + 68·sin(θ_i))`
  where `θ_i = −π/2 + i·(π/5)` for `i = 0..9`.
- **Zone footprint:** 14 × 14 tiles (`448 × 448` world units).
  Zone upper-left = `(cx − 7, cy − 7)`.
- **Max zone edge:** tile 155 (deployment-ops bottom: 141+14) — fits within 160-tile map with 5-tile buffer.
- **Minimum inter-center spacing:** 68 × 2 × sin(π/10) ≈ 42.1 tiles.
  Zone diagonal ≈ 14√2 ≈ 19.8 tiles — no overlap.
- **Circumference/10:** 2π × 2176 / 10 = **1367 wu per slot**.
  With MAX_FOOTPRINT=1000, gap between buildings = **367 wu (~11 tiles)**.

Source: `tilemap-data.ts:41-77`, `npc-definitions.ts:38-53`.

### Buildings — full table

Rotations face the model toward world-origin `(0, 0)` via
`rotY = atan2(dx, dz)` where `dx = 80 − cx_tile`, `dz = 80 − cy_tile`
(model faces `+Z` at `rotY=0`). `BUILDING_MODELS` at `arena-buildings.tsx:52-63`.
Note: rotY values in BUILDING_MODELS are retained from the r=56 ring — the
difference is sub-0.003 rad (imperceptible) and were not changed to avoid churn.

| Ring i | θ | Building ID | Name (Theme) | Zone top-left (x,y) | Center tile | World (x, z) | GLB | `rotY` (rad) |
|---|---|---|---|---|---|---|---|---|
| 0 | −π/2 (top) | `visual-creation` | Biolume Studio | `(73, 5)` | `(80, 12)` | `(0, −2176)` | `/models/pineapple-house.glb` | `0.000` |
| 1 | −3π/10 | `memory-rag` | Abyssal Vault | `(113, 18)` | `(120, 25)` | `(1280, −1760)` | `/models/bb-building.glb` | `−0.632` |
| 2 | −π/10 | `api-integrations` | Current Gateway | `(138, 52)` | `(145, 59)` | `(2080, −672)` | `/models/salty-spitoon.glb` | `−1.259` + `rotYOffset −π/2` (GLB authored facing +X) |
| 3 | +π/10 | `cron-automation` | Tide Clock Grotto | `(138, 94)` | `(145, 101)` | `(2080, +672)` | `/models/downtown-building.glb` | `−1.882` |
| 4 | +3π/10 | `app-publishing` | Echo Spire | `(113, 128)` | `(120, 135)` | `(1280, +1760)` | `/models/boating-school.glb` | `−2.510` + `rotYOffset +π/2` (flipped 2026-04-16 so classroom faces center) |
| 5 | +π/2 (bottom) | `deployment-ops` | Nautilus Citadel | `(73, 141)` | `(80, 148)` | `(0, +2176)` | `/models/building-lighthouse.glb` | `3.142` |
| 6 | +7π/10 | `mcp-tool-use` | Salvage Workshop | `(33, 128)` | `(40, 135)` | `(−1280, +1760)` | `/models/patty-building.glb` | `2.510` |
| 7 | +9π/10 | `code-development` | Hydrothermal Forge | `(8, 94)` | `(15, 101)` | `(−2080, +672)` | `/models/chum-bucket.glb` | `1.882` |
| 8 | +11π/10 | `messaging-channels` | Coral Bridge | `(8, 52)` | `(15, 59)` | `(−2080, −672)` | `/models/building-shell.glb` | `1.259` |
| 9 | +13π/10 | `agent-security` | Shell Fortress | `(33, 18)` | `(40, 25)` | `(−1280, −1760)` | `/models/building-cave.glb` | `0.632` |

World coordinates: `worldX = (cx_tile × 32) − 2560`, `worldZ = (cy_tile × 32) − 2560`.
All buildings at `y = −2 + yOffset` (all `yOffset = 0`).

**All buildings uniformly 68 tiles (2176 wu) from village center.**

**Edit mode:** `/game?edit=1` enables drag-to-move for each building, with a
"Copy Positions" button that writes the `buildingZones[]` literal to the
clipboard (`arena-buildings.tsx:276-418`).

### Building ↔ Character pairings (canonical, 2026-04-16 v2)

**Governing principle: every SpongeBob character stands in front of their
canonical home.** Pairings are NOT derived from skill-domain vibe — they
follow the SpongeBob canon. Skill domains are painted onto whichever
building best fits the character's lore.

**Canonical character homes in the SpongeBob universe:**

| Character | Home | GLB asset we have | GLB needed |
|---|---|---|---|
| SpongeBob (+ Gary) | Pineapple house | `pineapple-house.glb` | ✅ have |
| Squidward | Easter Island moai head | — | ⚠️ NEED `squidward-house.glb` |
| Patrick | Rock with umbrella on top | — | ⚠️ NEED `patrick-rock.glb` |
| Mr. Krabs | Krusty Krab (the restaurant) | `patty-building.glb` | ✅ have (patty-building IS the Krusty Krab — crab-shaped restaurant) |
| Plankton (+ Karen) | Chum Bucket | `chum-bucket.glb` | ✅ have |
| Sandy | Glass treedome | — | ⚠️ NEED `sandy-treedome.glb` |
| Mrs. Puff | Boating School | `boating-school.glb` | ✅ have |
| Larry | **Lighthouse** (lighthouse keeper — lifeguard stand-in) | `building-lighthouse.glb` | ✅ have; Larry character still uses `lobster_plush.glb` stand-in |

**That's 8 ring slots claimed by canonical pairings (Larry takes the
lighthouse) + 2 slots unattended (salty-spitoon, downtown). No beach
zone — Larry lives at the lighthouse.**

Gary and Karen are **companion NPCs** at slots 0 and 7 respectively —
they stand next to the primary character rather than occupying their own
building.

### The 10 slots, finalized

| i | θ | Skill theme | Building | Primary character | Companion | Notes |
|---|---|---|---|---|---|---|
| 0 | −π/2 TOP | Data & Analytics | `pineapple-house.glb` | **SpongeBob** | Gary | Canon |
| 1 | −3π/10 | Memory & Knowledge | `squidward-house.glb` ⚠ | **Squidward** | — | NEED moai GLB; interim fallback: `bb-building.glb` |
| 2 | −π/10 | APIs & Integrations | `salty-spitoon.glb` | — (unattended) | — | No canonical character; agent chats with the building shell |
| 3 | +π/10 | Automation & Workflows | `downtown-building.glb` | — (unattended) | — | No canonical character |
| 4 | +3π/10 | Research & Analysis | `boating-school.glb` | **Mrs. Puff** | — | Canon |
| 5 | +π/2 BOTTOM | Business & Productivity | `building-lighthouse.glb` | **Larry** | — | Lighthouse keeper/watchman is close enough to lifeguard; using `lobster_plush.glb` + red tint as interim character |
| 6 | +7π/10 | Tool Use & MCP | `patty-building.glb` | **Mr. Krabs** | — | Canon — Krusty Krab is Mr. Krabs's workplace |
| 7 | +9π/10 | Code & Development | `chum-bucket.glb` | **Plankton** | Karen | Canon — both live at Chum Bucket |
| 8 | +11π/10 | Communication | `sandy-treedome.glb` ⚠ | **Sandy** | — | NEED treedome GLB; interim fallback: `building-shell.glb` |
| 9 | +13π/10 | Crypto & Web3 | `patrick-rock.glb` ⚠ | **Patrick** | — | NEED rock GLB; interim fallback: `building-cave.glb` |

### Missing assets to source (blocking full canonical fidelity)

1. **`squidward-house.glb`** — Easter Island moai head (slot 1)
2. **`patrick-rock.glb`** — rock with umbrella (slot 9)
3. **`sandy-treedome.glb`** — glass dome with oak tree inside (slot 8)
4. **`larry.glb`** — proper Larry the Lobster character (slot 5) —
   currently using `lobster_plush.glb` + red tint as a stand-in

### Interim fallbacks (ship now, swap in proper GLBs later)

| Slot | Canonical | Interim fallback |
|---|---|---|
| 1 (Squidward) | `squidward-house.glb` (moai) | `bb-building.glb` — closest stylized BB house |
| 5 (Larry) | `larry.glb` character on a `lifeguard-tower.glb` | `lobster_plush.glb` tinted red, at the `building-lighthouse.glb` |
| 8 (Sandy) | `sandy-treedome.glb` | `building-shell.glb` — dome shape |
| 9 (Patrick) | `patrick-rock.glb` | `building-cave.glb` — rocky, free after slot 8 moves |

### Current state vs target (7 of 10 slots need swaps)

| i | Current bldg | Current char | → Target bldg | Target char | Delta |
|---|---|---|---|---|---|
| 0 | pineapple-house | SpongeBob | pineapple-house | SpongeBob + Gary | + add Gary companion |
| 1 | bb-building | Squidward | squidward-house (fallback: bb-building) | Squidward | ✅ char OK, bldg needs proper moai GLB |
| 2 | salty-spitoon | Mr. Krabs ❌ | salty-spitoon | (none) | REMOVE Mr. Krabs — he's going to Krusty Krab |
| 3 | downtown-building | Gary ❌ | downtown-building | (none) | REMOVE Gary — he's going to Pineapple |
| 4 | boating-school | Mrs. Puff | boating-school | Mrs. Puff | ✅ keep |
| 5 | building-lighthouse | Larry | building-lighthouse | Larry | ✅ KEEP — Larry is the lighthouse keeper (lifeguard stand-in) |
| 6 | patty-building | Karen ❌ | patty-building (Krusty Krab) | Mr. Krabs | MOVE Mr. Krabs here |
| 7 | chum-bucket | Plankton | chum-bucket | Plankton + Karen | + add Karen companion |
| 8 | building-cave | Sandy | sandy-treedome (fallback: building-shell) | Sandy | ✅ char OK, bldg needs proper treedome GLB |
| 9 | building-submarine | Patrick | patrick-rock (fallback: building-cave) | Patrick | ✅ char OK, bldg MUST change (submarine → decoration) |

**No beach zone** — Larry stays at the lighthouse (slot 5). The beach
concept was considered and rejected because it adds a non-ring location
that breaks the uniform skill-slot model.

Location NPC mapping lives at `apps/web/src/lib/three/arena-location-npcs.tsx:55-73`.
Building GLB mapping at `apps/web/src/lib/three/arena-buildings.tsx:54-75`.

### Companion NPCs (Gary, Karen)

Gary and Karen don't have their own buildings. They stand as **companions**
next to their primary characters:
- **Gary** next to SpongeBob at slot 0 (Pineapple)
- **Karen** next to Plankton at slot 7 (Chum Bucket)

Implementation approach: extend `LOCATION_NPCS[id]` with an optional
`companion?: { name, model, color?, scaleOverride?, offsetX?, offsetZ? }`
field. When present, the component renders a second NPC at the building
position + small X/Z offset so the companion stands beside the primary
character. The companion is a passive presence (no independent chat) —
agents interacting with the building always talk to the primary character
which routes the ElizaOS chat.

### Summary — final authoritative mapping

Shipped 2026-04-16. ✅ = live in code. ⚠️ = blocked on missing GLB asset.

| Slot | Building GLB (interim) | Building GLB (target) | Primary NPC | Companion | Status |
|---|---|---|---|---|---|
| 0 | `pineapple-house.glb` | same | SpongeBob | Gary | ✅ SHIPPED |
| 1 | `bb-building.glb` | `squidward-house.glb` | Squidward | — | ✅ SHIPPED (char OK; bldg ⚠️ NEED moai GLB) |
| 2 | `salty-spitoon.glb` | same | — (unattended) | — | ✅ SHIPPED |
| 3 | `downtown-building.glb` | same | — (unattended) | — | ✅ SHIPPED |
| 4 | `boating-school.glb` | same | Mrs. Puff | — | ✅ SHIPPED |
| 5 | `building-lighthouse.glb` | same | Larry (lobster_plush red tint) | — | ✅ SHIPPED (char ⚠️ NEED larry.glb) |
| 6 | `patty-building.glb` (Krusty Krab) | same | Mr. Krabs | — | ✅ SHIPPED |
| 7 | `chum-bucket.glb` | same | Plankton | Karen | ✅ SHIPPED |
| 8 | `building-shell.glb` | `sandy-treedome.glb` | Sandy | — | ✅ SHIPPED (bldg ⚠️ NEED treedome GLB) |
| 9 | `building-cave.glb` | `patrick-rock.glb` | Patrick | — | ✅ SHIPPED (bldg ⚠️ NEED rock GLB) |

**Submarine (`building-submarine.glb`): DECORATION-ONLY.** Landmark at
`(1900, 700)` in `arena-terrain.tsx` stays; the ring usage at slot 9 is
removed (2026-04-16).

### Building label proportions

Building nameplates float above each building at world Y = `BUILDING_TARGET_HEIGHT + 20`
(= 820 world units) using drei `<Html distanceFactor={1500}>`. Raised from 400 → 1500
on 2026-04-16: `distanceFactor={400}` caused labels to shrink to ~2-3px at typical
orbit distances of 1500-2500 units in the 5120-unit world. At 1500, labels stay
readable out to ~4000 units. Reference: `arena-buildings.tsx` GLBBuilding.

---

## 3. NPC Structure & Groupings

### Lobster model as universal NPC avatar

- GLB: `/models/lobster.glb` (`arena-npcs.tsx:29`, `player-avatar.tsx:98` preload)
- Scale (wandering NPCs): **per-species normalization** via `computeNpcScale()`
  (`arena-npcs.tsx`). `TARGET_NPC_HEIGHT = 45` world units (pass 1 2026-04-16: 120→75;
  pass 2 2026-04-16: 75→45 — user tested pass 1 and NPC still felt too big relative to buildings).
  Each species GLB is measured at mount time (`bbox.max.y` of non-SkinnedMesh geometry)
  and scaled so visual height = 45 wu. ~1:17.8 ratio vs 800-wu building. Sanity clamp `[0.225, 90]`; HARD_MAX cap 95 wu.
  **`SPECIES_WANDER_SCALE_OVERRIDE`** (`arena-npcs.tsx:270`) bypasses `computeNpcScale` for species whose geometry trips the normaliser. Current values (recalibrated 2026-04-24 after SkeletonUtils.clone fix — bones now animate correctly, real skinned extent is ~4× bind-pose):
  - `hermitcrab: 4` (was 16 — Riptide appeared 5× too large after clone fix)
  - `sweet_crab: 7.6` (unchanged — bbox 56×53×67 acceptable)
  - `lobster: 22` (added — native bbox 278wu wide at computed 40.17; 22 targets ~150wu width)
- Scale (player avatar): `AVATAR_SCALE = 40` (`player-avatar.tsx:41`) for lobster/crayfish.
  lobster.glb geometry bbox max.y = 1.12 native units (verified 2026-04-17 from GLTF accessor).
  AVATAR_SCALE=40 → 40 × 1.12 = 44.8 wu ≈ TARGET_NPC_HEIGHT=45 — player avatar matches wandering NPC size.
  **Bug history:** AVATAR_SCALE was 20 after pass 2 scale-down 2026-04-16 (55→33→20). The pass 2
  comment claimed "~48 wu" based on native height ≈ 2.4 — that was the old lobster GLB.
  Current GLB native height = 1.12 → 20 × 1.12 = 22.4 wu, making the player avatar appear
  2× smaller than NPC lobsters (2× height = ~8× volume). Fixed 2026-04-17: AVATAR_SCALE 20→40.
  Other model keys use `reg.scale` from registry.
- **Native facing:** `-Z` at `rotation.y = 0` — i.e. model head points toward
  north in world space.
- **Continuous facing formula:** `atan2(-worldVx, -worldVz)` — flips the
  vector so the `-Z`-forward model aligns with the motion direction
  (`player-avatar.tsx:45-47`, `arena-npcs.tsx:36-38`, `npc-controller.tsx:170-171`).
- **Cardinal `DIR_ROTATION`** (`arena-npcs.tsx:37-39`,
  `player-avatar.tsx:53-55`):

  | direction | radians | screen meaning |
  |---|---|---|
  | `up` | `0` | head → `-Z` |
  | `down` | `π` | head → `+Z` |
  | `left` | `+π/2` | head → `+X` |
  | `right` | `-π/2` | head → `-X` |
  | `idle` | `π` | facing camera at default pose |

- **Color tinting (legacy lobster path):** clone material,
  `color.lerp(tint, 0.3)`, `emissive = tint`, `emissiveIntensity = 0.1`
  (`player-avatar.tsx:152-163`).
- **Color tinting (universal path):**
  `applyColorTint(scene, color, 0.6, 0.2)` from `character-animations.ts`
  (`player-avatar.tsx:148`, `arena-npcs.tsx:104-106`).
- **Y-position (wandering NPCs):** `terrainY + 2 + bob - pivotOffsetY` where
  `pivotOffsetY = localMinY * npcScale` (per-species scale from `computeNpcScale()`,
  computed in useMemo, not per-frame). Corrects for GLB pivot placement —
  humanoid/anime species (`chihiro`, `priestess`, `chibi_goku`) have pivots at
  waist; without this correction they render underground.
  **CRITICAL:** in the `computed > CLAMP_MAX → bind-pose fallback` branch,
  `localMinY` is forced to 0. The `localMinY` value from a tiny non-skinned
  accessory (e.g. a coin at y=-154 local space) multiplied by scale=240 gives
  pivotOffsetY=-36960 wu — NPCs appear 37000 wu above ground ("floating submarine").
- **Layer 2 hard cap:** one-shot `useFrame` at `clock.elapsedTime > 0.5s` measures
  rendered height via `Box3.setFromObject(group)`. If `renderedH > 95 wu` (HARD_MAX = 2×TARGET_NPC_HEIGHT=45),
  `group.children[0].scale.multiplyScalar(95 / renderedH)` and position reset to
  terrain surface. `_renderedBbox` allocated at module scope. `rescaleAppliedRef`
  prevents re-firing. (`arena-npcs.tsx useFrame`)
- **Y-position (player avatar):** `terrainY + 2 + bob - pivotOffsetY` where
  `pivotOffsetY = computeLocalMinY(cloned) * finalScale` (`finalScale` =
  `AVATAR_SCALE` for lobster/crayfish, `reg.scale` for all others).

### Player avatar model resolution (Phase 2)

**Source:** `apps/web/src/lib/three/player-avatar.tsx` (Phase 2, 2026-04-16)

The player avatar no longer hardcodes `/models/lobster.glb`. The GLB path and
scale are now resolved from the model registry at runtime:

1. `game/page.tsx` reads `avatar.modelKey` from `GET /api/avatars/me` (Drizzle
   pass-through of the `model_key` DB column, added in Phase 2).
2. It calls `useGameStore.getState().setPetAppearance(species, color, undefined, modelKey)`,
   which stores `modelKey` in the new `avatarModelKey` Zustand field (default: `'lobster'`).
3. `PlayerAvatarInner` reads `avatarModelKey` via `useGameStore((s) => s.avatarModelKey)`.
4. It looks up `MODEL_REGISTRY[avatarModelKey]` (from `agent-model-registry.ts`).
   If the key is absent or unknown, falls back to `MODEL_REGISTRY.lobster`.
5. `useGLTF(reg.path)` loads the resolved GLB.

**Scale:** lobster and crayfish use `AVATAR_SCALE = 40` (matches `TARGET_NPC_HEIGHT = 45` —
44.8 wu visual height). Fixed 2026-04-17: lobster GLB native height is 1.12 native units
(GLTF accessor verified); old AVATAR_SCALE=20 gave 22.4 wu, making the player avatar half the
height of wandering NPC lobsters. All other model keys use `reg.scale` from the registry.
Both paths apply a `pivotOffsetY` correction computed from `localMinY * finalScale` — see
Y-position note in the wandering NPC section above.

**Animation routing** (mirrors `arena-npcs.tsx` and `SelectAgentCanvas.tsx`):
- `lobster` or `crayfish` → `LobsterAnimator` + skeletal bone discovery
  (`lobster-parts.ts`) + procedural squash/stretch (`procedural-animation.ts`).
- All other keys → `createCharacterAnimator(key, scene)` universal animator.

**Fallback:** if `avatar.modelKey` is `null`/`undefined` (pre-Phase-2 rows or
API call before Phase 2 deploy), `setPetAppearance` defaults to `'lobster'`.

**Registry location:**
- Web side: `apps/web/src/lib/three/agent-model-registry.ts` (`MODEL_REGISTRY`, `ModelRegistryEntry`)
  — Derives from `@clawville/shared` `AGENT_MODELS`; augments each entry with `path` + `scale`.
  — `SelectAgentCanvas.tsx` imports `MODEL_REGISTRY` and `AgentCategory` from here (no local duplicate).
- Canonical keys/categories: `packages/shared/src/constants/agent-models.ts` (`AGENT_MODEL_KEYS`, `AgentCategory`)
  — `priestess` category is `'milady'` (not `'hermes'`) — aligned in agent-model-registry.ts 2026-04-16.

**Preload:** `useGLTF.preload('/models/lobster.glb')` remains at module level
as a perf win since lobster is the default and most common avatar.

**WASD input is camera-relative (fixed 2026-04-21).** Pressing W/A/S/D moves the
avatar in the camera's forward/right direction, regardless of orbit angle. This mirrors
`npc-controller.tsx` (which was always camera-relative). The old screen-relative
implementation (`vy=-1` for W, etc.) worked correctly at the default camera angle
but diverged after arrow-key rotation — pressing D after orbiting right would still
move "world-east" instead of screen-right. The screen-relative revert in an earlier
session was prompted by mobile OrbitControls touch-orbit accumulating ~180° over 10s
(see gotchas/camera-relative-movement-breaks-on-mobile-orbitcontrols.md); that
concern does NOT apply to arrow-key orbit, which is intentional and bounded. Both
GLB and VRM paths use the same camera-projection pattern (`camera.getWorldDirection()`,
flatten Y, `crossVectors(forward, worldUp)`) with the same module-scope scratch
vectors (`_playerCamForward`, `_playerCamRight`, `_playerWorldUp`).

### Location NPCs (one per building)

**Source:** `arena-location-npcs.tsx:34-48`, `npc-definitions.ts`

- Target height: `CHARACTER_HEIGHT = 55` world units
  (`arena-location-npcs.tsx:30`). Pass 1 2026-04-16: reduced 140→90. Pass 2 2026-04-16:
  reduced 90→55 — user tested pass 1, SpongeBob cast still felt too big vs buildings.
  55 wu gives ~1:14.5 ratio vs 800-wu building. Deliberately 10 wu taller than
  TARGET_NPC_HEIGHT=45 so cast reads slightly bigger than wandering NPCs.
  Each GLB is measured via `computeNormalizedScale()` — uses **`bbox.max.y`**
  (above-pivot visual height) of **non-SkinnedMesh** geometry only.
  Sanity clamp: `[CHARACTER_HEIGHT/200, CHARACTER_HEIGHT/1.0]` ≈ `[0.275, 55]`.
  HARD_MAX cap: 115 wu (2× CHARACTER_HEIGHT headroom).
  `scaleOverride` is applied **unconditionally** when set.
  Overrides: Karen (37 = 55/1.5), Larry/lobster_plush (55 = 55/1.0).
- Placement: `NPC_INSET_WORLD = 600` wu from building center toward village
  center (`arena-location-npcs.tsx`). 600 = MAX_FOOTPRINT/2 (500) + 100 wu
  margin — places NPCs in front of even the widest building. Replaces the old
  `NPC_INSET_TILES = 4.0` (128 wu) which put NPCs inside wide building footprints
  like pineapple-house (footprint up to 1000 wu).
  Example: visual-creation center (0, −2176) → NPC at (0, −1576) (600 wu toward center).
- Facing: `atan2(dx, dz)` toward village center — SpongeBob GLBs face `+Z`
  at `rotY=0` (opposite the lobster model). No `+π` flip
  (`arena-location-npcs.tsx:88-91`).
- Y-position: `terrainY + 6 + idleBob - pivotOffsetY` with bob = `sin(t*1.5 + seed) * 0.5`
  (`arena-location-npcs.tsx useFrame`).
  `pivotOffsetY = localMinY * npcScale` where `localMinY` is the bbox min.y of
  non-SkinnedMesh geometry at scale=1 (computed once in useMemo, memoized per mount).
  Grounds each GLB correctly regardless of where the artist placed the model pivot:
  - `localMinY = 0` (pivot at feet, e.g. crustaceans): `pivotOffsetY = 0`, no change
  - `localMinY < 0` (pivot above feet, e.g. anime humanoids at waist): subtracting a
    negative lifts the model so feet align with terrainY
  - `localMinY > 0` (pivot below feet, floating): lowers the model
- **CRITICAL localMinY rule:** in the `computed > CLAMP_MAX → bind-pose fallback`
  branch of `computeNormalizedScale()`, `localMinY` is forced to 0. Same
  tiny-accessory problem as wandering NPCs — tiny non-skinned prop at y=-154 ×
  scale=140 = pivotOffsetY=-21560 wu launch.
- **Layer 2 hard cap:** one-shot `useFrame` at 0.5s measures rendered height via
  `Box3.setFromObject(groupRef.current)`. If `renderedH > 115 wu` (HARD_MAX = 2×CHARACTER_HEIGHT=55), scale down
  `group.children[0]` and reset Y to terrain. `_locRenderedBbox` module-scope.
  (`arena-location-npcs.tsx useFrame`)
- Terrain Y re-raycast every 20 frames, staggered by `(frame + seed) % 20`
  (`arena-location-npcs.tsx`).
- Name label HTML position: `[0, 150, 0]` world units above the NPC feet
  (`arena-location-npcs.tsx`). Raised from `CHARACTER_HEIGHT + 10` (=65) to constant 150
  (2026-04-16) — max observed rendered height is 121wu (Mr. Krabs); 65 was sitting at face level.
- Optional per-NPC `color` tint field in `LOCATION_NPCS` type — applied via
  `applyColorTint(scene, color, 0.7, 0.25)` in the useMemo clone step
  (`arena-location-npcs.tsx`).

Canonical pairings implemented 2026-04-16. `api-integrations` and `cron-automation`
are intentionally unattended (no NPC entry in `LOCATION_NPCS`).
Gary and Karen are companion NPCs (passive, no label, no chat routing).

| Building | Primary NPC | GLB Path | Color tint | Companion | Companion GLB |
|---|---|---|---|---|---|
| `visual-creation` | SpongeBob | `/models/characters/spongebob.glb` | none | Gary (offsetX=180, rotYOffset=−π/2) | `/models/characters/gary.glb` |
| `memory-rag` | Squidward | `/models/characters/squidward.glb` | none | — | — |
| `api-integrations` | — (unattended) | — | — | — | — |
| `cron-automation` | — (unattended) | — | — | — | — |
| `app-publishing` | Mrs. Puff | `/models/characters/mrs-puff.glb` | none | — | — |
| `deployment-ops` | Larry | `/models/lobster_plush.glb` | `0xff2020` bright red | — | — |
| `mcp-tool-use` | Mr. Krabs | `/models/characters/mr-krabs.glb` | none | — | — |
| `code-development` | Plankton | `/models/characters/plankton.glb` | none, scaleOverride=25 (native body ~2.14u, not 1u) | Karen (offsetX=180) | `/models/characters/karen.glb` |
| `messaging-channels` | Sandy | `/models/characters/sandy.glb` | none | — | — |
| `agent-security` | Patrick | `/models/characters/patrick.glb` | none | — | — |

> **Larry stand-in:** `deployment-ops` uses `/models/lobster_plush.glb`
> (plush-style lobster, visually distinct from the player avatar) with a bright
> red `0xff2020` tint (Larry the Lobster is canonically red in SpongeBob).
> A TODO comment in `arena-location-npcs.tsx` tracks the need for a proper
> `larry.glb`.
>
> **Companion rendering:** `LocationNpcConfig.companion` field added to `LOCATION_NPCS`
> type. `NpcMesh` component handles one model; `LocationNpc` renders primary +
> optional companion. Companion uses same bbox-aware scale + pivot logic;
> `showLabel=false` suppresses name overlay. Seed offset `+17` staggers companion
> raycasts away from primary.

### Character proximity model (talk-to-character, branch talk-to-character, 2026-04-16)

**Old behaviour (deleted):** `nearLocation` was set when the player's pixel-space position
entered a building zone rectangle (`pixelZones` in `player-avatar.tsx` / `npc-controller.tsx`).
The zone is 14×14 tiles = 448×448 wu, so a player walking past a building would
enter "near" state hundreds of wu before reaching the character standing in front of it.

**New behaviour:** `nearLocation` / `nearCharacter` are set by a per-frame world-space
distance check against each *character's* individual position, not the building zone.

**Source of truth:** `apps/web/src/lib/three/character-positions.ts`

Key constants and exports:
- `VILLAGE_CENTER_TILE_X = 80`, `VILLAGE_CENTER_TILE_Z = 80` — imported by `arena-location-npcs.tsx` (single source of truth; duplicates removed from that file)
- `NPC_INSET_WORLD = 600` — same constant, same single source
- `CHARACTER_NAMES: Record<buildingId, characterName>` — 8-entry static map
  (SpongeBob, Squidward, Mrs. Puff, Larry, Mr. Krabs, Plankton, Sandy, Patrick)
  keyed by building id. Seeds `CHARACTER_POSITIONS`.
- `CHARACTER_POSITIONS: Record<string, CharacterPosition>` — module-scope map built once at load from `buildingZones` ∩ `CHARACTER_NAMES`; each entry: `{ buildingId, characterName, worldX, worldZ, facingRotY }`
- `TALK_RADIUS_WORLD = 260` wu — radius of the talk bubble around each character.
  260 wu ≈ 4.7× CHARACTER_HEIGHT (55 wu). Buildings are ~1367 wu apart at ring
  circumference, so no bleed-into-neighbor possible. (Source comment on the
  constant says "~1.5×" — stale; the live value is ~4.7×.)
- `findNearestCharacter(playerWorldX, playerWorldZ)` — pure primitive, zero-alloc.
  Iterates `CHARACTER_POSITIONS`, checks squared distance, returns nearest within
  `TALK_RADIUS_WORLD` or `null`.

**Position identity guarantee:** `character-positions.ts` runs the same
`computeNpcPlacement()` logic on the same constants and the same `buildingZones` entries
as `arena-location-npcs.tsx`. The characters are rendered at exactly the positions
stored in `CHARACTER_POSITIONS` — no drift.

**NPC controller / player-avatar changes:**
- `buildingZones` import and `pixelZones` constant removed from both files.
- Per-frame proximity block replaced with:
  ```ts
  const nearest = findNearestCharacter(worldX, worldZ);
  if (nearId !== store.nearLocation) store.setNearLocation(nearId);
  if (nearName !== store.nearCharacter) store.setNearCharacter(nearName);
  ```
- `store.nearCharacter` (`string | null`) is the new companion store field written by this pass.
  Set in `game.ts` alongside `nearLocation`. Cleared to `null` on `exitBuilding` and when leaving
  `explore` mode. The `enterBuilding` action accepts an optional `characterName` arg and captures
  `nearCharacter` as `currentCharacter` in the chat state.

### Wandering NPCs — canonical 18-member cast (2026-04-23)

**Sources:** `packages/shared/src/constants/npc-definitions.ts` (server-driven) and
`apps/web/src/stores/npc.ts` (demo/disconnected mode). Both sources define the same
18 NPCs. Demo mode uses the `DEMO_NPCS` constant; server-connected mode uses
`NPC_DEFINITIONS` snapshots. The two data sets are kept in sync by matching `id` fields.

Three categories — **10 building-anchored** (each NPC has a `buildingId` and patrols
its building zone), **8 free wanderers** (no `buildingId`; re-plan twice as fast).

**Ghost-label fix (2026-04-23):** drei `<Html>` is a DOM portal outside the Three.js
scene graph. Setting `group.visible=false` in the distance-LOD cull path did NOT
propagate to the DOM label div. Fix: `labelRef = useRef<HTMLDivElement>` added to both
`GLBNpcMesh` and `VRMNpcMesh`; useFrame cull block imperatively sets
`labelRef.current.style.display = 'none' / 'flex'` in sync with `group.visible`.

**NPC_CULL_DIST raised 1200→2000wu (2026-04-21 bug fix):** Maple (world ~940,940 dist≈1329wu)
and Miu (world ~-1160,440 dist≈1242wu) spawned beyond the old 1200wu threshold, so
`group.visible = false` fired on the very first frame. VRM animators never ran a single
`update()` tick — permanent T-pose result. Cull threshold raised to 2000wu (all 18 NPCs
live at startup); VRM half-rate band raised 600→800wu proportionally.

**NPC_CULL_DIST raised 2000→2500wu (2026-04-23 bug fix):** Camera sits at y≈600wu; XZ-only
distance from center to mid-world NPCs (quadrant neighbors) is 1300–1700wu. With a 2000wu
sphere the NPCs entered and exited the cull zone as the camera moved, causing the pop-in/out
("disappear if you look at them") the user observed. 2500wu covers roughly half the map
radius and aligns with the fog effective-visibility cutoff — NPCs beyond 2500wu are invisible
inside the fog regardless, so extending to 2500 adds render work only for NPCs that would
be visible anyway. VRM half-rate band raised 800→1000wu proportionally.
`NPC_CULL_DIST_SQ = 2500*2500 = 6_250_000`, `VRM_NPC_HALF_RATE_DIST_SQ = 1000*1000`.

**React memo label display-leak fix (2026-04-23):** `memo()` shallow-compares the `npc`
prop by reference. `useNpcStore` `updateFromSnapshot` rebuilds the NPC array each SSE tick
— every component re-renders — re-applying the JSX inline `display: 'flex'`, clobbering
the cull-frame `display: 'none'`. The transition-only guard (`if (group.visible) {...}`)
then skipped re-writing because `group.visible` was already false, leaving the label
permanently visible at distance. Fixes: (1) JSX default changed to `display: 'none'` in
both `GLBNpcMesh` and `VRMNpcMesh` labels — useFrame is the single source of truth for
visibility. (2) Both cull branches (hide + show) now always write the style with a
change-check (`if (label.style.display !== x) label.style.display = x`) instead of
transition-only — prevents any future re-render from re-leaking.

**Frustum-cull fix (2026-04-21 + 2026-04-23):** VRM + GLB SkinnedMesh nodes have bounding
spheres computed from bind pose (T-pose). When the camera is close or angled, the
animated geometry extends outside the bind-pose sphere and Three.js culls the mesh
("disappears at close range"). Fix: `frustumCulled = false` set on every node via
`scene.traverse(o => { o.frustumCulled = false; })` immediately after every rigged-GLB
clone. **This fix MUST be applied at EVERY clone site, not just the first one discovered.**
Sites patched as of 2026-04-23:
- `vrm-loader.ts` — all VRMs (after `rotateVRM0`)
- `arena-npcs.tsx` — wandering GLB NPCs (`GLBNpcMesh` useMemo)
- `arena-location-npcs.tsx` — building residents (SpongeBob/Patrick/Squidward/Sandy etc.)
- `player-avatar.tsx` — player's avatar GLB clone
- `quest-npc.tsx` — quest NPC crayfish clone
- `town-guide.tsx` — town guide (SkeletonUtils.clone, after all traversals)
- `auction-podium.tsx` — floating jellyfish above the auction podium

Rule: any future `scene.clone(true)` or `SkeletonUtils.clone()` on a rigged GLB
MUST include `c.traverse(o => { o.frustumCulled = false; })` immediately after.

> `arena-npcs.tsx` uses `SkeletonUtils.clone` (not `scene.clone(true)`) — shared-skeleton bug otherwise silently invisibled all 13 GLB NPCs (Driftwood/Marlin/Riptide + 10 building-canvas crustaceans) while keeping their scene-graph state valid. Fixed 2026-04-24.

#### Building-anchored NPCs (10)

| ID | Name | Species (GLB) | Building | Color |
|---|---|---|---|---|
| `cron-automation` | Pebbles | `hermitcrab` | cron-automation | `0x795548` brown |
| `api-integrations` | Crusty | `sweet_crab` | api-integrations | `0xff6600` orange |
| `memory-rag` | Inky | `octopus` | memory-rag | `0x4caf50` teal-green |
| `code-development` | Speck | `hermitcrab` | code-development | `0xf44336` red |
| `messaging-channels` | Hazel | `lobster` | messaging-channels | `0x2196f3` blue |
| `mcp-tool-use` | Whisk | `sweet_crab` | mcp-tool-use | `0x9c27b0` purple |
| `visual-creation` | Bubbles | `jellyfish` | visual-creation | `0xe91e63` pink |
| `app-publishing` | Tide | `seahorse` | app-publishing | `0x607d8b` blue-grey |
| `agent-security` | Boulder | `crayfish` | agent-security | `0x00bcd4` cyan |
| `deployment-ops` | Coral | `lobster` | deployment-ops | `0xff2020` red |

#### Free wanderers (8)

| ID | Name | Species / type | Home position | Color |
|---|---|---|---|---|
| `milady-miu` | Miu | `milady_official_7` (VRM) | `(1400, 3000)` SW arc | n/a MToon |
| `milady-kyoko` | Kyoko | `milady_official_8` (VRM) | `(3700, 2000)` NE arc | n/a MToon |
| `milady-vivi` | Vivi | `milady_official_2` (VRM) | `(1600, 1500)` NW | n/a MToon |
| `milady-maple` | Maple | `milady_official_3` (VRM) | `(3500, 3500)` SE | n/a MToon |
| `milady-ash` | Ash | `milady_official_4` (VRM) | `(2700, 1500)` N | n/a MToon |
| `wanderer-driftwood` | Driftwood | `lobster` (GLB) | `(1500, 2400)` W | `0x8d6e63` |
| `wanderer-marlin` | Marlin | `sweet_crab` (GLB) | `(3700, 2700)` E | `0x00acc1` |
| `wanderer-riptide` | Riptide | `hermitcrab` (GLB) | `(2600, 3500)` S | `0xa1887f` |

**VRM cache constraint (REPEALED 2026-04-28, redesigned):** The previous one-VRM-per-path
constraint is gone. `useVRMInstance(path, instanceId)` returns a fully disjoint VRM per
(path, instanceId) — own scene, skeleton, humanoid, expressionManager, springBoneManager,
no shared mutable state. Bytes cache (`VRM_BYTES`) is shared by path; only the network
fetch is dedupped. Consumers MUST pass a stable instanceId and call `disposeVRMInstance`
on unmount via useEffect cleanup. Stable IDs in use: `npc.id` (arena-npcs VRMNpcMesh),
`'player-avatar'` (player-avatar PlayerPetVRMInner), `'picker'` (SelectAgentCanvas).
NOTE: a 2026-04-27 attempt at this fix used `useId()` for cache keying — that
approach broke Suspense resolution and was reverted. The current shipped fix uses
explicit caller-supplied instanceIds. See `apps/web/src/lib/three/vrm-loader.ts`
header doc + `scripts/test-vrm-loader.ts` for the 18-assertion logic test.

Server-driven NPC definitions use building-center `homeX/homeY` (computed from
`BUILDING_TILE_ZONES`), with `patrolRadius` of 380–700.

### Player NPC (NPC mode)

**Source:** `apps/web/src/stores/npc.ts:111, 466-486`

- Well-known ID: `PLAYER_NPC_ID = '__player-npc__'`
- Spawn: `spawnPlayerNpc()` inserts at game-space `(2560, 2560)` — world
  center (tile 80, 80 → world `0, 0`).
- `name: 'You'`, **`species: 'milady_official_1'`** (flipped from `'lobster'`
  on 2026-04-25 so the unconnected NPC-mode player matches the world's
  signature avatar), `color: 0x42a5f5` (blue tint), `hp: 100/100`,
  `facingAngle: null`.
- Controlled by `NpcController` when `controlMode === 'npc'`
  (`npc-controller.tsx:72-188`).
- **Render path:** `ArenaNpcs` routes by registry `avatar_type`. With a
  Milady species, the player NPC routes through `VRMNpcMesh` instead of
  `GLBNpcMesh`. The jumpState/airborne/jumpY/bob block from `GLBNpcMesh` is
  ported into `VRMNpcMesh` (~arena-npcs.tsx:932-952) so SPACE-jump still
  works on the VRM player — drops the GLB-only `+ 2` baseline and
  `- pivotOffsetY` because VRM feet are at Y=0 per spec (matches
  `player-avatar.tsx`'s VRM branch).
- **Render gate:** `ArenaNpcs` filters out `PLAYER_NPC_ID` whenever
  `controlMode !== 'npc'`. In agent modes (`'player'` / `'autonomous'`) the
  player NPC must not render — it would otherwise sit at world center
  `(0, 0)` obscuring the bazaar / town-center buildings.
- **Snapshot preservation gate:** `updateFromSnapshot` in `npc.ts` only
  re-injects `PLAYER_NPC_ID` back into the NPC list when
  `controlMode === 'npc'`. Previously it re-injected unconditionally, keeping
  the ghost NPC alive in agent mode even after `removePlayerNpc()` was called.

### NPC animation systems

- **Lobster / crayfish:** `LobsterAnimator` + skeletal bone discovery
  (`lobster-animations.ts`, `lobster-parts.ts`), plus procedural
  squash/stretch (`procedural-animation.ts`).
- **All other species:** `createCharacterAnimator(key, scene)` universal
  animator (`character-animations.ts`). Switch at
  `arena-npcs.tsx:102` (`useNewSystem = key !== 'lobster' && key !== 'crayfish'`).
- Raycast for terrain Y: every 3rd frame, staggered `(frame + seed) % 3`
  (`arena-npcs.tsx:164-168`).
- XZ lerp: `LERP_SPEED = 5` → `exp(-5*dt)` (`arena-npcs.tsx:26, 153-154`).
- Bob: `sin(t * 4.0 + seed) * 0.6` when moving (`arena-npcs.tsx:172`).
- Movement speed (player avatar + NPC controller): `SPEED = 550` px/sec (pass 1 2026-04-16:
  200→320; pass 2 2026-04-16: 320→550 — user tested pass 1 and +60% wasn't perceivable
  at world scale. Target ~3-4s to cross 2000-wu visible area → 2000/550≈3.6s —
  `player-avatar.tsx`, `npc-controller.tsx`).

### Jump System (2026-04-21, charge-and-release rewrite)

Player-controlled avatars — both the user's avatar in `controlMode='player'` AND the
possessed player-NPC in `controlMode='npc'` — can jump by pressing SPACE.
`explore` (no avatar) and `autonomous` (engine-driven) modes ignore the jump
input entirely.

**Architecture: module-scoped state + dedicated `<JumpTicker />` component.**

Jump state lives in `apps/web/src/lib/three/jump-state.ts` as a plain module-
scoped object. Zustand is deliberately avoided — per-frame `set()` at 60 Hz
would re-render every subscribed component (HUD, minimap, modals). Pattern
mirrors the existing `keyState` object at `player-avatar.tsx:74-78`.

The **physics tick runs inside a dedicated `<JumpTicker />` component** mounted
**before** any consumer in `World3DCanvas.tsx` (before `FPSFollowCamera`,
`ArenaNpcs`, `NpcController`, `PlayerAvatar`). This matters because R3F runs
`useFrame` hooks in mount order — if the tick ran inside `PlayerAvatar` or
`NpcController`, the camera and NPC render would read stale `heightOffset`
from the previous frame. Hoisting the tick to the top of the render tree
guarantees every consumer reads the current-frame jumpState.

The **SPACE keyboard listener lives inside `jump-state.ts`**, co-located with
the state it writes. Player-avatar's and NpcController's existing WASD listeners
are untouched — they keep their own `keyState` objects.

Zustand actions (`setControlMode`, `setHasAgent`, `setAgentConnection`,
`resetStore`, `enterBuilding`) still `require('@/lib/three/jump-state').resetJump()`.

**Module shape (`jump-state.ts`):**

```ts
export type JumpPhase = 'grounded' | 'charging' | 'quick' | 'launch' | 'sinking' | 'quicksink';
export const jumpState = {
  phase:           'grounded' as JumpPhase,
  vz:              0,          // wu/sec, positive = up
  heightOffset:    0,          // wu above the ground-plane sampling point (>= 0)
  playerAltitude:  0,          // persistent swim altitude (wu, >= 0). Accumulated by input
                               // controllers from camera-forward Y component. Separate from
                               // heightOffset (jump arc) — both stack at render time.
                               // Reset to 0 by resetJump().
  holdMs:          0,          // time SPACE has been continuously held this press
  chargeProgress:  0,          // 0..1 — charge-bar.tsx reads this
  lastSpaceDown:   false,      // rising-edge detector
  spaceDown:       false,      // keydown/keyup listener writes this
};
export const JUMP_QUICKSINK_VZ = -600;  // wu/s — constant descent velocity during quicksink
export function attachJumpListeners(): void;
export function updateJump(rawDt: number): void;
export function resetJump(): void;
```

**JumpTicker component (`apps/web/src/lib/three/jump-ticker.tsx`):**

```tsx
export default function JumpTicker() {
  useEffect(() => { attachJumpListeners() }, []);
  useFrame((_, delta) => {
    const { controlMode, movementFrozen } = useGameStore.getState();
    if (movementFrozen) return;
    if (controlMode === 'player' || controlMode === 'npc') updateJump(delta);
  });
  return null;
}
```

**Phase machine:**

| From | Event | To | Notes |
|---|---|---|---|
| `grounded` | SPACE rising edge | `charging` | Avatar stays on ground, vz=0, charge bar starts filling |
| `charging` | SPACE released before `JUMP_TAP_THRESHOLD_MS` (200ms) | `quick` | `vz := JUMP_QUICK_VZ0` (120 wu/s) — tap jump |
| `charging` | SPACE released at or after 200ms | `launch` | `vz = sqrt(vzMinSq + (vzMaxSq - vzMinSq) * t)` where `t = (holdMs-200)/1300`. vz² is interpolated linearly so peak altitude scales linearly with charge — plain vz-linear gives a quadratic peak curve that feels flat at low charge. |
| `charging` | `holdMs >= JUMP_MAX_HOLD_MS` (1500ms) while still held | `launch` | Auto-launch at max charge; vz = 700 wu/s |
| `quick` | `vz <= 0` naturally via QUICK_GRAVITY | `sinking` | Smooth apex with no freeze |
| `launch` | `vz <= 0` naturally via ASCENT_GRAVITY | `sinking` | Smooth apex — gravity takes over, no apex freeze |
| `sinking` | `heightOffset <= 0` | `grounded` | Natural landing |
| `quick` \| `launch` \| `sinking` | SPACE rising edge mid-air | `quicksink` | Fast controlled descent at constant `JUMP_QUICKSINK_VZ = -600` wu/s |
| `quicksink` | `heightOffset <= 0` | `grounded` | Landing — same integration block as other airborne phases |
| any | `movementFrozen === true` via `enterBuilding()` | `grounded` | Synchronous reset |
| any | `setControlMode() / setHasAgent() / setAgentConnection() / resetStore()` | `grounded` | Hard reset on all four controlMode mutation paths |

**Mid-air re-press:** SPACE while `quick`, `launch`, or `sinking` fires `quicksink` (controlled descent). SPACE during `quicksink` is a no-op (already descending). SPACE during `charging` or `grounded` enters/continues charging as normal.

**Per-frame physics (inside `updateJump(rawDt)`):**

```
dt = Math.min(rawDt, 0.1)
spaceDown = jumpState.spaceDown
risingEdge = spaceDown && !lastSpaceDown
lastSpaceDown = spaceDown
if (spaceDown) holdMs += dt*1000   // accumulate while held; reset on new press, NOT on release
                                   // (zeroing on release caused release-classifier race — see below)
chargeProgress = phase === 'charging' ? min(1, holdMs / 1500) : 0

// Mid-air quick-sink check runs BEFORE the switch — takes priority this frame.
if (risingEdge && (phase === 'quick' || phase === 'launch' || phase === 'sinking')) {
  phase = 'quicksink'; vz = JUMP_QUICKSINK_VZ  // -600 wu/s constant
}

switch (phase) {
  case 'grounded':
    if (risingEdge) { phase='charging'; vz=0; holdMs=0 }   // reset here, not on release
    break
  case 'charging':
    if (!spaceDown) {
      if (holdMs < 200) { phase='quick'; vz=120 }
      else {
        t = min(1, (holdMs-200)/1300)
        // vz² interpolated linearly → peak altitude linear in charge progress
        vzMinSq = 100*100; vzMaxSq = 700*700
        phase='launch'; vz=sqrt(vzMinSq + (vzMaxSq-vzMinSq)*t)
      }
    } else if (holdMs >= 1500) { phase='launch'; vz=700 }
    break
  case 'quick':
    vz += -220 * dt
    break
  case 'launch':
    vz += -160 * dt
    if (vz <= 0) { phase='sinking' }  // smooth apex, vz NOT zeroed
    break
  case 'sinking':
    vz += -45 * dt
    vz = max(vz, -150)
    break
  case 'quicksink':
    vz = JUMP_QUICKSINK_VZ   // constant -600 wu/s, no gravity accumulation
    break
}

if (phase !== 'grounded' && phase !== 'charging') {
  heightOffset = max(0, heightOffset + vz * dt)
  if (heightOffset === 0 && vz <= 0) { phase='grounded'; vz=0 }
}
// playerAltitude is accumulated separately by input controllers, not here.
```

**Release-classifier race (fixed 2026-04-21).** The original code had:
`holdMs = spaceDown ? holdMs + dt*1000 : 0`. On the frame SPACE goes `true→false`,
`spaceDown` is already `false` — so `holdMs` was zeroed to 0 in that same frame.
The `case 'charging'` block then read `holdMs=0`, which is always `< JUMP_TAP_THRESHOLD_MS`,
making the quick-tap branch fire unconditionally. The scaled-launch branch was
**never reachable** except via the auto-launch path at `holdMs >= 1500ms`. Result:
users saw identical jump height regardless of charge bar fill. Fix: accumulate
`holdMs` only while held (`if (spaceDown) holdMs += dt*1000`), and reset it when
entering `charging` on the new press (`case 'grounded': if (risingEdge) { holdMs=0; ... }`).

**Constants (defined in `jump-state.ts`):**

| Constant | Value | Meaning | Derived behaviour |
|---|---|---|---|
| `JUMP_TAP_THRESHOLD_MS` | `200` ms | Tap-vs-charge cutoff | |
| `JUMP_QUICK_VZ0` | `+120` wu/s | Initial velocity for tap jump | Peak ≈ `120²/(2·220) ≈ 33 wu`. Airtime ≈ `2·120/220 ≈ 1.1 s`. |
| `JUMP_QUICK_GRAVITY` | `-220` wu/s² | Gravity during tap jump | |
| `JUMP_MAX_HOLD_MS` | `1500` ms | Full charge duration; auto-launches at this point | |
| `JUMP_MIN_CHARGED_VZ` | `+100` wu/s | Launch velocity at minimal charge (200ms) | Peak ≈ `100²/(2·160) ≈ 31 wu` — matches tap peak (~33 wu), eliminating the 6× step at the 200ms boundary |
| `JUMP_MAX_CHARGED_VZ` | `+700` wu/s | Launch velocity at full charge (1500ms) | Peak ≈ `700²/(2·160) ≈ 1531 wu` (~1.9× building height). **No clamp.** |
| `JUMP_ASCENT_GRAVITY` | `-160` wu/s² | Gravity during charged launch ascent | Lighter than tap gravity so peak altitude is achievable |
| `JUMP_SINK_GRAVITY` | `-45` wu/s² | Gravity during underwater float-down | Gentle sink |
| `JUMP_SINK_TERMINAL` | `-150` wu/s | Terminal sink speed (clamped) | From ~1531 wu max peak: accel 0→-150 in 3.3s; remaining distance at -150 ≈ 8.7 s. Total descent from max peak ≈ **12 s**. |
| `JUMP_QUICKSINK_VZ` | `-600` wu/s | Constant descent velocity during quicksink | From 1500wu peak → ~2.5s landing. No gravity ramp — straight-line drop. Horizontal WASD still works during descent. |

**Charge interpolation — vz² linear (as of 2026-04-21).** vz is computed via
square-root of a linearly interpolated vz², so that peak altitude = vz²/(2|g|)
scales linearly with charge progress. Plain vz-linear lerp made peak quadratic:
t=0.5 gave only 46% of max peak (≈706 wu), which felt flat at low-to-mid bar.

Peak-vs-charge table (JUMP_ASCENT_GRAVITY = -160 wu/s²):

| Bar fill | vz (wu/s) | Peak altitude (wu) |
|---|---|---|
| 0% (just past 200ms) | 100 | ≈ 31 |
| 25% | ≈ 360 | ≈ 405 |
| 50% | ≈ 500 | ≈ 781 |
| 75% | ≈ 608 | ≈ 1156 |
| 100% (1500ms) | 700 | ≈ 1531 |

Midpoint ≈ 781 wu = (31 + 1531) / 2. Linear in height. Min endpoint lowered 195→31 wu to match tap peak. Max endpoint unchanged.

**No apex-freeze on charged jumps.** When `launch → sinking` fires (vz naturally
crosses 0 under ASCENT_GRAVITY), we preserve the existing vz (near 0) and let
SINK_GRAVITY take over. This gives a smooth continuous arc rather than a hard
freeze-and-drop. Quick-jump (`quick` phase) follows the same pattern — no
freeze there either.

**Charge bar UI.** A new `apps/web/src/components/game/charge-bar.tsx` component
reads `jumpState.chargeProgress` via a `requestAnimationFrame` loop (no React
state, no re-renders) and mutates DOM style directly. Renders as a 240px
horizontal bar centered above the avatar-chat-bar (`bottom: 7.5rem`). Color
shifts: cyan → bright-cyan-white → yellow-white as charge nears 100%. Bar
fades in (opacity transition 80ms) when `phase === 'charging'` and fades out
immediately on launch or cancel. Mounted inside the `hasPet &&` gate in
`apps/web/src/app/game/page.tsx` alongside `<AvatarChatBar />`, gated on
`controlMode !== 'explore'`.

**Idle rotation freeze.** `player-avatar.tsx` no longer snaps the avatar's facing
to `DIR_ROTATION['idle'] = 0` (+Z) when movement stops. The rotation lerp is
now only applied when `continuousRot !== null` (i.e. when there is actual
movement input). On release, `rotRef.current` stays unchanged — the avatar
freezes at the last moved direction. Same logic applied consistently in both
`player-avatar.tsx` and the `charging` bobbing guard (which treats `charging` as
on-ground for bob purposes, same as `grounded`).

**Swim altitude (explicit arrow-key 3D movement).** WASD is ALWAYS flat camera-relative XZ — `camForward.y` is zeroed immediately before normalization with no prior capture. Mouse orbit and incidental camera pitch never contribute to altitude.

Vertical swim is driven exclusively by **Arrow Up** (`+1`) and **Arrow Down** (`-1`), gated on the avatar being airborne. The same arrow keys continue to rotate the camera via `ArrowKeyRotationController` — both effects fire simultaneously.

```ts
_playerCamForward.y = 0; // WASD always flat — no camForwardY capture
// ... project inputFwd/inputRight onto XZ plane as usual ...

// Arrow up/down: explicit vertical swim, airborne only
const airborne = jumpState.phase !== 'grounded' || jumpState.playerAltitude > 0;
if (airborne) {
  let verticalInput = 0;
  if (keyState.arrowup)   verticalInput += 1;
  if (keyState.arrowdown) verticalInput -= 1;
  if (verticalInput !== 0) {
    jumpState.playerAltitude = Math.max(0, jumpState.playerAltitude + verticalInput * SPEED * delta);
  }
}
```

Vertical input is gated on airborne state (`phase !== 'grounded' || playerAltitude > 0`).
Grounded avatars: arrow keys have no vertical effect. Mid-air with no arrow press: avatar holds
altitude (no gravity, no drift). Mid-air + arrow up: climb. Mid-air + arrow down: descend.
Combines freely with WASD for diagonal 3D movement.

`playerAltitude` is **persistent** — the avatar holds altitude when input stops (no gravity).
Floor-clamped at 0 (can't swim into the ocean floor). Strafe (A/D) does not contribute
because `camRight.y ≈ 0` (cross product of any forward vector with world-up has y=0).

At render time, `playerAltitude` stacks additively on top of `heightOffset`:
```ts
group.position.y = terrainY + 2 + bob + jumpState.heightOffset + jumpState.playerAltitude - pivotOffsetY;
```

**Mid-air quick-sink.** Pressing SPACE while in any airborne phase (`quick`, `launch`, `sinking`)
immediately transitions to `quicksink` — constant downward velocity at `JUMP_QUICKSINK_VZ = -600` wu/s.
No gravity ramp. Horizontal WASD control is preserved during descent. Landing fires when
`heightOffset <= 0 && vz <= 0` (same integration logic as other airborne phases).
`playerAltitude` is NOT reset during quicksink — the user descends via `heightOffset` only,
so any camera-tilt altitude accumulated before the sink remains and the avatar lands at that altitude
above the floor (or the floor if `playerAltitude` is also 0).

**`airborne` definition in consumers.** Both `player-avatar.tsx` and `arena-npcs.tsx`
treat `charging` as non-airborne (avatar is on the ground). `playerAltitude > 0` also
counts as airborne (avatar is swimming above the floor):
```ts
const airborne = (jumpState.phase !== 'grounded' && jumpState.phase !== 'charging')
              || jumpState.playerAltitude > 0;
```

**Horizontal control during airborne phases:** unchanged. XY input (WASD /
joystick / clickPath) keeps driving `avatarPosition` via the existing `SPEED`
integration.

**Follow camera tracks jump height.** `FPSFollowCamera` in `World3DCanvas.tsx`
reads `jumpState.heightOffset` each frame and raises its orbit target by the
same amount. The camera position is also translated by the same delta each
frame so the orbit geometry (angle, zoom distance, phi/theta) is preserved:
```ts
const extraY = jumpState.heightOffset
const prevTgtX = tgt.x; const prevTgtY = tgt.y; const prevTgtZ = tgt.z;
tgt.x += (worldX - tgt.x) * 0.1;
tgt.y += ((CHAR_TARGET_Y + extraY) - tgt.y) * 0.1;
tgt.z += (worldZ - tgt.z) * 0.1;
controls.object.position.x += (tgt.x - prevTgtX);
controls.object.position.y += (tgt.y - prevTgtY);
controls.object.position.z += (tgt.z - prevTgtZ);
```
Without the camera-position translation, a high jump (target.y → 1500+) leaves
the camera at ground level, forcing PHI near its `PHI_MIN = 0.1` clamp, which
causes arrow-key rotation to glitch at near-vertical angles. The `_followOffset`
scratch vector that previously computed (but never applied) this delta has been
removed. `heightOffset` is forced to 0 by `resetJump()` on any mode transition,
so the read is safe in autonomous mode.

**Performance:** zero added draw calls, no new materials, no new geometry, no
additional GC pressure. Charge bar uses direct DOM mutation (zero React overhead).
Safe for Intel Iris Xe.

**Out of scope for this slice (follow-ups):**

1. **Mobile jump button.** Long-press + charge-bar UX on mobile.
2. **Jump-aware animation pose.** Dedicated "tail-kick" + "drifting sink" pose set.
3. **Autonomous-mode jumps.** Autonomy engine traversal jumps.
4. **Bubble particle trail.** Piggybacks on `particle-system.tsx`.

---

## 4. Town Center Objects

All near world-origin `(0, 0, 0)`. Ground Y = `-2` for all.

| Object | Position (x, y, z) | Primitives | Action | Source |
|---|---|---|---|---|
| Quest NPC (crayfish + gold marker) | `(-110, -2, -60)` | Crayfish GLB normalized to **80wu** (raised from 61wu — 2026-04-24); gold octahedron `r=3.2` at `y=42`, pulsing via `sin(time*2.5)`, bobs `y ± 1.5` | `openQuestBoard()` | `quest-npc.tsx:38-40, 53-83, 89-163` |
| **Town Guide NPC** | `(0, -2, +240)` | GLB + useGLTF pipeline (2026-04-23, frozen-pose idle). Asset: `/models/guide-rigged.glb`. Loaded via `useGLTF` + `SkeletonUtils.clone`; `GUIDE_SCALE=200`; `GROUND_Y=-2`. `AnimationMixer` on cloned root. **Idle:** `CLIP_IDLE='pose-hand-on-hips'` plays `LoopOnce` with `timeScale=0`, `clampWhenFinished=true`, `weight=1.0` — mixer evaluates frame-0 exactly once and never advances, holding the pose forever. Reverted from 9-clip cycle (commit 8281162) because 1-frame POSE clips fired LoopOnce 'finished' instantly and the crossfade interpolated between two time=0 (T-pose neutral) samples, producing visible T-pose reversion each slot change. **Wave:** Click → crossfade idle→wave (`WAVE_FADE=0.35s`, `LoopOnce`, `clampWhenFinished=false`); wave 'finished' → crossfade back to frozen idle. Click idempotency: `chatOpen\|guideChatOpen` guard in `useGameStore`. Procedural breathing: `mixamorigSpine2` (scoped to `MainArmature` via `getObjectByName`; lookup checks both sanitized `mixamorigSpine2` and raw `mixamorig:Spine2` because GLTFLoader strips colons from bone names) `scale.y = 1 + sin(t*1.8)*0.008`. `frustumCulled=false` narrowed to `isMesh`. Unmount: `stopAllAction + uncacheRoot` only (geometry/material reused from useGLTF cache — never dispose). No drei Text/Billboard. No per-frame allocations. | `store.openGuideChat()` | `town-guide.tsx` |
| **Bazaar (Fish Stall)** | `(-600, -2, -60)` — west | GLB: `/models/bazaar-fish-stall.glb` (hand-painted fish market stall by duckcracker02, CC-BY). Scale-normalized to ~400wu max dim via `computeScale()`. `scene.clone(true)`, `matrixAutoUpdate=false` after mount. No per-frame animation. | `openBazaar()` | `bazaar-stall.tsx` |
| **Marketplace (Food Stall)** | `(600, +4, -60)` — east (mirror of bazaar) | GLB: `/models/marketplace-food-stall.glb` (medieval food stall by SpatialNeglect, CC-BY). Scale-normalized to ~450wu max dim. **Y=+4** (raised from +2, 2026-04-24): GLB pivot is not at the very bottom of its geometry; wooden frame/stand extends below the root origin. Sitting 6wu above sand hides the clip. `scene.clone(true)`, `matrixAutoUpdate=false` after mount. No per-frame animation. | `openMarketplace()` | `marketplace-stall.tsx` |
| **Bounty Board** | REMOVED from scene (2026-04-24) — `<BountyBoardObject />` JSX line deleted from `World3DCanvas.tsx`. Modal still accessible via sidebar. Import kept in `World3DCanvas.tsx`. | `openBountyBoard()` | `bounty-board-object.tsx` |
| **Auction (Glass Dome)** | `(0, +12, -500)` — north of stall row | GLB: `/models/auction-dome.glb` (Space Dome Showcase by dylanheyes, CC-BY). Scale-normalized to ~380wu max dim. **Y=+12** (raised from +6, 2026-04-24): the GLB pivot is NOT at the bottom — Dome_Rim_0/Dome_Metal_0 sub-meshes extend below the root origin into negative local Y. Y=+12 clears any remaining base clip. Z=-500 pushed further north for visual depth. Nested `<FloatingJellyfish>`: `/models/jellyfish.glb` scale-normalized to ~130wu, floats at Y+228wu (60% of dome height, relative to dome group) inside dome, Y-axis spin `t * 0.8` rad/s. `matrixAutoUpdate=false` on dome. Single `useFrame` spins jellyfish ref only. | `openAuction()` | `auction-podium.tsx` |
| **Town Directory Sign** | `(0, -2, -120)` — further north of stall row | Procedural (no GLB). Two `BoxGeometry` posts `8×280×8wu` at x=±110; horizontal plank `258×160×6wu` at y=post-top. `MeshBasicNodeMaterial` (TSL `color('#7c4a1b')`). Text via drei `<Html transform>` DOM portal at plank face: "TOWN CENTER" bold **40px** header + "Auction / Bazaar / Marketplace" **28px** lines; `font-family:serif; color:#2a1800`. No click handler — informational only. All geo/mat module-scope (no per-frame alloc). `matrixAutoUpdate={false}` on each mesh. | none | `town-directory-sign.tsx` |

### Town-center layout (as of 2026-04-24)

```
Auction (glass dome)        (0, +12, -500) ← far north; Y=+12 clears buried GLB sub-meshes; opens Auction House modal
Town Directory Sign         (0,  -2, -120) ← centre, north of stall row (doubled size); informational only
Bazaar (fish stall)      (-600,  -2,  -60) ← west; opens Bazaar modal
Quest NPC                (-110,  -2,  -60) ← west flank; 80wu scale; opens Quest Board modal
Marketplace (food stall)  (600,  +4,  -60) ← east (mirror of bazaar); Y=+4 clears sand clip; opens Marketplace modal
[Bounty Board REMOVED from scene — modal still accessible via sidebar]
Town Guide                  (0,  -2, +240) ← south of dome (clear camera space)
```

Avatar spawn offset: store `(2560, 2940)` = world `(0, 0, +380)` — 140 wu south of
the Guide (at z=+240) so the player has clear camera space looking north at the
guide with the Auction Podium visible as a landmark ~520wu behind her (dome at Z=-280).

Each object is a `<group>` with `onClick`, `onPointerEnter`, and
`onPointerLeave` handlers; cursor switches to `pointer` on hover.

### Click-to-move (`click-to-move.tsx`)

- Only active when `mode === 'game'` AND `controlMode ∈ {player, autonomous}`
  (`World3DCanvas.tsx:602`).
- Invisible `(MAP_WIDTH+200) × (MAP_HEIGHT+200)` plane at `y = 0.01`
  captures clicks (`click-to-move.tsx:118`).
- Uses A* via `findPath()` from `client-pathfinding.ts`.
- Path visualization: `InstancedMesh` of `CircleGeometry r=1.8 segs=8`, cap
  `MAX_DOTS = 60`, cyan `0x00e5ff` @ opacity 0.6 (`:28-29, 127-193`).
- Destination marker: ring `r=0.8..1.0`, pulse scale `2.5..4.5` at
  `DEST_PULSE_SPEED = 4` (`:25-27, 199-237`).

---

## 5. Terrain

**Source:** `apps/web/src/lib/three/arena-terrain.tsx`

### Sand floor

| Property | Value | Source |
|---|---|---|
| Plane size | `MAP_WIDTH * 3 × MAP_HEIGHT * 3` = `15360 × 15360` | `:46-47` |
| Segments | `120 × 120` (~14 400 quads) | `:48-49` |
| Position | `(0, -2, 0)` | `:202` |
| Rotation | `[-π/2, 0, 0]` (horizontal) | `:201` |
| Layer | `TERRAIN_LAYER = 1` (for raycasting) | `:17, 187` |

### Procedural dunes (baked into vertex positions)

Multi-octave sin/cos + jitter, deterministic via `seededRandom(42)`
(`:36-42`). Height range roughly `-28 .. +28` (`:63-71`):

```
dune1 = sin(x*0.004) * cos(y*0.006) * 14
dune2 = sin(x*0.01 ) * sin(y*0.013) * 8
dune3 = sin(x*0.025) * cos(y*0.03 ) * 4
ripple  = sin(x*0.08 + y*0.06) * 2
ripple2 = sin(x*0.12 - y*0.09) * 1
noise   = (rng() - 0.5) * 1.5
```

### Vertex colors (graphic palette)

| Color | Hex | Role |
|---|---|---|
| `SAND_RIDGE` | `0xfff0d4` | peaks (near-white) |
| `SAND_HIGH` | `0xe8d0a8` | warm sand |
| `SAND_MID` | `0xc4a878` | golden mid-tone |
| `SAND_VALLEY` | `0x8a7050` | dark moody valleys |
| `SAND_DEEP` | `0x5c4a32` | deep brown-black troughs |

Lerped by normalized height `t = (h + 28) / 56` across 5 bands
(`:77-87`). 10 % dark-patch jitter + 5 % bright-spot jitter (`:90-96`).

### TSL material (`createSandMaterial()` — `:111-179`)

- `MeshStandardNodeMaterial` with `vertexColors: true`, `metalness: 0`.
- `colorNode`: `vertexColor` mixed 28 % with a height-driven warm/cool tint,
  multiplied by sand-ripple pattern + fine grain hash.
- `roughnessNode`: `mix(0.55, 0.92, heightT)` — valleys smoother, ridges
  rougher (`:166`).
- `normalNode`: `vec3(bumpX, bumpY, 1)` perturbation (`:170-176`).
- Sand ripples: two overlapping sin waves at different frequencies
  (`:123-128`).

> **Note:** the GLB `bikini-bottom.glb` was intentionally removed — it held
> duplicate buildings baked into one scene (`:20-24`). Terrain = sand plane
> + individual buildings + decorations.

### Terrain raycasting (for grounding)

All NPCs / player / edit-mode buildings raycast down onto layer
`TERRAIN_LAYER = 1`:

- `arena-npcs.tsx:41-62` — generic NPCs
- `arena-location-npcs.tsx:27-30, 111-118` — SpongeBob NPCs
- `player-avatar.tsx:91-107` — the player lobster
- `arena-buildings.tsx:34-40, 223-235` — edit-mode buildings only

Raycast origin `(x, 200, z)` downward `(0, -1, 0)`, `far = 400`. Fallback Y
is `-2` when no hit (matches sand floor).

---

## 6. Decorations & Landmarks

### Known issues (2026-04-16)

**[RESOLVED] Issue A — Decorations overlapped the ring:** `DECO_INNER_EXCLUSION_R`
raised from 600 → 2300 → **2700** (2026-04-16 ring expansion 56→68 tiles).
Decorations now scatter in the annulus outside the ring
(ring radius 2176 + one building zone half 224 + 300 wu buffer = 2700).
See constants table below.

**[RESOLVED] Issue B — `building-submarine.glb` was both a ring building AND a
landmark.** Slot 9 (`agent-security`) now uses `building-cave.glb`. The
submarine remains as a fixed landmark at `(1900, -2, 700)` in `FixedLandmarks`.
No more duplicate submarines.

**[RESOLVED] Issue C — Krusty Krab and character mis-pairings:** canonical
building↔character pairings implemented 2026-04-16. Mr. Krabs now stands at
`mcp-tool-use` (patty-building / Krusty Krab). Gary is a companion at
`visual-creation`. Karen is a companion at `code-development`. Webhook-gateway and
cron-automation are intentionally unattended.

**Issue D — Decorations include "building-prefixed" GLBs that look like
buildings:** `building-shell`, `building-seashell`, `building-anchor`,
`building-barrel`, `building-chest`, `building-lantern`, `building-tower2`
are all weighted into `DECO_TYPES`. These are intentional decorations
(underwater props), but the `building-` prefix is misleading. The core
10 buildings in §2 are the only "buildings" for gameplay/API purposes;
decorations are just props scattered around.

### Procedural scatter (`arena-terrain.tsx:211-411`)

| Constant | Value | Source | Target |
|---|---|---|---|
| `TARGET_COUNT` | `80` | `:296` | 80-120 (more coverage) |
| `EXTENT_X` | `MAP_WIDTH * 2.4` = `12288` | `:299` | same |
| `EXTENT_Z` | `MAP_HEIGHT * 2.4` = `12288` | `:300` | same |
| `N_CLUSTERS` | `24` | `:304` | same |
| `CLUSTER_RADIUS` | `280` world units | `:305` | same |
| `DECO_INNER_EXCLUSION_R` | `2700` (ring expansion 2026-04-16; was 2300 for r=56 ring, 600 before that) | `:275` | same |
| `MIN_SPACING_SQ` | `35 × 35` | `:325` | same |
| `VILLAGE_CX` / `VILLAGE_CZ` | `(0, 0)` | `:271-272` | same |
| Placement PRNG seed | `12345` | `:291` | same |

**Algorithm:** pick random cluster → sample dist via
`(rng()+rng()) * CLUSTER_RADIUS` (triangular distribution biased toward
center) → reject if inside village inner exclusion OR inside a building
exclusion (radius `max(w,h) * TILE_SIZE * 2.0`) OR too close to an existing
deco (`:290-365`).

### Weighted decoration types (`DECO_TYPES` — `:221-245`)

Scale ranges capped (2026-04-16 regression fix) to keep max decoration
dimension ≤ 150 world units. Previous coral-reef maxScale=28, kelp=30
produced 500-670 wu wide props visible from origin even at dist 3000-5000
(measured: #68 bbox 671×576, #12 bbox 618×620). Native coral/kelp bboxes
are ~5-10 units wide; cap at 15 → max ~150 wu.

| Model | Weight | Scale range | Max ~wu |
|---|---|---|---|
| `coral-reef1.glb` | 3 | 4–15 | ~150 |
| `coral-reef2.glb` | 3 | 3–13 | ~130 |
| `coral-reef3.glb` | 3 | 3–12 | ~120 |
| `kelp.glb` | 3 | 6–15 | ~150 |
| `building-shell.glb` | 5 | 2–12 | ~60 |
| `building-seashell.glb` | 5 | 2–12 | ~60 |
| `building-anchor.glb` | 4 | 3–14 | ~70 |
| `building-barrel.glb` | 4 | 3–10 | ~50 |
| `building-chest.glb` | 4 | 3–12 | ~60 |
| `building-lantern.glb` | 3 | 4–12 | ~60 |
| `crayfish.glb` | 3 | 3–10 | ~50 |
| `building-tower2.glb` | 2 | 4–14 | ~70 |

### Fixed landmarks (`FixedLandmarks` — `:442-473`)

| Landmark | Model | Position (x, y, z) | Scale | Rotation (Y) |
|---|---|---|---|---|
| Shipwreck | `/models/building-shipwreck.glb` | `(-1900, -2, -700)` | `2.5` | `+0.8` rad |
| Submarine | `/models/building-submarine.glb` | `(+1900, -2, +700)` | `2.0` | `-0.5` rad |

### Underwater decorations scene

Single 5.9 MB primitive `/models/underwater-decorations.glb` at
`(-600, -2, +1900)`, scale `8`, rotation `0` (`arena-terrain.tsx:419-434`).

---

## 7. Seaweed Ground Cover

**Source:** `apps/web/src/lib/three/merged-seaweed.tsx`

| Constant | Value | Source |
|---|---|---|
| `BLADE_COUNT` | `4500` | `:17` |
| `SPREAD_X` | `MAP_WIDTH * 2.2` = `11264` | `:20` |
| `SPREAD_Z` | `MAP_HEIGHT * 2.2` = `11264` | `:21` |
| `RATIO_SHORT_GRASS` | `0.40` | `:24` |
| `RATIO_TALL_KELP` | `0.35` | `:25` |
| Remaining (fern) | `0.25` | `:26` |
| `VILLAGE_CX` / `VILLAGE_CZ` | `(0, 0)` | `:225-226` |
| `SEAWEED_INNER_R` | `280` | `:227` |
| `SEAWEED_SPARSE_R` | `800` (25% pass rate inside) | `:228, 258` |
| Cluster count | `ceil(BLADE_COUNT / 50)` = `90` | `:215` |
| Cluster radius | `40 + rng() * 120` | `:220` |
| PRNG seed | `99991` | `:211` |

### Blade variants (`:191-300`)

| Variant | Segments | Height | Width | Curve | Sway amplitude | Color palette |
|---|---|---|---|---|---|---|
| `grass` | 4 | 10–15 | 1.5 | 0.8 (gentle) | 2.0–3.0 | `COLORS_GRASS` (dark greens) |
| `kelp` | 6 | 35–45 | 2.5 | 4.5 (strong S) | 6.0–8.0 | `COLORS_KELP` (emerald/jade) |
| `fern` | 5 | 20–25 | 4.0 | 2.0 (flat arc) | 3.5–5.0 | `COLORS_FERN` (mid forest) |

Each variant uses a **flat-strip geometry** built from `(segs + 1) * 2`
vertices — two rails along Y with indices forming quads.

### Merged geometry + TSL wind

- `mergeGeometries()` (from `BufferGeometryUtils`) combines all 4500 blade
  geos into one `BufferGeometry` → **one draw call** (`:309-373`).
- Per-vertex attributes baked into merged buffer:
  - `aPhase` (float) — unique per blade, used as time phase
  - `aHeight` (float) — 0 at root, 1 at tip (sway only top)
  - `aAmplitude` (float) — variant-specific sway strength
  - `color` (vec3) — tip brighter than root (`0.45 + heightFactor * 0.55`)
- Material: `MeshBasicNodeMaterial` with `vertexColors`, `DoubleSide`,
  `opacity: 0.88`, `depthWrite: false` (`:381-388`).
- TSL `positionNode` uses **two wave layers** (`:394-419`):
  - Wave 1 (fast sway): `sin(time * 0.9 + phase)` on X, `sin(time * 1.4 + phase*1.7)` on Z
  - Wave 2 (slow oceanic current): `cos(time * 0.18 + phase*0.3)` on X, `sin(time * 0.12 + phase*0.5)` on Z
  - Both multiplied by `height * amplitude` so roots stay anchored.

> **No InstancedMesh** — merged geometry is used specifically to avoid the
> known `InstancedMesh + TSL/Shader material` silent crash on Intel Iris Xe
> WebGPU.

---

## 8. Camera System

**Source:** `apps/web/src/components/three/World3DCanvas.tsx`

### Controllers (mutually exclusive except arrow rotation)

| Controller | When active | Role |
|---|---|---|
| `WASDCameraController` | `controlMode === 'explore'` only | Free-cam pan on WASD + mobile left joystick; reads `joystickVelocity` from game store each frame. Joystick is analog-pressure-preserving (magnitude clamped to ≤1; partial push pans at proportional speed). Full 3D move including Y for swim up/down |
| `FPSFollowCamera` | `controlMode !== 'explore'` (player / autonomous / npc) | Lerp `controls.target` toward character, preserve orbit angle + zoom |
| `ArrowKeyRotationController` | **All modes** | Arrow keys + right mobile stick rotate orbit camera via spherical Δθ / Δφ |
| `NpcController` | `controlMode === 'npc'` | Camera-relative input drives the possessed NPC |

### OrbitControls config (`World3DCanvas.tsx:530-542`)

| Prop | Value | Notes |
|---|---|---|
| `makeDefault` | `true` | All other hooks see this |
| `enablePan` | `!isTouchDevice` | Disabled on touch |
| `enableZoom` | `true` | |
| `enableRotate` | `true` | |
| `minDistance` | `40` in follow mode / `160` in explore | `followMode ? 40 : 160` |
| `maxDistance` | `5500` | |
| `maxPolarAngle` | `Math.PI * 0.85` ≈ `153°` | Can't look straight up |
| `rotateSpeed` | `0.4` touch / `1` desktop | |
| `zoomSpeed` | `0.6` touch / `1` desktop | |
| `target` | `[0, 10, 0]` | Initial orbit center |

### Arrow-key rotation (`:105-178`)

- `ARROW_ROT_SPEED = 1.5` rad/s.
- `PHI_MIN = 0.1` (nearly straight down), `PHI_MAX = π * 0.85` (~153°).
- `CAM_Y_MIN = -5` — camera may dip slightly below ground for upward views.
- Spherical scratch `_offset`, `_spherical` allocated module-level to avoid
  per-frame GC.

### Follow camera (`:265-316`)

- `FPS_FOLLOW_DISTANCE = 240` declared at `:96` but **NOT** applied —
  comments at `:302-305` explain the radial rescale was removed so
  scroll-zoom isn't reset each frame.
- `CHAR_TARGET_Y = 15` — orbit target height above the avatar.
- Target lerp: `tgt += (worldPos - tgt) * 0.1` each frame.

### Canvas initial camera (`:713-719`)

- `fov: 50`, `near: 1`, `far: 6800`.
- Game-mode start position: `[0, 600, 1300]` (tightened from `[0, 700, 1600]` on 2026-04-16 proportions pass).
- Arena-mode start position: `[0, 560, 1000]`.
- `dpr: [0.75, 1]` — capped device pixel ratio (`:708`).
- `frameloop: "always"` — required because async `gl` factory + `"never"`
  skips the factory entirely on R3F v9 (`:709-712`).

---

## 9. Lighting & Atmosphere

### Lights (hard-capped at 3 for Iris Xe — `World3DCanvas.tsx:557-563`)

| Light | Args | Intensity | Color |
|---|---|---|---|
| `hemisphereLight` | sky `0x66bbdd`, ground `0x223344` | `1.8` | cyan sky / dark cool ground |
| `directionalLight` (key) | pos `(150, 350, 80)` | `2.0` | `0xffeedd` warm caustic |
| `directionalLight` (fill) | pos `(-100, 200, -60)` | `0.5` | `0x88aacc` cool fill |

### Fog (`World3DCanvas.tsx:622`)

```tsx
<fog attach="fog" args={[FOG_COLOR, 1200, 6400]} />
```

- `FOG_COLOR = 0x0e3458` — underwater haze matching sky (`:44`).
- Near = `1200`, far = `6400` — calibrated for Intel Iris Xe. Keeps distant geometry fog-culled so the GPU stays within its fragment budget. `camera.far = 6800` clips anything past 6800 wu, so a fog far beyond that has no visual effect but wastes GPU time on already-clipped fragments. Pushing to `1800/9000` (commit `9e7341a`) caused a ~40 FPS regression on Iris Xe (more rasterized fragments past fog cutoff); reverted in FPS-fix commit.
- Scene background: `SKY_COLOR = 0x0a2a4a` deep ocean blue (`:43, 722`).

### Underwater atmosphere (`underwater-atmosphere.tsx`)

Three GPU-driven effects, all TSL node materials:

| Component | Geometry | Position | Key effect |
|---|---|---|---|
| `CausticPlane` | `PlaneGeometry 6400×6400` | `(0, 150, 0)`, rotated `-π/2` around X | 4 overlapping sine waves multiplied → sharp caustic spots; `AdditiveBlending`, `opacity ≤ 0.10`, color `(0.5, 0.85, 1.0)` |
| `DepthBackdrop` | `PlaneGeometry 14400×900` (4 H-segs) | `(0, 350, -5500)` | Deep→mid→shallow blue/teal gradient via `mix`; horizontal edge fade starting at 60 % toward edges; `opacity ≤ 0.72` |
| `DustParticles` | 300 `Points` via `PointsNodeMaterial` | Field `3600×350×2400` | TSL `positionNode` drifts Y upward at `8 units/s` via `fract(y/H + time)`; sway via `sin(t*0.3)` and `cos(t*0.22)`; soft white-blue `(0.7, 0.88, 1.0)` @ opacity `0.18`, `size: 2.5` |

### Volumetric light rays (`underwater-light-rays.tsx`)

- **7 cones** (`CylinderGeometry` with `radiusTop = 0..3`, `radiusBottom = 30..55`,
  `height = 270..310`, 6 radial segments, `openEnded=true`).
- Each ray: `MeshBasicNodeMaterial`, `AdditiveBlending`, `DoubleSide`.
- TSL opacity: `sin(time * speed + phase) * 0.5 + 0.5`, remapped to per-ray
  `[opacityMin, opacityMax]` range (`0.008 .. 0.06`). Every ray has unique
  `speed (0.19..0.40)` and `phase (0..5.1)`.
- Color: warm `(1.0, 0.937, 0.733)` = `#ffeebb`.
- All rays at `y = 150`; spread `x ∈ [-230..220]`, `z ∈ [-160..120]`.

---

## 10. Performance Budget & GPU Constraints

**Target:** Intel Iris Xe integrated GPU (user's dev machine). WebGPU with
WebGL2 fallback (`World3DCanvas.tsx:619-649`, `678-694`).

### Hard rules (violated = GPU crash / blank screen)

| Rule | Where enforced | Rationale |
|---|---|---|
| **No `InstancedMesh` + `ShaderMaterial` / `NodeMaterial`** | seaweed uses merged geometry; particle-system uses `MeshBasicMaterial` | Silent WebGPU crash on Iris Xe |
| **No `drei <Text>` or `<Billboard>`** | all labels use `drei <Html>` DOM overlays | Kills Iris Xe pipeline |
| **Max 3 lights** | `hemisphere + 2 directional` | GPU light uniform limit + shader compile cost |
| **TSL nodes only** (no raw GLSL / WGSL) | all custom materials | Three.js r182 routes both WebGPU + WebGL through TSL |
| **Dynamic imports for WebGPU** | `three/webgpu` imported only in `createWebGPURenderer()` | Keep WebGL-only bundles lean |

### Perf HUD metrics (`perf-hud.tsx:41-130`)

Samples `window.__W3D.gl.info.render` at 2 Hz. Shows:

- **FPS** — RAF rolling counter, green ≥45, yellow ≥25, red <25
- **Draws** — `gl.info.render.calls`
- **Tris** — `gl.info.render.triangles` (displayed as `Xk`)
- **Objs** — live `scene.traverse()` mesh count
- **Pipes** — `gl.info.render.pipelines` (WebGPU) or `gl.info.programs.length` (WebGL). Added 2026-04-24 for A2 diagnostic; target ≤20.
- **Backend** — `WebGPU` or `WebGL`

> No hard-coded target numbers in code. The CLAUDE.md browser-verification
> rule calls for **FPS > 50** on the Iris Xe dev box.

### Allocation hygiene (scratch objects)

Every hot path uses module-scope `THREE.Vector3 / Matrix4 / Raycaster`
scratch objects, not per-frame `new`:

- `World3DCanvas.tsx:80-92` — `_offset, _spherical, _followOffset, _wasdForward, ...`
- `arena-npcs.tsx:44-47` — `_raycaster, _rayOrigin, _rayDir`
- `arena-buildings.tsx:37-40` — `_buildRaycaster, _buildRayOrigin, _buildRayDir`
- `arena-location-npcs.tsx:27-30` — `_locRaycaster, _locRayOrigin, _locRayDir`
- `player-avatar.tsx:94-97` — `_petRaycaster, _petRayOrigin, _petRayDir`
- `click-to-move.tsx:31-33` — `_dotWorldPos, _dotMatrix, _rotMatrix`
- `npc-controller.tsx:45-47` — `_camForward, _camRight, _worldUp`
- `particle-system.tsx:161-164` — `_particleMatrix, _particleScale, _particlePos, _particleQuat`
- `trail-renderer.tsx:8` — `_trailScratch`

### Raycast staggering

NPCs and the player raycast terrain only every 3rd frame, and the trigger
frame is offset by `(frame + seed) % N`, so the 10 location NPCs don't all
spike CPU on the same tick (`arena-npcs.tsx:164-168`,
`arena-location-npcs.tsx:172-173`, `player-avatar.tsx:270-274`).

### Idle animation throttling (2026-04-23)

`applyStationaryIdleAnimation` (location NPCs) and `applyIdleAnimation`
(wandering GLB NPCs when `direction === 'idle'`) are gated to 20Hz via
`(frame + seed) % 3 === 0`. Walk animations run at full 60Hz (squash/stretch
cycle is 8 rad/s — needs high sampling). AnimationMixer for Pearl Krabs runs
at 60Hz (keyframe interpolation; skipping causes visible pose discontinuities).
All idle animation frequencies are ≤1.3 rad/s; 20Hz satisfies Nyquist with
48× margin. Stagger by per-NPC integer seed prevents batch spikes.

### VRM spring-bone physics throttle (2026-04-23, updated 2026-04-24)

`VRMCharacterAnimator` now exposes `updateMixerOnly(delta, isMoving)` and
`updateSpringOnly(accumulatedDelta)` in addition to the existing `update()`.

For visible VRM NPCs in `VRMNpcMesh.useFrame` (`arena-npcs.tsx`):
- **Walking NPCs**: full `update(dt, isMoving)` at 60Hz — large spring
  displacements from hair/tail require full-rate sampling.
- **Idle NPCs**: `updateMixerOnly` ALWAYS at 60Hz (Nori parity — see B9 fix below) +
  tiered `updateSpringOnly`: close (≤ VRM_NPC_HALF_RATE_DIST_SQ) = 30Hz every 2nd frame;
  mid-dist (> VRM_NPC_HALF_RATE_DIST_SQ) = 15Hz every 4th frame.
- **Culled NPCs** (dist > NPC_CULL_DIST_SQ): unchanged — full `update(dt*4)`
  every 4th frame (effectively 15Hz) keeps animation warm for when they enter range.

Spring bone cost: 5 VRM NPCs × ~10-20 joints × matrix + verlet + collision per joint.
30Hz halves the spring physics budget for idle NPCs with no perceptible visual
difference (max spring frequency < 4Hz → 30Hz = 7.5× Nyquist margin).

### Phase A+B initial VRM performance fixes (2026-04-24)

Six optimisations shipped in branch `fps-initial-fixes`:

**B9 — Half-rate gate removal (smoothness fix)**
The previous early-return `if (camDistSq > VRM_NPC_HALF_RATE_DIST_SQ && (frame+seed)%2!==0) return;`
in `VRMNpcMesh.useFrame` killed the ENTIRE useFrame on odd mid-distance frames, including
the `updateMixerOnly` call. Miu/Kyoko's keyframe mixer ran at ~30Hz in the 1000–10000wu
band, causing visible jank not present on Nori (unconditional 60Hz in `town-guide.tsx`).
Fix: removed the early-return entirely. Mixer is now unconditional 60Hz for all VRM NPCs.
Spring-bone throttle moved to tiered `springMod`: 4 at mid-dist (15Hz), 2 at close (30Hz).

**B1 — MToon outline pass disabled**
`vrm-loader.ts`: traverse after `rotateVRM0`, set `m.outlineWidthMode = 0` (None) on all
MToonMaterial instances. Halves draw calls per VRM mesh — each MToon mesh normally renders
twice (fill + outline silhouette). Reversible: set to 1 (World) or 2 (Screen).

**B3 — VRMUtils.removeUnnecessaryJoints**
`vrm-loader.ts`: added `VRMUtils.removeUnnecessaryJoints(vrm.scene)` after
`removeUnnecessaryVertices`. Prunes finger/toe/face bones not driven by Mixamo clips.
Reduces VRoid bone count 20-40%; cuts `skeleton.update` cost proportionally. Safe —
preserves all 54 mandatory humanoid bones.

**B4 — Disable lookAt + expressionManager on wanderers**
`arena-npcs.tsx VRMNpcMesh`: new `useEffect(() => { vrm.lookAt = undefined; vrm.expressionManager = undefined; }, [vrm])`. Skips per-frame eye-tracking and morph-target work inside `vrm.update()` for wandering NPCs that never lipsync or eye-track. Does not affect the player avatar (`player-avatar.tsx` is separate).

**B2 — Verse Engine skeleton.update batching**
`vrm-character-animator.ts VRMCharacterAnimator`: constructor collects one `skeleton.update` fn per unique skeleton, replaces each SkinnedMesh's `skeleton.update` with a no-op, caches originals in `_skeletonUpdateFns[]`. Both `update()` and `updateMixerOnly()` call `for (const fn of this._skeletonUpdateFns) fn()` once after `mixer.update()`. Eliminates N redundant `skeleton.update` calls/frame (N = SkinnedMesh count sharing one skeleton — typically 3-4 for VRoid VRMs). `dispose()` restores original fns for safe animator re-construction. Reference: VerseEngine/three-avatar avatar.ts:614.

**A1 — PerfHud pipeline count**
`perf-hud.tsx`: added `pipes` stat reading `gl.info.render.pipelines` (WebGPU) or `gl.info.programs.length` (WebGL). Displayed as `N pipes` in the HUD strip — diagnostic for A2 WebGL-vs-WebGPU comparison (target: ≤20 pipelines).

### Decoration geometry merge with spatial chunking (2026-04-23)

**Before:** 80 `SingleDecoration` components, each a cloned GLB `<primitive>` with
5-40 child meshes = ~3000-3200 individual Three.js Meshes = ~3000 draw calls/frame.

**Iteration 3a (regressed):** Single merged mesh per material (frustumCulled=false) → scene graph 3498→332 objects, memGeos 551→247. But tris/frame 514k→687k (+33%) because frustumCulled=false forces every decoration triangle to render every frame regardless of camera direction. FPS 23.5→20.9 (-2.6 regression).

**Iteration 3b (current — spatial chunking):** `MergedDecorationsInner` loads all 12 unique decoration GLBs, bakes world transforms into geometry vertices, buckets by `(3×3 gridCell, materialUUID)` rather than materialUUID alone. Each cell covers ~5333wu of the ±8000wu world extent. `mergeGeometries()` per bucket, then `computeBoundingBox()` + `computeBoundingSphere()` on each merged geometry. `frustumCulled` stays at default `true` — each chunk's tight AABB means Three.js skips off-screen cells correctly. Spectator camera facing town center: ~5 of the 9 cells are behind/off-screen and culled, restoring the pre-merge triangle budget.

Result: ~60-90 merged `<mesh>` elements (9 cells × ~7-10 materials/cell) vs original ~3000. Draw calls reduced ~30-50×; triangle budget matches pre-merge when half the grid is off-screen.

Constraints:
- SkinnedMesh nodes skipped (decoration GLBs are all static; guard is defensive)
- ShaderMaterial / NodeMaterial nodes skipped (WebGPU crash guard)
- `matrixAutoUpdate={false}` on merged meshes (at world origin, transforms baked in)
- `frustumCulled` default `true` — per-cell AABB is tight, culling is correct
- `computeBoundingBox()` + `computeBoundingSphere()` called after each merge (required for frustum cull)
- Temporary per-mesh geometry clones disposed after `mergeGeometries()`
- Merged geometries disposed on component unmount

### Particle system (`particle-system.tsx`)

- Fixed pool `MAX_PARTICLES = 100`.
- Two `InstancedMesh`es (sphere + box), `MeshBasicMaterial` (NOT
  ShaderMaterial) so the Iris-Xe InstancedMesh+Shader crash doesn't hit.
- Per-instance color via `setColorAt()` (Three r170+).

### Minimap position tracker (`World3DCanvas.tsx:360-406`, rendered `:646`)

- `MinimapPositionTracker` is a `useFrame` component with no DOM output —
  it writes `useGameStore.setState({ avatarPosition })` at ~5 Hz so the
  minimap blip moves in sync with the camera/possessed-NPC.
- Mode-aware source:
  - `explore` → reads `OrbitControls.target` (camera focus point).
  - `npc` → reads the possessed player-NPC's map coords from `useNpcStore`.
  - `player` / `autonomous` → the avatar component already owns `avatarPosition`
    writes, so the tracker skips.
- Throttled write: skips the store update if (x, y) hasn't moved ≥ 2 tile
  units since the last tick. Keeps Zustand subscriber count quiet when the
  camera is still.
- Lives in the R3F scene graph so it inherits rAF throttling when the tab
  is backgrounded — do NOT read `window.__MM_TICK` from MCP tabs (the MCP
  tabs group is always hidden/throttled; use `/browser-live` CDP instead).

### 2026-04-21 Perf Sweep — all 14 three/ files audited

Baseline: ~50 FPS on Iris Xe. Target: 60+ FPS floor.

| Fix | File | Category | Est. frame-time saving |
|---|---|---|---|
| `intersectObject(terrain, false)` replaces `intersectObjects(scene.children, true)` | `arena-location-npcs.tsx` | Raycast | ~1–2 ms/frame (was scene-wide traversal on every location NPC raycast tick) |
| Removed `distanceFactor={300}` from `<Html>` speech bubbles | `npc-speech-bubbles.tsx` | DOM/Layout | ~0.5–1 ms when bubbles visible (eliminates per-frame camera-distance recompute + CSS Layout pass per bubble) |
| Module-scope scratch vectors/matrices in `toWorld()` and dot loop | `click-to-move.tsx` | GC | ~0.2 ms (eliminates per-dot `new Vector3` + `new Matrix4` on every useFrame when dots visible) |
| Vector3 pool recycling in trail history | `trail-renderer.tsx` | GC | ~0.1 ms (recycles oldest entry instead of `shift()+new` when trail is full) |
| Active-particle state moved into useFrame; `pool.filter()` removed from render body | `particle-system.tsx` | React reconcile | ~0.3 ms (filter was running on every React render, not just useFrame) |
| `matrixAutoUpdate=false` on bounty board (4 meshes) | `bounty-board-object.tsx` | CPU matrix | ~0.05 ms |
| `matrixAutoUpdate=false` on 80 decoration groups + all cloned children | `arena-terrain.tsx` | CPU matrix | ~1–2 ms (was largest single updateMatrixWorld contributor per profiler) |
| Narrowed NPC store subscription to indicator-only fields | `activity-indicators.tsx` | React subscription | ~0.5 ms per 100ms SSE tick (avoids full re-render on every NPC position update) |
| `matrixAutoUpdate=false` on CausticPlane, DepthBackdrop, DustParticles | `underwater-atmosphere.tsx` | CPU matrix | ~0.1 ms |
| `matrixAutoUpdate=false` on 7 LightRay cones | `underwater-light-rays.tsx` | CPU matrix | ~0.1 ms |
| `matrixAutoUpdate=false` on podium steps, rim, cone, hitbox | `auction-podium.tsx` | CPU matrix | ~0.05 ms |
| Removed dead `_pedestalRotScratch`; `matrixAutoUpdate=false` on 9 static pedestal meshes | `bazaar-pedestals.tsx` | CPU matrix + dead code | ~0.1 ms |
| Removed `gl.setPixelRatio()` override in `onCreated` | `World3DCanvas.tsx` | DPR | Prevents unintended DPR override — correct 0.75–1.0 clamp now honored by `dpr` prop |

Total estimated savings: ~4–6 ms/frame → expected 60–65 FPS on Iris Xe.

**Static mesh inventory (matrixAutoUpdate=false as of this sweep):**

All previously identified static objects (arena-npcs, arena-buildings, player-avatar terrain raycaster, merged seaweed) were already frozen. The sweep adds:

- Bounty board: 2 posts + crossbar + hitbox
- 80 SingleDecoration groups + all traversed child meshes
- 3 underwater atmosphere meshes (caustic plane, depth backdrop, dust points)
- 7 underwater light ray cones
- Auction dome GLB (static; jellyfish inner group excluded — spins via useFrame)
- Bazaar fish stall GLB (static, matrixAutoUpdate=false)
- Marketplace food stall GLB (static, matrixAutoUpdate=false)

---

## 11. Asset Compression & Loading

### Pipeline pre-compilation (`World3DCanvas.tsx:359-374`)

- `PreCompilePipelines` calls `gl.compileAsync(scene, camera)` on the first
  post-mount RAF. Moves the 274 ms pipeline-compile hitch into the loading
  spinner.
- No-ops on WebGL (method doesn't exist on `WebGLRenderer`).

### Staggered texture upload (`World3DCanvas.tsx:395-486`)

- `TEXTURE_UPLOAD_BATCH = 2` textures per RAF tick (`:395`).
- 20 possible texture slots scanned per material: `map`, `normalMap`,
  `roughnessMap`, `metalnessMap`, `aoMap`, `emissiveMap`, `lightMap`,
  `envMap`, `alphaMap`, `bumpMap`, `displacementMap`, `clearcoatMap`,
  `clearcoatNormalMap`, `clearcoatRoughnessMap`, `sheenColorMap`,
  `sheenRoughnessMap`, `transmissionMap`, `thicknessMap`, `specularMap`,
  `specularColorMap` (`:398-404`).
- Calls `gl.initTexture(tex)` synchronously — uploads WebP-decoded pixels
  to GPU. Avoids the 400 ms+ bulk-upload hitch.
- Warns if any single batch exceeds 20 ms.

### KTX2 compressed textures (`ktx2-loader-setup.tsx`)

- Module-level `KTX2Loader` singleton initialized inside the Canvas via
  `KTX2LoaderSetup` (`:79-104`).
- Transcoder WASM served from `/basis/` (copied by a `compress-ktx2`
  script from `three/examples/jsm/libs/basis/`).
- `detectSupport(gl)` works for both `WebGPURenderer` (via `hasFeature`)
  and `WebGLRenderer` (via `extensions.has`) — requires Three.js r182's
  `KTX2Loader` from `three/addons/`, NOT the three-stdlib version.
- On Iris Xe WebGPU: decodes to **BC7 (BPTC)**. WebGL fallback: BPTC_RGBA
  → RGBA8.
- `extendLoaderWithKTX2(loader)` is passed as the 4th arg to
  `useGLTFWithKTX2` to attach the singleton at load time.

### Draco compression

Drei's `useGLTF` attaches the built-in `DRACOLoader` automatically for any
GLB containing `KHR_draco_mesh_compression`. Not explicitly wired in
`ktx2-loader-setup.tsx`.

### Deferred preloads

To avoid blocking the first frame with `useGLTF.preload()` calls at module
eval time, two components run preloads inside a post-mount RAF:

- `DeferredTerrainPreloads` (`arena-terrain.tsx:497-523`) — preloads all 14
  decoration + 2 landmark GLBs and the 5.9 MB `underwater-decorations.glb`.
- `DeferredNpcPreloads` (`arena-location-npcs.tsx:244-258`) — preloads all
  character GLBs listed in `LOCATION_NPCS`.

Building GLBs (`arena-buildings.tsx:111-113`) are still preloaded at module
eval — the 10 building models are the critical path for the first frame.

### Renderer factory (`World3DCanvas.tsx:619-649`)

1. Dynamic `import('three/webgpu')` → `new WebGPURenderer`.
2. `await renderer.init()` — internally tries WebGPU, auto-falls-back to
   WebGL2 if unavailable.
3. Device-loss handler attached to `backend.device.lost` — reloads the
   page after 500 ms if the driver crashes with `reason: 'unknown'`.
4. Outer try/catch: if WebGPU init throws, dynamic `import('three')` →
   `new WebGLRenderer({ powerPreference: 'low-power', antialias: false })`.

---

## Appendix — Discrepancies Flagged During Audit

1. **[RESOLVED] Building layout was clusters, now circular ring.**
   `tilemap-data.ts` and `npc-definitions.ts` `BUILDING_TILE_ZONES`
   updated to radius-56 ring, 36° spacing, starting top-center.
   `arena-buildings.tsx` `BUILDING_MODELS` retains its per-building
   `rotY` values (unchanged — buildings already face village center).

2. **Player NPC spawn at (2560, 2560), not (1280, 1280).** `(1280, 1280)`
   was the center of the old 64×40 / 2048×1280 map. Current code uses
   `(2560, 2560)` (tile 80, 80) — the center of the 160×160 / 5120×5120
   grid. See `npc.ts:428-429`.

3. **[RESOLVED] Larry now uses `lobster_plush.glb` with red tint.**
   Changed from `lobster.glb` (identical to player avatar) to
   `/models/lobster_plush.glb` with `color: 0xff2020`. A TODO comment
   in `arena-location-npcs.tsx:46` tracks the need for a proper Larry asset.

4. **[RESOLVED] Wandering NPCs now render diverse species.**
   `npc-definitions.ts` species fields updated from legacy `AvatarSpecies`
   enum values (owl, fox, turtle, dragon, phoenix, cat, bunny, wolf —
   none of which existed in `SPECIES_MODEL`) to the actual visual species
   keys across 3 categories (openclaw/hermes/other). `NpcDefinition.species`
   widened to `string`. Demo store still hard-codes lobster for all 10
   offline demo NPCs — this is intentional (offline fallback).

5. **`FPS_FOLLOW_DISTANCE` is declared but unused as a hard override.**
   Declared at `World3DCanvas.tsx:96 = 240`, but `FPSFollowCamera`
   deliberately does NOT apply it — the comment at `:301-305` explains the
   radial rescale was removed because it reset scroll-zoom each frame.
   Good candidate for deletion or a renamed constant.

6. **`_pedestalRotScratch` / `_floatRotScratch` declared but unused.**
   `bazaar-pedestals.tsx:37` and `auction-podium.tsx:44` declare Euler
   scratch objects at module scope that are never referenced in the
   component bodies. Dead code.

7. **QuestNpc initial Y is double-set.** The group JSX positions at
   `(0, -2+6, 0)` = `(0, 4, 0)` but the `useFrame` hook immediately
   overrides Y to `-2 + 6 + bob` every frame — same value, so the JSX
   value is redundant (`quest-npc.tsx:123, 131`).

8. **Default mobile `powerPreference` mismatch.** The WebGPU `WebGPURenderer`
   path has no `powerPreference` option (comment at `:625-626` notes
   this). The WebGL fallback path passes `powerPreference: 'low-power'`
   (`:689`). Not a bug, just worth knowing when reviewing battery usage
   behavior differences between backends.

9. **`DIR_ROTATION['idle']` differs from `continuousRot` idle.** Cardinal
   `DIR_ROTATION` for `idle` is `π` (face `+Z`, toward camera). But when
   the player stops after moving, `continuousRot` was set from
   `atan2(-vx, -vy)` and is retained for smoothness — so there's a subtle
   mismatch between "idle after input" and "idle from spawn". Not broken,
   just a nuance in `player-avatar.tsx:44, 278`.

---

## §10. VRM Avatars (added 2026-04-21)

### Overview

8 Milady Official VRM humanoid avatars available as player avatar choices in the `milady` agent category. These are anime-style neo-chibi Milady branded characters. As of 2026-04-21, VRM avatars are used by **5 wandering NPCs** (Miu, Kyoko, Vivi, Maple, Ash — using official_7/8/2/3/4). Location NPCs (SpongeBob cast) remain sea-creature GLBs.

### Wandering VRM NPCs (5 as of 2026-04-23)

Five Milady VRM free-wandering NPCs render via `VRMNpcMesh` in `arena-npcs.tsx`. All five are present in both `DEMO_NPCS` (disconnected mode) and `NPC_DEFINITIONS` (server-driven mode).

| NPC ID | Name | Species key | VRM path | Home position |
|---|---|---|---|---|
| `milady-miu` | Miu | `milady_official_7` | `/avatars/milady-official-7.vrm` | `(1400, 3000)` |
| `milady-kyoko` | Kyoko | `milady_official_8` | `/avatars/milady-official-8.vrm` | `(3700, 2000)` |
| `milady-vivi` | Vivi | `milady_official_2` | `/avatars/milady-official-2.vrm` | `(1600, 1500)` |
| `milady-maple` | Maple | `milady_official_3` | `/avatars/milady-official-3.vrm` | `(3500, 3500)` |
| `milady-ash` | Ash | `milady_official_4` | `/avatars/milady-official-4.vrm` | `(2700, 1500)` |

**VRM path isolation rule (REPEALED 2026-04-28):** Previously the `vrm-loader` cached one VRM per path, requiring wandering NPCs and player-avatar to use disjoint paths. Replaced 2026-04-28 with `useVRMInstance(path, instanceId)`: per-instance VRM with own scene + skeleton + humanoid + expressionManager + springBoneManager. Bytes cache (`VRM_BYTES`) shared by path so only the HTTP fetch is dedupped; each instance pays its own parse (~30-80ms on Iris Xe). Stable instance IDs: `npc.id` for VRMNpcMesh, `'player-avatar'` for PlayerPetVRMInner, `'picker'` for SelectAgentCanvas. Disposal via `disposeVRMInstance` in useEffect cleanup is mandatory or instances leak GPU memory. A previous attempt (2026-04-27, commit 8fe9a44) used `useId()` for cache keying and broke Suspense — reverted. See `scripts/test-vrm-loader.ts` for the 18-assertion logic test.

**Wandering NPC scale:** `VRM_NPC_SCALE = 112` (target ~180wu: `112 × 1.6m ≈ 179.2wu`, 4× the 45wu lobster baseline). Doubled twice on 2026-04-23 per user request — 45wu read as too small for the dominant human-scale cast. This differs from the picker registry `scale = 13` which targets ~21wu for the SelectAgentCanvas camera range.

**Player-avatar VRM scale:** `PET_VRM_SCALE = 28` in `player-avatar.tsx` (target 44.8wu: `28 × 1.6m ≈ 44.8wu`). Matches `AVATAR_SCALE = 40` visual height for lobster (40 × 1.12 = 44.8wu). The player's Milady avatar is intentionally the same visual size as the lobster player-avatar — both read as "the player character". Do NOT use `reg.scale = 13` (picker-only) or wandering `VRM_NPC_SCALE = 112` (dominant world NPC scale) for the player avatar.

**Routing:** `ArenaNpcs()` checks `MODEL_REGISTRY[npc.species]?.avatar_type`. If `'vrm'`, renders `<VRMNpcMesh>` inside its own `<Suspense fallback={null}>`. Otherwise renders `<GLBNpcMesh>` (unchanged).

### Asset Paths

| Key | VRM file | Preview |
|---|---|---|
| `milady_official_1` | `/avatars/milady-official-1.vrm` | `/avatars/previews/milady-official-1.png` |
| `milady_official_2` | `/avatars/milady-official-2.vrm` | `/avatars/previews/milady-official-2.png` |
| `milady_official_3` | `/avatars/milady-official-3.vrm` | `/avatars/previews/milady-official-3.png` |
| `milady_official_4` | `/avatars/milady-official-4.vrm` | `/avatars/previews/milady-official-4.png` |
| `milady_official_5` | `/avatars/milady-official-5.vrm` | `/avatars/previews/milady-official-5.png` |
| `milady_official_6` | `/avatars/milady-official-6.vrm` | `/avatars/previews/milady-official-6.png` |
| `milady_official_7` | `/avatars/milady-official-7.vrm` | `/avatars/previews/milady-official-7.png` |
| `milady_official_8` | `/avatars/milady-official-8.vrm` | `/avatars/previews/milady-official-8.png` |

Total asset weight: ~12MB VRMs + 330KB Mixamo anim GLBs (3 files: idle/walk/run) + ~950KB PNG thumbnails ≈ **~13.3MB new assets** on cold load.

**Preload policy (2026-04-21):** `arena-npcs.tsx` preloads official_2, official_3, official_4, official_7, and official_8 at module scope. Previously only official_7/8 were preloaded; the missing preloads caused Vivi/Maple/Ash to cold-load on Suspense mount, delaying `animator.init()` and leaving them in T-pose. All 5 NPC VRM paths MUST be in the preload list.

**Frustum cull (2026-04-21):** `vrm-loader.ts` calls `vrm.scene.traverse(o => { o.frustumCulled = false; })` after `rotateVRM0`. This prevents the "disappears at close range" regression where Three.js culls VRM SkinnedMesh nodes whose bind-pose bounding spheres don't encompass the animated pose.

### Pivot Convention

VRM spec mandates **feet at origin** (Y=0 at ground plane). No `computeLocalMinY` / `pivotOffsetY` calculation needed for VRM avatars. The existing sea-creature pivot-offset code is skipped entirely in the VRM code path.

### Scale Factor

`scale = 13` (registry constant `MODEL_REGISTRY.milady_official_N.scale`).

Calibration: VRM models exported at ~1.6m native height. `13 × 1.6 ≈ 20.8 wu`. This is the picker-only scale — intentionally smaller than the in-world scales. For picker fit in SelectAgentCanvas, `scale=13` with the `2.1×` picker multiplier yields ~27.3wu, framed by the camera at `[0,16,50]`, minDistance=24.

Three VRM scale contexts exist — never mix them:
| Context | Constant | Value | Visual height |
|---|---|---|---|
| Picker (SelectAgentCanvas pedestal) | `reg.scale × 2.1` | `13 × 2.1 ≈ 27.3` | ~27.3 wu framed by `[0,16,50]` camera |
| Player-avatar (main world) | `PET_VRM_SCALE` | `28` | ~44.8 wu (matches lobster player-avatar) |
| Wandering NPCs (main world) | `VRM_NPC_SCALE` | `112` | ~179.2 wu (dominant cast) |

### Facing Direction

VRM 1.0 faces **-Z** natively. VRM 0.x has `VRMUtils.rotateVRM0()` applied in `vrm-loader.ts` which adds `π` rotation to the scene root → both versions face **-Z** after load.

This is the **opposite** of sea-creature GLBs (lobster faces +Z). The VRM code path uses a separate `VRM_DIR_ROTATION` map and `atan2(vx, -vy)` formula instead of `atan2(vx, vy)`.

### Animation Pipeline

- **Loader:** `apps/web/src/lib/three/vrm-loader.ts` — Suspense-compatible hook wrapping GLTFLoader + VRMLoaderPlugin. Module-level cache prevents re-loading the same VRM path. Calls `VRMUtils.combineSkeletons` + `VRMUtils.removeUnnecessaryVertices` + `VRMUtils.rotateVRM0` after load.
- **Retargeter:** `apps/web/src/lib/three/mixamo-retarget.ts` — rewrites Mixamo `mixamorig:BoneName.quaternion` track names to VRM raw bone Object3D names. No data copying — only track name strings are rewritten.
- **Animator:** `apps/web/src/lib/three/vrm-character-animator.ts` — loads 3 Mixamo GLBs once at module level, retargets per VRM instance, creates `AnimationMixer` on `vrm.scene`, crossfades idle ↔ walk in 0.3s when `isMoving` changes. Calls `vrm.update(dt)` each frame to drive spring bones, expressions, look-at.

Mixamo animation source GLBs: `/avatars/animations/idle.glb`, `walk.glb`, `run.glb` (Mixamo bone naming: `mixamorig:Hips`, etc., clip name `Armature|mixamo.com|Layer0`).

### Color Tinting

Color tinting is **NOT applied** to VRM avatars. MToon materials (the standard VRM shading pipeline) break under the `MeshStandardMaterial.color.lerp()` + `emissive` approach used for GLBs. The user's `avatarColor` value is stored in the Zustand game store as usual but has no visual effect on VRM meshes. This is documented in the registry entry comment.

### Removed Assets (2026-04-21)

Three mothballed anime GLBs deleted from disk:
- `apps/web/public/models/chibi_goku.glb`
- `apps/web/public/models/spirited_away_senchihiro.glb`
- `apps/web/public/models/young_priestess.glb`

Their entries were removed from `SPECIES_MODEL` in `arena-npcs.tsx` and `MODEL_KEY_TO_TYPE` in `character-animations.ts`. Legacy DB rows with species `chihiro`/`priestess`/`chibi_goku` fall back to `DEFAULT_SPECIES` (lobster) in `arena-npcs.tsx`.

### DB / API Impact

No migration required. `AgentCategory` already includes `'milady'`; DB CHECK constraint `avatars_agent_category_valid` already includes `'milady'`. New `model_key` values (`milady_official_1..8`) are added to `AGENT_MODELS` in `packages/shared/src/constants/agent-models.ts` — Zod validation uses `AGENT_MODEL_KEYS` which is derived automatically. `MODEL_KEY_TO_LEGACY_SPECIES` maps all 8 keys to `'fox'` (closest 2D fallback sprite until Phase 2 modelKey migration).

---

## §12 Activity Rooms

> Added 2026-04-23 (chunk #4). Updated 2026-04-24 (chunk #13): BumperShellsPlayer client-side interpolation — 100ms render-behind delay, 4-snapshot history ring, shortest-angle rotation lerp, zero per-frame allocations. Eliminates 15Hz teleport jitter. Updated 2026-04-23 (chunk #12a): LobsterAnimator wired in BumperShellsPlayer + spectator camera modes added. Open-world structure §§1–11 is UNCHANGED. Updated 2026-04-24 (worktree-fix-bumper-build): Reef Race — all 8 files ported from `three/webgpu` → plain `'three'` import. `MeshBasicNodeMaterial` + TSL nodes removed from ReefRaceBoostFX (trail + cones now plain MeshBasicMaterial, constant opacity) and ReefRaceStartGrid (flags now static MeshBasicMaterial, TSL positionNode wave dropped). Same root cause as Bumper Shells PR #55 — see gotchas/two-three-instances-nodemat-webgl-crash.md.

Activity rooms are fully route-isolated scenes. They do NOT share the open world's
5120×5120 coordinate system, WebGPU context, scene graph, or asset cache.

### Isolation model

- Open world lives at `/game`. Activity rooms live at `/activity/:activityId/:roomId`.
- Route-level unmount tears down the open world's WebGPU context before mounting the activity Canvas.
- `key={roomId}` on the activity `<Canvas>` forces full context recreation between rooms
  (guards against React 18 StrictMode double-mount corruption).
- No imports between `apps/web/src/lib/three/` (world files) and `apps/web/src/lib/three/activities/`.
  Shared utilities live in `activities/shared/` — no Three.js instance state, pure functions only.
- Activity scenes are `React.lazy`-imported at the route level → zero weight added to the open world's
  first-paint bundle.
- VRM pipeline is NOT loaded in activity scenes (GLB avatars only: lobster, crayfish).

### §12.1 Bumper Shells

**Route:** `/activity/bumper-shells/[roomId]`
**Building portal:** Salty Spitoon (slot 2, world `(2080, -672)`)
**Scene files:** `apps/web/src/lib/three/activities/bumper-shells/`

#### Arena geometry

| Object | Geometry | Material | Draw calls | Notes |
|---|---|---|---|---|
| Platform disc | `CylinderGeometry(r=500, h=12, segs=48)` | `MeshStandardMaterial` color=`#1e3a5f`, roughness=0.85 | 1 | `matrixAutoUpdate=false`, `receiveShadow`. Colour was `#1a2a3a` (near-black, changed 2026-04-24 for visibility) |
| Rim glow torus | `TorusGeometry(r=500, tube=8, 16, 64)` | `MeshBasicNodeMaterial` cyan, transparent | 1 | Opacity pulses via JS `sin(t*2)*0.3+0.7`, `depthWrite=false` |
| Danger ring | `CylinderGeometry(r=500, h=4)` | `MeshStandardMaterial` red, opacity=0.75 | 1 | Outer 15% of arena radius |
| Void backdrop | `PlaneGeometry(8000, 8000)` | `MeshBasicMaterial` dark blue | 1 | `y=-2000`, `frustumCulled=false`, fog-immune (placed far past fog.far) |
| Central hazard body | `SphereGeometry(r=60, 16, 16)` | `MeshStandardMaterial` dark metallic | 1 | `castShadow` |
| Hazard spikes | `ConeGeometry(r=9, h=36, 6)` | `MeshStandardMaterial` red metallic | 1 | `InstancedMesh(8)` + `MeshStandardMaterial` — safe on WebGPU |

Total static draw calls (arena + hazard): **6**

#### Camera

**Active player (default):** static `OrthographicCamera`, never moves after mount.

| Property | Value |
|---|---|
| Type | `OrthographicCamera` |
| Frustum | `left=-700, right=700, top=700, bottom=-700` |
| Near / Far | `1 / 1500` |
| Position | `(0, 1100, 300)` (slight isometric tilt) |
| Look-at | `(0, 0, 0)` |
| Updates | Never after mount (`matrixAutoUpdate=false`) |

Rationale: static orthographic camera = one shadow frustum regardless of player count,
zero per-frame camera matrix work, eliminates multi-frusta shadow ceiling for 8 players.

**Spectator camera modes (chunk #12a):** When `spectatorCamMode` prop is set on `BumperShellsScene`,
the Canvas switches to a `PerspectiveCamera` (FOV 55°, same near/far). ONE camera per client — no
extra shadow frusta. Active play always uses the static ortho camera.

| Mode | Behaviour | OrbitControls |
|---|---|---|
| `'follow'` | Lerps position toward `spectatorTargetPetId + offset(0,400,350)`, looks at entity | No |
| `'free'` | OrbitControls, distance bounded 600–1500wu, pan disabled | Yes (disposed on mode exit) |
| `'action'` | Retargets to alive entity closest to arena center every 3s; lerp position + lookAt | No |

All three modes share one `SpectatorCamera` component in `BumperShellsScene.tsx`. Scratch vectors
`_camTargetPos`, `_camDesiredPos`, `_camOffset`, `_camLookAt`, `_entityPos` are module-scope — zero
per-frame allocations. Camera lerp uses `1 - exp(-4 * dt)` for frame-rate-independent smoothness.

#### Lighting and fog

| Element | Value |
|---|---|
| Hemisphere | sky `#4488cc`, ground `#1a2a3a`, intensity 1.4 |
| Key directional | `#ffffff`, intensity 2.0, `position=(200, 600, 150)`, 1×512² shadow map |
| Fill directional | `#aaccff`, intensity 0.6, `position=(-150, -200, -100)`, `castShadow=false` — lifts lobster shell undersides out of shadow when viewed top-down |
| Point lights | 3 neon accent lights, no shadows, `distance=550–600`, `decay=2` |
| Fog | linear: near=1400, far=1500, color `#050a14` |
| Background | `#050a14` |
| Fog note | **Visibility fix 2026-04-24:** Ortho camera at `(0,1100,300)` is ~1140wu from arena floor. Old `near=200/far=900` meant 100% of scene geometry was fully fogged (distance > far). Fog pushed to near=1400/far=1500 so it only clips geometry at the camera far plane. `fog.far=CAMERA_FAR` is intentional — the Iris Xe fragment-count risk (fog.far>camera.far in open world) does not apply here because fog only clips geometry that is already at the clip plane. |
| Post-processing | None — forbidden on Iris Xe |

#### Player shells

- `lobster.glb` (default) or `crayfish.glb` (alt species).
- Clone via `SkeletonUtils.clone()` + `frustumCulled=false` traverse immediately after.
- Scale: `SHELL_SCALE=40` (matches `AVATAR_SCALE` in `player-avatar.tsx`).
- **Client-side interpolation (chunk #13):** Server snapshots arrive at ~15Hz (66.67ms interval). Without interpolation, lobsters teleport 66ms each tick — visible at 60fps. Fix: a 4-slot history ring per entity (stamped with `performance.now()` on each new entity prop object). Each frame renders at `now - 100ms` (INTERP_DELAY_MS = 100ms = 1.5× snapshot interval), finding bracket snapshots and lerping x/z/vx/vz linearly and rotation via shortest-angle lerp. Zero new allocations in useFrame — all primitive math. New entity is detected by object-identity compare (`entity !== lastEntityRef.current`). Rotation fallback: when velocity is zero the last rendered rotation is preserved (NaN guard on zero-velocity facing formula).
- **LobsterAnimator wired (chunk #12a):** `discoverLobsterParts(clonedScene)` discovers bone groups spatially, `LobsterAnimator(parts)` is instantiated per clone. `animator.update(dt, elapsed, suggestedState, direction)` called every frame. Locomotion blend driven by **interpolated** velocity magnitude: `speed < 20wu/s → 'idle'`, `speed ≥ 20wu/s → 'walk'`.
- **Compose correctness:** Animator mutates bone-level local rotations on the cloned scene's children. Squash/stretch mutates `meshRootRef.scale` (a parent group). These are orthogonal transforms — no bone interference. `worldScale = outerGroupScale × meshRootScale × boneLocal`.
- Squash/stretch on hit: applied to `meshRootRef` (NOT SkinnedMesh bones). 3-keyframe schedule: squash at t=0s, stretch at t=0.07s, recover at t=0.2s.
- Elimination: `material.opacity` lerp 1→0 over 1s → `visible=false`.
- Max simultaneous: 8.
- Draw calls: 1 per player shell.

#### Power-up pickups

- `TorusKnotGeometry(r=20, tube=6, 32 tubular, 6 radial)` per slot.
- `MeshStandardMaterial` with emissive tint per kind (never ShaderMaterial).
- `drei <Html>` emoji label — DOM overlay, safe on Iris Xe. No `distanceFactor`.
- Label visibility toggled imperatively (`labelRef.current.style.display`) in useFrame — NOT via React state.
- 6 pre-allocated slots, toggle `visible` on spawn/despawn.
- Draw calls: 6 (one per slot, always mounted).

Power-up kind → emoji map: `speed⚡ shield🛡 sticky-bomb💣 whirlpool🌊 ghost👻 tractor🧜`

#### Particle burst pool

- Module-scope pool: 4 slots × 16 `Points` each = 64 max simultaneous points.
- `PointsMaterial` with `AdditiveBlending`, `depthWrite=false`.
- `Float32BufferAttribute` mutated in-place per frame — no per-frame attribute allocation.
- `triggerBurst(x, y, z, color)` — imperative, callable outside React.
- Draw calls: 4 (always mounted, `visible=false` when inactive).

#### Performance budget

| Metric | Budget | At max load (8 players) |
|---|---|---|
| Draw calls | ≤60 | ~36 (static) + ~12 (shadow pass) = ~48 |
| Triangles | ≤180k | ~24k platform + ~8 × ~3k shells + pickups + particles |
| Shadow-casting lights | 1 | 1 directional at 512×512 |
| Simultaneous skinned anims | 8 | One LobsterAnimator per shell — wired chunk #12a |
| Particle systems | ≤4 concurrent bursts × 16pts | 64 points max |
| Post-processing | 0 | 0 — forbidden |
| Camera matrices updated/frame | 0 | Static after mount |

#### File layout

```
apps/web/src/lib/three/activities/bumper-shells/
  BumperShellsScene.tsx      — Root Canvas + scene graph + BumperOrthoCamera (active) +
                               SpectatorCamera (follow/free/action) + <PreCompilePipelines>
                               Exports: BumperShellsScene, SpectatorCamMode
  BumperShellsArena.tsx      — Platform disc, rim glow torus, danger ring, void backdrop
  BumperShellsHazard.tsx     — Central spiked ball (sphere + 8 cone InstancedMesh)
  BumperShellsPlayer.tsx     — Single player shell (SkeletonUtils.clone + LobsterAnimator +
                               squash/stretch + 100ms interpolation buffer). Animator rebuilt
                               on clone change.
  BumperShellsPickups.tsx    — 6 pre-allocated pickup slots (TorusKnot + Html emoji)
  BumperShellsParticles.tsx  — Module-scope burst pool (4 slots × 16 Points)
  bumper-shells-config.ts    — All constants (radii, fog, camera, particle counts)
  bumper-shells-types.ts     — TS interfaces for store shape + coordination contract
```

#### Store coordination contract

`BumperShellsScene` reads from `@/stores/activity` (written by general-purpose WS hook).
The store must implement `ActivityStateForScene` — documented in full in `bumper-shells-types.ts`:
```
entities: Map<avatarId, { x, y, rot, vx, vy, alive, color?, species? }>
pickups:  Map<spawnId, { spawnId, kind, x, y }>
events:   { hits: Array<{at,x,y,power}>, eliminations: Array<{at,avatarId}> }
matchPhase: 'pregame-countdown' | 'live' | 'ended'
countdownSecondsRemaining: number
roundEndsAt: number | null
```

### §12.2 Shared Activity Infrastructure

**Directory:** `apps/web/src/lib/three/activities/shared/`

| File | Purpose |
|---|---|
| `world-to-screen.ts` | Pure projection utility: `worldToScreen(pos, camera, gl) → {x, y, visible}`. No React, no Three.js state. Used by HUD overlays to anchor floating labels. |
| `activity-particles.tsx` | Shared burst pool (8 slots × 16 Points). `triggerBurst(position, color, radius)` imperative API + `<ActivityBursts />` JSX component. Used by both Bumper Shells and Reef Race. |

**Note on Bumper Shells particles:** Bumper Shells has its own module-scope pool in `BumperShellsParticles.tsx` (4 slots, Bumper-specific) as well as access to the shared `activity-particles.tsx` pool (8 slots, both games). BumperShellsScene uses the local pool for hit bursts; the shared pool is available for elimination and pickup-collect effects.

### §12.3 Sections of the open-world spec impacted

- **§1 World Dimensions:** Activity rooms use independent coordinate systems. They do NOT share the 5120×5120 world-space. Each room has its own scene-origin at `(0,0,0)`.
- **§5 Town Center Objects:** Salty Spitoon (slot 2) and Boating School (slot 4) serve as the portal entry points for Bumper Shells and Reef Race respectively. No additional 3D geometry is added to the open world for portal entry — the modal UI is a frontend component.
- **§10 VRM Avatars:** Activity rooms use GLB avatars only (lobster.glb, crayfish.glb). VRM pipeline is not loaded in activity scenes.
- **§11 Performance Budget:** See §12.1 table above for Bumper Shells budget. Reef Race budget (pending chunk #6): ≤70 draw calls / ≤220k tris / 8 SkinnedMesh + 1 ghost / 1×512² shadow map.

### §12.4 Reef Race (chunk #6 — shipped 2026-04-23)

**Directory:** `apps/web/src/lib/three/activities/reef-race/`
**Portal building:** Boating School (slot 4, world `(1280, +1760)`).
**Route:** `/activity/reef-race/[roomId]`

> **Updated 2026-04-24 (fix-bumper-build):** Track geometry root-cause fix.
> Two bugs: (1) `TubeGeometry` was a hollow square tube — camera above track saw only
> back-faces (FrontSide culled) or edge-on surfaces, making the track nearly invisible.
> (2) The CatmullRom control points did NOT match the server-sim ellipse
> (`REEF_TRACK_A=1100, REEF_TRACK_B=700`) — server entity positions landed in the wrong
> place relative to the visual track. Fix: flat ribbon `BufferGeometry` with normals pointing
> +Y (DoubleSide), control points regenerated from the server ellipse formula.

#### Camera — Per-client chase-cam

Third-person follow camera. One frustum per client regardless of racer count — sidesteps Iris Xe multi-frusta ceiling. Procedural lerp in `useFrame`, NOT `OrbitControls`.

| Parameter | Value |
|---|---|
| Type | PerspectiveCamera, fov=60 |
| Near | 1 |
| Far | 5000 (bumped 3000→5000 2026-04-26; must be ≥ FOG_FAR=4500) |
| Offset (player-local) | (0, 200, −350) — behind and above |
| Look-at offset | (0, 80, 0) — slightly above kart |
| Lerp factor | 5.0 / second |

#### Track

| Parameter | Value |
|---|---|
| Geometry | Flat ribbon `BufferGeometry` (replaces `TubeGeometry`) — road surface at y=0, normals +Y, DoubleSide |
| Shape | Ellipse matching server: `A=1650wu (X), B=1050wu (Z)` (1.5× scale 2026-04-26), 16 CatmullRom control points |
| Track half-width | 300wu (full width = 600wu — matches server `REEF_TRACK_HALF_WIDTH=300`, doubled 2026-04-26) |
| Approximate perimeter | ~8500wu |
| Surface material | `MeshStandardMaterial` + Canvas-generated lane-dashes texture, `DoubleSide`, **`fog=false`** — track is always visible at any distance |
| Guardrails | merged `BoxGeometry` strip (left + right rails) → 2 draw calls, `DoubleSide`, **`fog=false`** — lane boundary always visible |
| Coral decorations | 3× `InstancedMesh` (coral-reef1/2/3.glb) → 3 draw calls (14 per type = 42 total); coral keeps `fog=true` for atmospheric depth |
| Coordinate mapping | entity.x → Three.js X, entity.y → Three.js Z (flat XZ plane, y=0) |

#### v2 Spline Track (NEXT_PUBLIC_REEF_RACE_USE_SPLINE=true)

Added 2026-04-28. Activated by env flag — v1 ellipse preserved when unset.

**Spline singleton:** `reef-race-spline-instance.ts` exports `clientSpline = new ReefSpline(REEF_RACE_DEFAULT_TRACK)` at module scope. Both `ReefRaceTrack` and `ReefRacePlayer` import from this single instance so the 1000-entry arclength LUT is built exactly once. Import crosses the monorepo boundary into `apps/api/src/services/activity/sim/` via relative path — both source files are pure TypeScript, safe for the Next.js webpack bundler.

**River bed geometry (`SplineTrack` component):**

| Parameter | Value |
|---|---|
| Samples | 64 uniform-t divisions |
| Width | Variable per sample via `clientSpline.widthAt(t)` — narrows through chicanes (kelp 630wu, shipwreck 525wu, coral 420wu), widens at lagoon/finish (1050wu). iter-5: ×1.5 compound (was iter-4: kelp 420, ship 350, coral 280, lagoon/finish 700). |
| Surface color | Sandy `0xc8a572`, roughness 0.85, metalness 0 |
| Bank walls | Vertical quads at left+right edges, merged per side → 2 draw calls. Rock color `0x6b5544`. Height 80wu, thickness 10wu. |
| Finish gate | Gold pillars (2× CylinderGeometry r=15 h=200) + crossbar (BoxGeometry), all merged → 1 draw call. Emissive gold `0xffd600`. |
| Materials | All `fog=false` — racing line always visible regardless of fog distance. All `MeshStandardMaterial` — no ShaderMaterial. |
| WebGPU safety | `makeGeometryWebGPUSafe()` applied to all custom BufferGeometry instances. |
| Draw calls | 1 (riverbed) + 2 (bank walls) + 1 (finish gate) = 4 |
| vs v1 ellipse | v1 = 1 + 2 + 3 = 6 draw calls (coral InstancedMesh removed in v2 for Phase 1) |

**Normal direction:** `clientSpline.normalAt(t)` returns 90° CCW of tangent (LEFT of travel). Left edge = `center + normal × halfWidth`, right edge = `center - normal × halfWidth`.

**Player board (v2 surfboard_1.glb):**

| Parameter | Value |
|---|---|
| Asset | `/models/reef-race/surfboards/surfboard_1.glb`, 3,220 tris, 660 KB, CC-BY 4.0 (ATTRIBUTIONS.md) |
| Clone | Plain `.clone()` — no skeleton. Per-instance. Color tint: 50% lerp toward `entity.color` so surfboard texture detail is preserved. |
| Scale | `GLIDER_WIDTH × GLIDER_HEIGHT×4 × GLIDER_LENGTH` in KART_SCALE local space |
| Attachment | Imperative `gliderRef.current.add(clonedSurfboard)` in useEffect — not JSX mesh. |
| v1 fallback | BoxGeometry(`GLIDER_WIDTH, GLIDER_HEIGHT, GLIDER_LENGTH`) + `MeshStandardMaterial('#1e293b')` — preserved when flag unset |

**Altitude / jump (v2 only):**

| Parameter | Value |
|---|---|
| Source | `EntityDelta.changed.height` → merged into `ReefRaceEntity` in store. Default 0 (ground). |
| World Y | `group.position.y = entity.height ?? 0` — applied in useFrame, bypasses interpolation ring for responsive jump feel. |
| Nose-up tilt | `glider.rotation.x = -JUMP_NOSE_UP_RAD (−0.14 rad ≈ −8°)` when airborne. Resets to 0 on landing. |
| Landing squash | Peak at landing: scaleY = 0.7, scaleXZ = 1.2. Decays over `SQUASH_DURATION = 0.18s`. |
| v1 behaviour | `group.position.y = 0` always (unchanged). |

**Feature-flag dispatch:**

```ts
const USE_SPLINE_TRACK = process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';
// ReefRaceTrack: return USE_SPLINE_TRACK ? <SplineTrack /> : <EllipseTrack />;
// ReefRacePlayer: group.position.y = USE_SPLINE_PLAYER ? entityHeight : 0;
```

**File layout (additions):**

```
apps/web/src/lib/three/activities/reef-race/
  reef-race-spline-instance.ts   — Module-scope clientSpline singleton.
  ReefRaceTrack.tsx              — SplineTrack / EllipseTrack dispatch.
  ReefRacePlayer.tsx             — surfboard_1.glb + height Y + jump tilt + VRM rider (SPEC 2).
  water-surf.tsx                 — NEW (2026-04-29 iter-7). WaterSurfMaterial (drei
                                   shaderMaterial() factory) + WaterSurf component. Wave
                                   Race 64-style depth gradient via min(uv.x,1-uv.x) +
                                   smoothstep mix #7fdfff → #1d6f8a, multi-scale simplex
                                   noise (12+8), soft white-cap foam smoothstep(0.55,0.62),
                                   pulsing edge foam, Phong sun glint. Replaces deleted
                                   inline _waterShaderMat in river-scene.tsx. No vertex Y
                                   displacement (would clip cliff face at WATER_Y=-200).
  rocky-cliffs.tsx               — NEW (2026-04-29 iter-7). RockyCliffs component. Tiles
                                   real CC0 boulder GLBs (cliff-rock-{1,2,3}.glb) along
                                   spline: 36 sections × 3 rows (y=0/y=-100/y=-200) × 2
                                   sides ≈ 58K tris merged via mergeGeometries to 2 draw
                                   calls. MeshStandardMaterial #8a6e5c flatShading.
                                   Replaces deleted procedural rocky-banks.tsx.
```

#### VRM Rider (SPEC 2 — `ReefRacePlayer.tsx`, shipped 2026-04-29)

Milady VRM avatars (`milady_official_1` … `milady_official_8`) render as full `@pixiv/three-vrm` 3.5.x avatars mounted on the surfboard. GLB species (lobster, crayfish, seahorse) are unchanged.

| Parameter | Value |
|---|---|
| VRM local scale | `VRM_RIDER_LOCAL_SCALE = 5.6` (`PET_VRM_SCALE=112` / `KART_SCALE=20`) |
| Mount point | `riderMountRef` (THREE.Group inside `gliderRef` / surfboard group) |
| Suspense | `<ReefRaceVRMRiderInner>` wrapped in `<Suspense fallback={null}>` — throws Promise on first load |
| Per-instance cache | `useVRMInstance(path, 'reef-race-{avatarId}')` — shared `VRM_BYTES` ArrayBuffer + per-instance parsed `VRM` |
| Byte preload | `preloadVRMBytes('/avatars/milady-official-{1..8}.vrm')` at module scope |
| frustumCulled | `false` on all VRM scene nodes — bind-pose bbox culls animated poses |
| Base animation clip | `surf_idle` — set as `surfaceClip` via `VRMCharacterAnimator.setSurfaceClip()` so post-one-shot crossfades target `surf_idle` not `idle` |
| Wipeout trigger | Position delta > 500wu in one 20Hz snapshot interval (respawn teleport heuristic) → `playOneShot('wipeout')` |
| Victory trigger | `entity.finishedAt` transition (once-only guard via `finishedRef`) → `playOneShot('victory')` |
| Facing convention | `group.rotation.y = entity.rot` directly — server encodes −Z convention, no offset (same as world VRMs) |

**`VRMCharacterAnimator` additions (no regression to existing callers):**
- `private surfaceClip: AnimName = 'idle'` — default preserves original world-walk behaviour
- `public setSurfaceClip(name: AnimName): void` — called once by reef-race after `init('surf_idle')`
- `dispose()` resets `this.surfaceClip = 'idle'` BEFORE `this.actions = {}`

**Wipeout heuristic — why 500wu:**  `REEF_MAX_SPEED ≈ 82wu/tick × 20Hz = 1640wu/s max travel`. 500wu in one 50ms snapshot window ≡ 10,000wu/s — 6× over the physics cap. Normal racing never triggers; respawn teleports always do.

**Rules of Hooks compliance:** `useGLTF` always called; sentinel path `/models/lobster.glb` passed when `isVRM=true`. `effectiveSrcScene = isVRM ? null : srcScene` gates all GLB downstream usage.

#### v2 River Atmosphere (`river-scene.tsx`) — updated 2026-04-29 (iter-7: water-surf.tsx + rocky-cliffs.tsx wired, inline shader + procedural cliffs deleted)

Low-poly stylized river atmosphere. Visual target: Kagelok "The River" Sketchfab aesthetic — sunny sky, animated cartoon water with foam stripes, green hillside banks with low-poly trees/rocks/fences/gameplay props.

Wired into both:
- `/preview/reef-race-v2` (`page.tsx` SceneContents)
- Production `/activity/reef-race/[roomId]` (`ReefRaceScene.tsx` SceneContents)

**Fog:** `FOG_COLOR='#a8d8ff'` (sky-blue atmospheric haze). Preview: `FOG_NEAR=8000, FOG_FAR=30000` (open-vista). Production (ellipse): `FOG_NEAR=2000, FOG_FAR=4500` (tight ellipse, keeps far karts visible). Background clear color `'#a8d8ff'` in both scenes.

**Hemisphere light:** `HEMI_SKY_COLOR='#a8d8ff'` (matches fog/dome horizon), `HEMI_GROUND_COLOR='#7cb342'` (grass green riverbank).

| Element | Details |
|---|---|
| Sky dome | `SphereGeometry(28000, 32, 16)`, `MeshBasicMaterial(vertexColors, BackSide, fog=false)`, vertex colors baked from Y position: horizon `#cfe9ff` → zenith `#5ab8e8`. `renderOrder=-1`, `matrixAutoUpdate=false`. Iris Xe safe: no ShaderMaterial. |
| ~~Sand ribbon~~ | **REMOVED in iter-5** — replaced by rocky cliff banks. `SandRibbon`, `buildSandRibbonGeo`, `_sandGeo`, `_sandMat` all removed from river-scene.tsx. |
| **Rocky cliff banks** | `rocky-cliffs.tsx` (iter-7) — `<RockyCliffs />` wired into `RiverScene()` at renderOrder=1. Tiles **real Quaternius CC0 boulder GLBs** (`cliff-rock-{1,2,3}.glb`) along spline: 36 sections × 3 vertical rows (y=0 / y=-100 / y=-200) × 2 sides ≈ **58 000 tris**, merged via `mergeGeometries` into **2 draw calls** (left + right). `MeshStandardMaterial(#8a6e5c, roughness=0.9, flatShading=true)`. Source GLB cloned BEFORE transform mutation (`useGLTF` cache-mutation guard). `scenes` array `useMemo`-gated, cleanup disposes merged geometries on unmount. Lateral placement: hw+0 → hw+200wu outward; ROW_B base sits AT waterline (`y_min=0` rock body extends upward). `frustumCulled=false`, `matrixAutoUpdate=false`, `receiveShadow=true`. **Replaces deleted procedural `rocky-banks.tsx`** (5-vertex stepped triangle strip, "faceted blob" — user-rejected). |
| Water surface | `water-surf.tsx` (iter-7) — `<WaterSurf />` at renderOrder=2. Drei `shaderMaterial()` factory + `extend()`. Static ribbon at **WATER_Y=-200** (no vertex Y displacement — would clip cliff face). Fragment: depth gradient `min(uv.x,1-uv.x)` + `smoothstep(0,0.25)` mixing `#7fdfff` shallow → `#1d6f8a` deep (Wave Race 64 technique). Multi-scale simplex noise (12+8 — replaces aliasing-prone 56/20). Soft white-cap foam `smoothstep(0.55,0.62)`. Pulsing edge foam (`edgeFoam*0.65` mix to preserve depth gradient). Phong sun glint `pow(dot(reflect(-uSunDir,(0,1,0)),viewDir),32)*0.50*depthFactor`. **Iris Xe safe**: plain ShaderMaterial via drei factory on plain Mesh, `import * as THREE from 'three'`, `frustumCulled=false`. **Replaces deleted inline `_waterShaderMat`** (vignette + scale-56 stripes — aliased to grey at chase-cam altitude). |
| Scenery props | 6 GLB types in `apps/web/public/models/reef-race/scenery/`. Each in `<Suspense fallback={null}>`. Spawned deterministically along spline bank edges. **Quaternius CC0 trees (iter-5):** `prop-tree-pine.glb` (10.236 wu native) at scale 17–22 → 174–225 wu; `prop-tree-leafy.glb` (5.544 wu native) at scale 25–32 → 139–177 wu. Rocks/fences/grass tufts unchanged at procedural scale. |
| Finish-line gate (NEW) | Procedural wooden arch at z=18200. 2 box posts (40×250×60wu) at x=±520 + top bar (1080×30×40wu). `MeshStandardMaterial(#8B4513, roughness=0.9)`. Canvas-generated 8×4 checker flag between posts (128×64 px). `fog=false`. |
| Distance markers (NEW) | 9 flag-on-pole markers at z=2000,4000,...,18000 at x=+650. Shared pole geo (4×200×4wu, `_poleMat`). Per-flag colored triangle geo (`MeshStandardMaterial`). Flag colors cycle red/green/blue/yellow/pink/teal/orange/purple/red. Gentle Y-rotation sway animation in `useFrame`. |
| Power-up boxes (NEW) | 6 golden cubes (30wu) mid-river at spline t=0.15,0.30,...,0.90, alternating ±150wu lateral offset. `MeshStandardMaterial(#ffd700, emissive=#ffaa00, emissiveIntensity=0.6)` — NO point lights (Iris Xe budget). Y-bob `sin(t*2+i)*5wu` + continuous Y-rotation in `useFrame`. |
| ~~Kart wakes~~ | **REMOVED** — replaced by `<RacingKarts />` from racing-karts.tsx (iter-5 wire-up). |
| Bridge | Wooden plank bridge at z=8500. Procedural: 1100×30wu plank at y=80+15=95 (BRIDGE_H=80; clearance above WATER_Y=-200 is **280wu** — dramatic over-canyon span) + 2 support pillars (y=0→80). `MeshStandardMaterial(#9b7040, roughness=0.9)`. `fog=false`. (iter-6: BRIDGE_H 10→80) |
| **Ramps (SPEC 3, updated 2026-04-30)** | N ramp instances (count from `buildSplineRampsClient()`, currently 6, bumping to 20) placed at spline t-positions. Each ramp is the GLB asset `bemsx_ramp_jump` (`/models/reef-race/scenery/ramp-jump.glb`): 165 tris, 712 verts, 7 WebP textures, 2 material groups (Frame/Material.026 + Floor/Material.025). Orientation: +Z=travel, +Y=up; GLB bbox ~21.4×10.0×21.1 (GLB meters). Pivot: bottom-front-center anchored at spline t-position y=0 via T_pivot=(-0.88,+0.23,+11.34) in GLB-meter space. Scale=18 → ~385wu wide × 180wu tall × 380wu travel. High end aligns with spline tangent via `rotY=atan2(tang.x,tang.z)`. All N Frame primitives merged → 1 draw call; all N Floor primitives merged → 1 draw call. Total: **2 draw calls** (down from 6). Tris: 165 × N (max 3,300 at N=20 — negligible). `frustumCulled=false, matrixAutoUpdate=false` on both output meshes. Iris Xe: safe — plain Mesh + MeshStandardMaterial cloned from GLB, no InstancedMesh+ShaderMaterial, no drei Text/Billboard, zero per-frame allocs, all geometry built in one useEffect pass. File: `apps/web/src/lib/three/activities/reef-race/ramps.tsx`. Wired: `<Ramps />` inside `<RiverScene />` (unchanged). Server-side: trigger volumes in `resolveRamps()` (spline-sim.ts step 5d) — AABB in tangent/normal basis, cooldown 500ms. Broadcasts `event.ramp_launch` on trigger. |

**Draw calls added (atmosphere + props, iter-5):** 1 (water shader) + 1 (rocky banks) + 1 (terrain ground shader) + 1 (dome) + up to 6 (scenery types) + 1 (finish gate) + ~9+9 (marker poles+flags) + 6 (power-ups) + 5 (`<RacingKarts />`) + 1 (bridge) + **2 (GLB ramp asset, SPEC 3 2026-04-30 — was 6 wedges)** ≤ 43 total.
**Tris added (iter-5):** water 126 + rocky cliff banks **1264** + terrain ground **12288** (PlaneGeometry 4000×24000, 32×192 segs — iter-5 narrow corridor) + dome ~1024 + scenery ~12000 (Quaternius trees: Pine 765 tris, Leafy 724 tris per instance × 16+14 spawns) + gate ~200 + markers ~162 + power-ups 72 + karts ~300 (5 × surfboard_1.glb) + bridge ~24 ≈ 27 660 tris total (within ≤80k budget).

**Iter-5 Y-coordinate cascade summary:**
- `WATER_Y`: -40 → **-200** (iter-6: 200wu deep dramatic ravine — visually dramatic from player POV)
- River bed: position-y **-250** (50wu below water surface; rocky banks v4 toe-in at y=-250)
- Ground/grass: y=0 (unchanged); terrain plane at y=-1 (no z-fight)
- `BRIDGE_H`: 10 → **80** (iter-6: bridge floor y=+80; 280wu clearance over water — dramatic over-canyon)
- Power-up Y: auto-cascade via `WATER_Y + 30 + 15 = -200 + 45 = **-155**` (float above water)
- Sand ribbon: **REMOVED** (cliff banks replace its visual role, unchanged)
- `racing-karts.tsx` `WATER_Y` cascade **complete** — value is **-200** (verified iter-6). Karts ride at y≈-195±4wu.
- **Rocky banks profile (iter-6):** PROFILE_Y [+30,0,-180,-220,-250]; PROFILE_D_OFFSET v3 -60→-100, v4 -30→-50
- **Camera presets (iter-6):** cinematic altitude 60→150, target y -35→-100, orbit radius 700→1200; side-on target y 0→-50

**Iris Xe invariants:** Plain ShaderMaterial only on plain Mesh (NOT InstancedMesh). No point lights for power-ups (emissive only). No drei Text/Billboard. All geo/mat at module scope. `frustumCulled=false` on atmosphere meshes.

**Prop paths (placeholders — GLBs generated by blender07 agent):**
```
/models/reef-race/scenery/prop-tree-pine.glb
/models/reef-race/scenery/prop-tree-leafy.glb
/models/reef-race/scenery/prop-rock-1.glb
/models/reef-race/scenery/prop-rock-2.glb
/models/reef-race/scenery/prop-fence.glb
/models/reef-race/scenery/prop-grass-tuft.glb
```

#### Checkpoints

- 12 gates total (11 green + 1 gold finish line).
- Each gate: 2 `CylinderGeometry` pillars + 1 `BoxGeometry` bar.
- Merged by material: 2 draw calls total (green `MeshStandardMaterial`, gold `MeshStandardMaterial`).
- `matrixAutoUpdate=false` — static after mount.

#### Start Grid + Gantry + Flags

- 8 start pads: `InstancedMesh(BoxGeometry, MeshStandardMaterial, 8)` — 1 draw call.
- Countdown gantry: crossbar + 3 `SphereGeometry` bulbs. Phase-driven `emissive` toggle (off→red→green).
- Finish flags: 2 `PlaneGeometry` planes on masts. `MeshBasicMaterial` (plain `'three'` import — WebGLRenderer compatible). TSL vertex wave removed (WebGPURenderer only). Static checkered planes.
- Canvas-generated checkerboard texture (64×64, created once at module scope).

#### `<RacingKarts>` — Animated Demo Karts (2026-04-29)

New file: `apps/web/src/lib/three/activities/reef-race/racing-karts.tsx`

5 surfboard_1.glb clones riding the centripetal Catmull-Rom v2 spline. Replaces the previous 4 static karts placed at t=0/0.25/0.5/0.75.

| Parameter | Value |
|---|---|
| Count | 5 karts |
| Asset | `surfboard_1.glb` — one `useGLTF` call, `scene.clone(true)` per kart |
| Starting t-values | `[0.0, 0.18, 0.36, 0.54, 0.72]` (spread across spline) |
| Speed (base) | 700 wu/s → `t/s = 700 / totalArcLength`. Multipliers: `[0.95, 1.0, 1.05, 0.97, 1.02]` — natural spread/grouping |
| Lateral offsets | `[-150, -75, 0, 75, 150]` wu from centerline (normal axis) |
| Colors | cyan `#4ec5e8`, gold `#ffd700`, coral `#ff5e3a`, green `#7cb342`, purple `#a96cfd` |
| Y position | `WATER_Y(-200) + KART_Y_ABOVE_TRACK(5) + sin(elapsed*1.5 + i*0.7)*4` — gentle bob at y≈-195±4wu. racing-karts.tsx `WATER_Y` cascade complete (iter-6, verified 2026-04-29). |
| Yaw | `atan2(tan.x, tan.z)` — face direction of travel |
| Banking | Finite-difference curvature: `cross = tan.x*tanNext.z - tan.z*tanNext.x`; `bank = clamp(cross*60, ±0.4 rad)` |
| Draw calls | 5 (one per clone) — net +1 vs previous 4 static karts |
| Iris Xe | No ShaderMaterial, no InstancedMesh+ShaderMaterial, no drei Text/Billboard. Pure GLB clone + `MeshStandardMaterial.color` tint. |
| Performance | `matrixAutoUpdate=false`, `updateMatrix()` after each transform. `frustumCulled=false` on all clones. All management in one `useEffect` keyed on `srcScene`. |

**Wired (iter-5):** `<RacingKarts />` is now imported and rendered inside `RiverScene()` in `river-scene.tsx`. Replaced the `{/* Surfboard karts wired in via <RacingKarts /> ... */}` placeholder comment with the actual JSX element.

#### Player Karts

- Primary GLB: `sea_horse.glb` (verified present in `apps/web/public/models/`).
- Fallback: `lobster.glb` (if seahorse fails to load — not triggered in testing).
- Clone via `SkeletonUtils.clone()` + `frustumCulled=false` traverse immediately after.
- Procedural swimming animation: bone oscillation via `bone.rotation.z = Math.sin(t*freq)*amp` on spine/tail bones.
- Per-player color tint: `material.clone()` + `.color.setStyle()` on `MeshStandardMaterial` children.
- Max simultaneous: 8.

#### Ghost Kart

- 1 ghost maximum (own personal best only — Iris Xe budget constraint).
- `sea_horse.glb` clone with `material.transparent=true, opacity=0.45` on all mesh children.
- Path stored in `useActivityStore.reefRace.selfBestGhostPath` (GhostFrame[] at 10Hz).
- Linear interpolation between frames in `useFrame`.
- `frustumCulled=false` (SkinnedMesh gotcha).
- `drei <Html>` "GHOST" label above kart — DOM overlay, safe on Iris Xe. No `distanceFactor`.

#### Pickup Boxes

- 16 boxes pre-allocated as `InstancedMesh(BoxGeometry(60,60,60), MeshStandardMaterial, 16)` — 1 draw call.
- Canvas-generated `?` texture (64×64 yellow/orange + teal border). Created once at module scope.
- Collected boxes: `mesh.setMatrixAt(i, zeroScaleMatrix)` — invisible, still rendered.
- Slow spin: `mesh.rotation.y += delta * 0.8` — 1 mutation, not per-instance.

#### Boost FX

- Trail: pre-allocated `BufferGeometry` ring buffer (30 points × 2 ribbon verts). `MeshBasicMaterial` (plain `'three'`). 1 draw call.
- Speed cones: `InstancedMesh(CylinderGeometry, MeshBasicMaterial, 12)`. Constant opacity 0.5 (TSL `opacityNode` strobe removed — WebGPURenderer only). 1 draw call. Visible only during boost.

#### Fog + Lighting

| Parameter | Value |
|---|---|
| Fog color | `#0d2b5e` (tropical ocean blue) |
| Fog near | 2000wu (bumped 1200→2000 2026-04-26; props/karts stay crisp at racing distance) |
| Fog far | 4500wu (bumped 2700→4500 2026-04-26; far-side karts visible; ≤ CAMERA_FAR=5000 ✓) |
| Track/guardrail fog | `fog=false` — racing surface always fully visible regardless of fog distance (2026-04-26) |
| HemisphereLight sky | `#87ceeb`, intensity 0.5 |
| HemisphereLight ground | `#0d2b5e` |
| DirectionalLight | `#fffbe6`, intensity 1.2, position (300, 800, 200) |
| Shadow map | 512×512, camera bounds ±4000wu (bumped 3000→4000 2026-04-26 to cover full ellipse diagonal) |
| Post-processing | None (forbidden on Iris Xe) |

#### Performance Budget

| Metric | Value |
|---|---|
| Draw calls | ≤70 (incl. ~20 shadow depth pass) |
| Triangles | ≤220k |
| Simultaneous SkinnedMesh anims | 8 players + 1 ghost |
| Shadow maps | 1 × 512² |
| Post-processing | 0 |

#### Store Extension (additive, chunk #6)

`apps/web/src/stores/activity.ts` extended with `reefRace: ReefRaceState`:
```ts
interface ReefRaceState {
  laps: Map<string, RaceEntityLap[]>;
  selfBestGhostPath: GhostFrame[] | null;
}
```
`pushLap()` action populates on `event.lap_completed`. `setGhostPath()` stores best-lap replay.
Bumper Shells consumers unaffected — `reefRace` field is additive.

#### File Layout

```
apps/web/src/lib/three/activities/reef-race/
  ReefRaceScene.tsx         — Root Canvas + chase-cam + PreCompilePipelines
  ReefRaceTrack.tsx         — Flat ribbon track (server-ellipse coords) + merged guardrails + 3× coral InstancedMesh
  ReefRaceCheckpoints.tsx   — 12 gates merged → 2 draw calls (green + gold)
  ReefRaceStartGrid.tsx     — Start pads (InstancedMesh) + gantry + static checkered flags (MeshBasicMaterial)
  ReefRacePlayer.tsx        — Single kart (sea_horse.glb clone + procedural swim anim)
  ReefRaceGhost.tsx         — Semi-transparent ghost kart (own best path, max 1)
  ReefRacePickups.tsx       — 16 InstancedMesh pickup boxes + Canvas '?' texture
  ReefRaceBoostFX.tsx       — BufferGeometry trail + 12 cone InstancedMesh speed lines
  reef-race-config.ts       — All constants (track path, camera, fog, light, pickup, boost)
  reef-race-types.ts        — TypeScript interfaces for scene-side state

apps/web/src/components/game/
  reef-race-hud.tsx         — Minimal HUD (lap counter + position + power-up bar)
                              Full polish deferred to chunk #8
```

**Note:** `sea_horse.glb` confirmed present at `apps/web/public/models/sea_horse.glb`. No GLB substitution needed.

## §11. Agent Picker Scene — SelectAgentCanvas (updated 2026-04-23)

**File:** `apps/web/src/components/three/SelectAgentCanvas.tsx`
**Route:** `/create-agent` (full-page 3D backdrop, not the in-game world)
**Renderer:** Plain `WebGLRenderer` via R3F Canvas default (`gl={{ antialias: true, preserveDrawingBuffer: true }}`). `preserveDrawingBuffer` is required for `toDataURL()` thumbnail capture.

### Material constraint — NO three/webgpu or TSL in this file

As of 2026-04-23, all TSL NodeMaterials were removed from `SelectAgentCanvas.tsx`. Root cause: the picker Canvas uses a plain WebGLRenderer while other modules (`underwater-atmosphere.tsx`, `underwater-light-rays.tsx`) import from `three/webgpu`. When both are bundled together, webpack resolves `three/webgpu` and `three` as two separate module instances. `MeshBasicNodeMaterial` from the `three/webgpu` instance has `vertexShader = undefined`; when the plain WebGLRenderer's `WebGLPrograms.acquireProgram()` calls `.replace()` on it, a per-frame `TypeError: Cannot read properties of undefined (reading 'replace')` crash floods the console and breaks VRM loading.

**Rule:** do NOT import `three/webgpu` or `three/tsl` in `SelectAgentCanvas.tsx`. All materials in this file must be from plain `three`.

### Scene objects

| Object | Type | Material | Notes |
|--------|------|----------|-------|
| Platform disc | `CylinderGeometry(12, 14, 1.5, 32)` | `MeshStandardMaterial` (0x0d2a40) | Rotates 0.3 rad/s via `RotatingPlatform` |
| RuneCircle | `PlaneGeometry(22, 22)` flat disc | `MeshBasicMaterial(0x00ccff, opacity=0.4)` | Was animated TSL; now static. AdditiveBlending |
| Inner glow ring | `TorusGeometry(10, 0.15, 8, 48)` | `meshBasicMaterial(0x00ccff, opacity=0.3)` | Static, was always plain |
| Outer glow ring | `TorusGeometry(13, 0.1, 8, 48)` | `meshBasicMaterial(0x0088cc, opacity=0.15)` | Static, was always plain |
| SpotlightConeSelect | `CylinderGeometry(20, 0, 70, 24, 1, open)` | `MeshBasicMaterial(0x2db6ff, opacity=0.18)` | Was animated TSL; now static. BackSide |
| EmberParticles | 80-point `BufferGeometry` | `PointsMaterial(0xff7219, size=3.5)` | Was TSL upward-drift; now static |
| Model | VRM or GLB via `PlatformModel` | Per-asset (MToon for VRM, `applyColorTint` for GLB) | |

**Dropped effects (2026-04-23):** `<UnderwaterAtmosphere />` and `<UnderwaterLightRays />` — both import `three/webgpu` internally; cannot be used in this Canvas. Do not re-add without first providing a plain-three replacement or migrating this Canvas to a separate bundle that can safely use `three/webgpu`.

### Camera

| Mode | minDistance | maxDistance | minPolar | maxPolar | target |
|------|-------------|-------------|----------|----------|--------|
| GLB (sea creatures) | 25 | 80 | π×0.28 | π×0.55 | [0, 8, 0] |
| VRM (Milady humanoids) | 24 | 75 | π×0.32 | π×0.52 | [0, 17, 0] |

Initial camera position: `[0, 16, 50]`, fov 45. OrbitControls with `enablePan=false`.

**Mobile-portrait fix (2026-04-24):** VRM target raised from `[0,14,0]` to `[0,17,0]` and camera start from `[0,12,45]` to `[0,16,50]`. The 2.1× scale multiplier (27.3wu) is retained — the crop on mobile was a camera-framing issue (viewport centered on waist), not a scale issue. Raising the target+camera lifts the viewport center to chest-level so portrait viewports frame head+torso rather than mid-thigh to shoes.

---

## §13. Cosmetic Render Pipeline (Phase 3.3 — 2026-04-28)

**File:** `apps/web/src/lib/three/cosmetic-loader.tsx`

The cosmetic engine renders equipped SKUs from `cosmetic_skus` / `cosmetic_variants` on top of the avatar mesh. The component is scope-aware and context-aware — it only renders cosmetics valid for the current scene.

### Component contract

```tsx
<CosmeticLoader
  avatarId={string}
  rigType={'milady-vrm' | 'lobster' | 'crab' | ...}
  context={'world' | 'activity:reef-race' | 'activity:bumper-shells'}
  parentObject={THREE.Object3D}  // avatar root or scene root
/>
```

Mount inside R3F Canvas as a sibling/child of the avatar component. `parentObject` must be the live Three.js Object3D.

### Scope / context compatibility matrix

| SKU scope | world | activity:reef-race | activity:bumper-shells |
|---|---|---|---|
| `world` | YES | NO | NO |
| `avatar` | YES | NO | NO |
| `activity:reef-race` | NO | YES | NO |
| `activity:bumper-shells` | NO | NO | YES |
| `all` | YES | YES | YES |

### Category render strategies

| Category | Strategy | Context gating |
|---|---|---|
| `hat` / `glasses` | GLB attached to head bone via bone anchor | world only |
| `aura` | GLSL ShaderMaterial fresnel sphere (NOT TSL — WebGLRenderer) | world only |
| `particle` | `emitParticles()` calls into existing particle pool | world only |
| `board` | GLB prop at player position, yOffset below feet | reef-race only |
| `palette` | Albedo texture swap on avatar body materials; skip MToon | world only |
| `outfit` | STUB — deferred to Phase 3 follow-up | — |

### Critical design decisions

**GLSL aura, not TSL:** The main world scene uses R3F's default Canvas → WebGLRenderer (`import * as THREE from 'three'`). NodeMaterial / MeshBasicNodeMaterial in that context causes a per-frame `.replace() on undefined` crash (gotcha: `two-three-instances-nodemat-webgl-crash.md`). Aura uses ShaderMaterial + raw GLSL. TSL files (`underwater-atmosphere.tsx`, `underwater-light-rays.tsx`) only work in the dedicated WebGPU activity canvases.

**Bone anchor frustumCulled=false:** All hat/glasses wrappers set `frustumCulled = false`. The T-pose bounding box doesn't cover the animated head position — without this, accessories disappear at close range / oblique angles (same bug as SkinnedMesh gotcha).

**Module-scope GLB cache:** `GLB_CACHE: Map<assetUrl, THREE.Group>` with `clone(true)` per consumer. One network fetch per asset per session. Cached base groups are never disposed.

**Aura geometry singleton:** `SphereGeometry(1, 20, 14)` created once at module scope, never disposed. Scaled per-instance via `mesh.scale.setScalar(radius)`.

**compileAsync:** Called on aura mesh immediately after `parentObject.add(mesh)` via feature-detect:
```ts
if (typeof (gl as any).compileAsync === 'function') {
  (gl as any).compileAsync(mesh, camera, scene).catch(console.warn);
}
```

**React Query:** `useEquippedCosmetics(avatarId, context, rigType)` — 30s staleTime + refetchInterval. Re-fetches propagate equip/unequip from the drawer without a full page reload.

### Draw call budget (maximum equipped set)

Assumes all 6 categories equipped simultaneously — pathological case:

| Category | Draw calls | Notes |
|---|---|---|
| Hat | 1–3 | Depends on GLB complexity |
| Glasses | 1–2 | Depends on GLB complexity |
| Aura | 1 | Single ShaderMaterial sphere |
| Particle | 0 | Uses existing pool (already budgeted) |
| Board | 1–3 | Surfboard GLBs are 1–2 draw calls each |
| Palette | 0 | Texture swap, no new draw calls |
| **Total overhead** | **≤9** | **Well within Iris Xe budget** |

### Bone name candidates (head bone lookup priority)

1. `J_Bip_C_Head` — VRM 0.x canonical
2. `mixamorigHead` — Mixamo (three.js sanitises the `:` separator away)
3. `mixamorig:Head` — Raw Mixamo (if loaded without name sanitisation)
4. `Head` — Standard glTF
5. `head` — Lowercase variant
6. `Bip001_Head` — 3DS Max Biped

### Asset location

Cosmetic GLBs live in `apps/web/public/cosmetics/`. Test bed: 4 surfboards at `apps/web/public/models/reef-race/surfboards/surfboard_[1-4].glb`.

### Exports

- `CosmeticLoader` (default + named) — main component
- `useEquippedCosmetics(avatarId, context, rigType)` — React Query hook
- `findBone(root, boneName)` — generic bone finder
- `OwnedCosmetic`, `OwnedCosmeticsResponse`, `CosmeticContext`, `CosmeticLoaderProps` — types

