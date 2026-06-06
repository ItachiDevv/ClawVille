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

## Scoped backlog (real wins, but risk/effort warrants a dedicated, verified pass)

### B1 — Texture-compress the raw-PNG/JPG buildings (extends W12b)
- **What:** the live `-opt1` buildings still serve RAW PNG/JPG (the dedup pass did NOT compress textures). Biggest: `claw-arcade-exterior-opt1.glb` (1.54MB + 900K PNGs), `squidward-house-opt1` / `patricks-rock-v2-opt1` (~700K normal maps), `chum-bucket-v2-opt1`, `krusty-krab-v2-opt1`, `cove-exterior-opt1`.
- **Win:** several MB across the live building roster.
- **Risk (why deferred):** (1) **normal maps** — lossy WebP on normal maps causes lighting/shading artifacts; needs `--lossless` or per-texture-type handling, not the blanket pipeline. (2) **Live-roster blast radius** — a regression breaks core buildings. (3) Must browser-QC every building on Iris Xe.
- **Command (per file, after handling normal maps):** `bun run scripts/compress-glb-targeted.ts apps/web/public/models/<file>-opt1.glb` then bump `?v=` on every ref in `arena-buildings.tsx` + `asset-preload-manifest.ts` + `sw.js` precache.

### B2 — quest-bounty-pavilion.glb geometry meshopt (W4 remainder)
- **What:** already 8.7MB→4.68MB via texture-resize (`9ebbad6b`), 92 WebP images, but geometry is **uncompressed** (no meshopt/Draco).
- **Win:** ~10–25% of 4.68MB (geometry meshopt) and/or KTX2 for GPU-memory (not wire) savings.
- **Risk:** medium; run `compress-glb-targeted.ts` (skip-if-larger guards), bump `?v=2`→`?v=3`, browser-verify pavilion on Iris Xe.

### B3 — NPC intra-clone material merge / cross-instance instancing (W12a)
- **What:** 11 location NPCs + 18 wandering NPCs each `SkeletonUtils.clone()` with NO merge/instancing (`arena-npcs.tsx:510`, `arena-location-npcs.tsx:454`). `mergeStaticMeshesByMaterial` is buildings-only.
- **Win:** large draw-call reduction (the dominant GPU cost after CPU).
- **Risk (why deferred — multi-day 3da team):** `mergeStaticMeshesByMaterial` is STATIC-mesh-only; running it on SkinnedMesh can break skeleton bindings (the exact bug class `arena-npcs.tsx:503-509` warns about). True cross-instance skinned instancing needs `InstancedSkinnedMesh`/texture-baked skinning. Per-character T-pose/deform QC required. Iris Xe: `InstancedMesh+ShaderMaterial` banned.

### B4 — Pure hygiene (zero runtime perf — not a perf task)
- `git rm` 4 orphan GLBs the runtime never loads: `sandy-treedome-v2.glb` (zero refs), `chum-bucket.glb`/`krusty-krab.glb`/`patricks-rock.glb` (v1 — refs only in `scripts/compress-*.ts` + `inspect-broken-buildings.mjs` + ATTRIBUTION.md; superseded by `-v2-opt1`). Deleting also requires cleaning those dev-script entries. ~4.9MB build-artifact reclaim, no user-facing perf. Keep `guide-rigged.glb` + `shisha-oasis.glb` (both LIVE — the audit was wrong).
- Remove dead code `UnderwaterDecorationsGlb` + `FixedLandmarks` from `arena-terrain.tsx` (never rendered since 2026-04-16).

## Verification posture
- `next build` (web) is the real gate — `next.config.mjs:37 ignoreBuildErrors` means deploys do NOT typecheck. The worktree's `tsc` shows ~400 pre-existing errors from a dual `@types/three` (0.170 via `@pixiv/three-vrm` vs 0.182 app) — repo-wide, on master, not introduced here.
- All shipped changes built clean (exit 0) and the bazaar GLB was structurally re-validated. Pixel-level visual confirmation of the bazaar stall is best done on `staging.clawville.world` (the prop lives at world ~(-1273,450), hard to navigate locally).
