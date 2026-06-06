# ClawVille Perf — Remaining-Work Status (2026-06-06)

Closes the loop on the 2026-05-22 audit (`perf-audit-2026-05-22.md`) + phase-2 recon
(`perf-phase2-recon-2026-05-22.md`). Status verified against LIVE code in the
`feat/perf-cpu-framebudget` worktree by a 6-agent recon workflow + adversarial review,
then reconciled and executed by the orchestrator. Evidence = file:line in each row.

## Done this session (branch `feat/perf-cpu-framebudget`)

| Item | Commit | What |
|---|---|---|
| **CPU frame-budget — NPC per-frame shared cache** | `2b9f497e` | `arena-npcs.tsx getNpcFrameShared()` — one frame-epoch cache (keyed `clock.elapsedTime`) snapshots `controlMode` + camera pos once/frame; replaces ~36 `useGameStore.getState()` + 18 camera reads/frame (across ~18 GLB+VRM NPC useFrames) with 1 each. Subsumes the old per-NPC `_springLodCamPos`. Zero new allocs. |
| **CPU frame-budget — drop redundant spring matrixWorld flush** | `2b9f497e` | `vrm-character-animator.ts updateSpringOnly()` — removed the full-scene `scene.updateMatrixWorld(true)` after `springBoneManager.update()`. Verified vs `@pixiv/three-vrm-springbone@3.5.2` source: the manager flushes its own joint+descendant world matrices, and `updateMixerOnly` already did the full flush this frame. Saves a full-tree recompose across ~13 close VRMs/frame. |
| **SW precache — drop dead 1MB fetch** | (this session) | `sw.js` v6→v7: removed `underwater-decorations.glb` (~1MB) from install-time precache — its only consumer (`arena-terrain.tsx UnderwaterDecorationsGlb`) is un-rendered dead code (removed from the tree 2026-04-16). The SW fetched ~1MB on every install for nothing. Version bump evicts v6 caches on activate. |
| **W12b — bazaar-merchant-stand.glb recompress** | (this session) | `scripts/compress-glb-targeted.ts` (meshopt + WebP, backup + size-guard) → **2.34MB → 421K (-82%)** on a preloaded town prop (single 1.49MB baseColor PNG → 146K WebP). `?v=2` on all 3 refs (manifest + preload + useGLTF). Structurally re-validated (meshopt-decodes, 18,596 verts intact, only loader-supported extensions). Pixel-verify on staging pending. |
| **B1 — raw-PNG building recompress (6 live buildings)** | (this session) | Slot-aware compression (color → lossy WebP q92, normal/MR → **lossless** WebP; meshopt geometry). **arcade 4.20MB→734K (-83%), chum 1.83→1.48, krusty 1.50→0.98, squidward 1.24→1.04, patricks 1.22→0.95, cove 0.38→0.12** = **~5MB saved**. `?v=` bumped on all 3 ref surfaces (arena-buildings + manifest + sw.js); SW v7→v8. Each structurally re-validated (decode + mesh/tex counts intact; meshopt skips UV>1 tiling coords). Pixel-verify on staging pending. |
| **B2 — quest-bounty-pavilion.glb geometry meshopt** | (this session) | meshopt geometry + dedup/prune (textures already WebP → untouched via `formats:/png\|jpeg/` filter). **4.68MB → 2.11MB (-55%)**. `?v=2→?v=3` on all 4 refs. Validated: 26 meshes / 49,144 verts intact, 92→72 textures (dedup removed 20 dup refs). Pixel-verify on staging pending. |

## Already done before this session (verified in live code — no work)

| Win | Status | Evidence |
|---|---|---|
| W1 wire `preloadWorldAssets()` | done | `game/page.tsx:14,209`; `asset-preload-manifest.ts:253-297` (idempotency guard). Progress→bar chain intact (`World3DCanvas.tsx:53-61` → `sea-loading-screen.tsx:187`). |
| W3 NPC frustum culling | done | unconditional `group.visible=true` GONE; `applyFattenedFrustumCulling` (1.6× sphere fatten) re-enables built-in culler — `arena-npcs.tsx:515-522,1014-1022`, `vrm-loader.ts:90-92`, `arena-location-npcs.tsx:461`. |
| W7 fog.far = camera.far | done | both `10000` — `World3DCanvas.tsx:999,1386` (retightened from audit-era 15000/16000). |
| W8 MToon outline disable | done | `vrm-loader.ts:185-192` sets `outlineWidthMode='none'` for every parsed VRM (commit `04b4f06e`). Unconditional (full win on every GPU). |
| W11 building material dedup (Strategy 2A) | done | `scripts/dedup-buildings.mjs` ran (`f3d4bbfc`); `-opt1.glb` live: arcade 34→30, sandy 15→11, cove 5→4 (9 mats saved — the recon's ~47 estimate was optimistic; untextured arcade lambert/blinn have distinct colors so couldn't merge). |

## Intentionally NOT doing (reverted or premise gone)

| Win | Why |
|---|---|
| W2 instance pedestals | Pedestals **deleted entirely** 2026-05-21 (dark-plate regression) — `arena-buildings.tsx:1032-1039`. Zero pedestal draw calls remain; nothing to instance. |
| W5 lazy-load chibi VRMs | **Reverted** 2026-05-22 (`e3a45652`) — chibi VRMs are also wandering-NPC species; player-tier gating hid them as T-pose fallbacks for non-chibi players. `asset-preload-manifest.ts:135-153`. Re-doing requires gating on the wandering-roster species set, not the player avatar. |
| W6 NPC count cap on low-end | **Reverted by user** as "a bad fix" (`e3a45652`) — naive head-slice pops arbitrary NPCs (roster sorted by identity, not distance). This branch's design answers NPC cost via **per-frame reduction** (the shared cache + spring throttle + far-NPC mixer gate), NOT capping count. A distance-aware stable-key cap is the only acceptable form and is out of scope. |
| W10 gate camera controllers | The worthwhile gating already exists (WASD↔FPS ternary on `controlMode`, `World3DCanvas.tsx:963-967`). The 2 ungated controllers (ArrowKey, OrbitControls) are ungated for correctness (all-mode input) and already early-return on no-input. Audit rated impact "Minor" (sub-1-FPS). Net ROI ~0. |

## Scoped backlog

### B1 — Texture-compress the raw-PNG/JPG buildings — ✅ DONE this session
Implemented via slot-aware compression (color → lossy WebP q92, normal/MR → lossless WebP, meshopt geometry). 6 live buildings: arcade 4.20MB→734K, chum/krusty/squidward/patricks/cove. ~5MB saved. `?v=` bumped on all 3 ref surfaces; SW v7→v8. Each structurally re-validated. The normal-map artifact risk was handled by routing data maps to a lossless pass. **Pixel-verify on staging still required before this reaches users.**

### B2 — quest-bounty-pavilion.glb geometry meshopt — ✅ DONE this session
meshopt geometry + dedup/prune (textures left as-is via `formats:/png|jpeg/` filter). 4.68MB→2.11MB (-55%). `?v=3`. Validated 49,144 verts intact. **Pixel-verify on staging still required.**

### B3 — NPC intra-clone material merge — ❌ INVESTIGATED + RULED OUT (3da, 2026-06-06)
A `3da` specialist empirically inspected all 19 NPC GLBs. **Intra-clone same-material merge yields ZERO safe payoff for this roster:**
- **Wandering NPCs (`arena-npcs.tsx`):** all 0. lobster/crayfish/sweet_crab/lobster_plush/octopus = 1 primitive each (nothing to merge); hermitcrab = 5 prims but 5 DISTINCT skeletons (can't merge to one skinned mesh); jellyfish/seahorse = all-distinct materials.
- **Location NPCs (`arena-location-npcs.tsx`):** 9/11 = 0. The only two with same-material buckets — **squidward** (save 10) + **mr-krabs** (save 11) — have `skins:0` and animate via clip `"Take 001"` driving **12–15 non-mesh PARENT nodes** (Head/Neck/arms/legs/Body). Merging bakes bind-pose world matrices into vertices and removes the animated mesh nodes → freezes them into rigid statues = guaranteed visual regression. A partial "co-parented only" merge yields 0 groups on both.

`mergeStaticMeshesByMaterial` already correctly skips SkinnedMesh, but it's a static collapse with no concept of parent-node-TRS animation — applying it to squidward/mr-krabs is animation-destruction, not a skin-math risk.

**The only viable B3 win is cross-instance instancing of the STATIC single-mesh species** (lobster, crayfish, octopus, lobster_plush, plankton, mrs-puff, flying-dutchman) via `InstancedMesh`/`BatchedMesh` keyed by species GLB, with per-instance tint via `instanceColor` and bypassing `SkeletonUtils.clone` for them. Articulated GLBs need `InstancedSkinnedMesh`/texture-baked skinning (genuinely multi-day). Both require **staging pixel-verification** and are out of scope for a no-pixel-access session. Net FPS benefit is also uncertain on the CPU-bound Iris Xe target (this branch already addressed the CPU bottleneck via the hot-path commit).

### B4 — Pure hygiene (zero runtime perf — not a perf task)
- `git rm` 4 orphan GLBs the runtime never loads: `sandy-treedome-v2.glb` (zero refs), `chum-bucket.glb`/`krusty-krab.glb`/`patricks-rock.glb` (v1 — refs only in `scripts/compress-*.ts` + `inspect-broken-buildings.mjs` + ATTRIBUTION.md; superseded by `-v2-opt1`). Deleting also requires cleaning those dev-script entries. ~4.9MB build-artifact reclaim, no user-facing perf. Keep `guide-rigged.glb` + `shisha-oasis.glb` (both LIVE — the audit was wrong).
- Remove dead code `UnderwaterDecorationsGlb` + `FixedLandmarks` from `arena-terrain.tsx` (never rendered since 2026-04-16).

## Verification posture
- `next build` (web) is the real gate — `next.config.mjs:37 ignoreBuildErrors` means deploys do NOT typecheck. The worktree's `tsc` shows ~400 pre-existing errors from a dual `@types/three` (0.170 via `@pixiv/three-vrm` vs 0.182 app) — repo-wide, on master, not introduced here.
- All shipped changes built clean (exit 0) and the bazaar GLB was structurally re-validated. Pixel-level visual confirmation of the bazaar stall is best done on `staging.clawville.world` (the prop lives at world ~(-1273,450), hard to navigate locally).
