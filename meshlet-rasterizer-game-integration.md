# Meshlet Rasterizer — `/game` Integration (Phase B)

**Status:** Plan v1 · 2026-05-24
**Owner:** the spike track (continuation of Phase A)
**Pre-requisite reading:** `apps/web/src/lib/three/experimental/nanite-rasterizer.ts`, `/preview/meshlet-spike-all-12` page, this session's spike journal in `.claude/projects/.../jsonl`.

---

## Headline

Phase A proved the Nanite-style WebGPU compute rasterizer renders all 11 ring buildings at **167 FPS on Iris Xe at full LOD 0** (vs `/game` baseline ~18 FPS = **~9× lift**) with all geometry visible. Now wire it into `/game` proper without breaking the existing Three.js render path.

---

## Architecture: layered canvases

`/game` today mounts ONE R3F `<Canvas>` inside `<div absolute inset-0>` that paints terrain + buildings + NPCs + player VRM + decorations into a single WebGPU/WebGL surface. The R3F render-clobber pattern (spike's session) proved that monkey-patching `renderer.render` to suppress R3F's end-of-frame call ALSO kills the rasterizer's own internal `renderer.render(hwScene)` and `quadMesh.render(renderer)` calls — there's no clean way to share one renderer between R3F and the bare rasterizer.

**Solution: two stacked `<canvas>` layers**, each with its own `WebGPURenderer`:

```
z-index 0  ─  bare canvas    : meshlet rasterizer renders 11 buildings only
z-index 1  ─  R3F canvas     : terrain + NPCs + VRMs + decorations + atmosphere
                              (background transparent so layer 0 shows through)
z-index 10+ ─ HUD / modals    : unchanged, plain DOM
```

Both canvases share the same camera state (from Zustand `useGameStore`). The R3F canvas owns the authoritative camera (existing camera-controls integration); the bare canvas reads it per-frame and rebuilds its own `PerspectiveCamera` for the rasterizer's compute.

---

## Feature gate

URL query `?meshlets=1` (no env var — opt-in per session, same pattern as the existing `?webgpu=1` override). Defaults OFF. Reasoning: shipping this disabled gives us a safe-to-ship blast radius while we iterate; users opt-in via URL until ready to flip the default.

```ts
const USE_MESHLET_BUILDINGS = typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('meshlets') === '1';
```

When ON:
- `<ArenaBuildings>` does NOT mount inside R3F's scene-graph
- `<MeshletBuildingsLayer>` mounts as sibling under the same `absolute inset-0` container

When OFF: standard Three.js path renders buildings (zero behavior change to current `/game`).

---

## Pre-requisite fixes (blocking Phase B)

### #34 — Missing geometry parts

User-observed in spike: some buildings (e.g. Mrs. Puffs boating school) render with walls missing. **Must be resolved before shipping into `/game`** — broken render in user-facing `/game` is worse than no render.

Diagnostic in flight (commit `e0b18534`): bumped `maxRasterSize: 16 → 4096` to force all triangles through SW raster. If walls appear → HW fallback is the bug. If still missing → SW path has a winding/edge issue.

Fix plan once diagnostic answers:
- **HW path bug:** trace `hwQueue` payload encoding; the merged-asset case may need a different `instanceIndex` field or vertex-pool offset.
- **SW winding issue:** check the barycentric edge-function sign convention; large triangles may flip orientation when their bounding box exceeds the SW path's clamping.

### Per-cluster LOD selection (optional but recommended)

Currently the spike forces `pixelErrorThreshold: 0` (LOD 0 for everything) to work around the per-instance LOD picker rendering 277 tris total at coarsest. This works at the spike's 11-building scale but won't scale to the full game scene (terrain, NPCs, more decorations later).

Real Nanite picks LOD per-cluster: each meshlet evaluates its own world-space bounding sphere → screen-space error → independent LOD level. Refactor surface: `computeFrustum` (lines 1109-1221 in `nanite-rasterizer.ts`) currently picks ONE `lodLevel` per instance then iterates that LOD's chunks; needs to iterate ALL clusters across ALL LODs and pick per-cluster.

For Phase B v1 we can ship with forced LOD 0 (proven 167 FPS on Iris Xe — well above /game baseline). Per-cluster LOD becomes Phase B v2.

---

## Implementation plan

### Step 1 — Extract spike's merged-asset loader into a reusable hook

`apps/web/src/lib/three/meshlet/use-merged-buildings-asset.ts`:
- Takes the same `BUILDINGS` manifest the spike uses (move it to `packages/shared/src/constants/`)
- Awaits all 11 GLB loads via `GLTFLoader` + `MeshoptDecoder` + `DRACOLoader` (same as spike)
- Applies per-building `computeBuildingScale` (1000wu target) → world matrix
- Calls `mergeGeometriesToMeshletAsset(...)`
- Returns `{ asset, loading, progress }`

This isolates load logic from canvas/render logic.

### Step 2 — `<MeshletBuildingsLayer>` component

`apps/web/src/components/three/MeshletBuildingsLayer.tsx`:
- Plain React component, NOT inside `<Canvas>`
- Owns: `<canvas ref={...} style={inset:0 z-index:0}>` + `WebGPURenderer` + `rAF` loop + `PerspectiveCamera`
- Reads camera state every frame from `useGameStore` (position, target, fov, near, far)
- Calls `rasterizer.render(camera, w, h)` per frame
- Cleanup: dispose renderer + rasterizer on unmount

Mirrors `/preview/meshlet-spike-all-12`'s `BareAll12Canvas` ≈ verbatim, just wired to game's camera state.

### Step 3 — Make R3F canvas's container `<div>` allow click-through to the bare layer

R3F canvas needs `style={{ background: 'transparent', pointerEvents: 'auto' }}` (or selective pointerEvents so click-to-move still works). Since the bare canvas is BELOW R3F's canvas, R3F's canvas captures all input (no change to input handling).

Bare canvas itself is `pointerEvents: 'none'` since it's pure rendering.

### Step 4 — Gate `<ArenaBuildings>` behind `USE_MESHLET_BUILDINGS`

In `World3DCanvas.tsx` (line ~801 area where `<ArenaBuildings />` and `<MergedSeaweed />` are rendered): conditional mount. When the meshlet path is on, `<ArenaBuildings>` doesn't render → R3F has less work → R3F FPS goes up too.

### Step 5 — Mount `<MeshletBuildingsLayer>` in `/game/page.tsx`

Inside the existing positioning container, before `<World3DCanvas>`:

```tsx
{USE_MESHLET_BUILDINGS && <MeshletBuildingsLayer />}
<World3DCanvas mode="game" />
```

### Step 6 — Camera state sync

R3F's camera updates flow through R3F's frame loop (camera-controls / orbit-controls). The bare canvas needs to read these positions BEFORE the R3F frame renders so both layers project the same world to the same screen positions.

Simplest sync: bare canvas reads `useGameStore.getState().camera*` fields each rAF tick. If the game store doesn't expose camera state, expose it via `cameraStateRef` written from inside R3F's camera-controls component (similar to how `avatarPositionRef` works in `stores/game.ts`).

Sub-frame jitter risk: R3F's camera may update mid-frame after the bare layer already snapshotted. For Phase B v1, accept 1-frame lag on bare layer (buildings won't visibly lag NPCs at 60+ FPS). For v2, drive both from the same rAF using a shared frame manager.

### Step 7 — Browser verification

After deploy:
- Open `/game?meshlets=1` in browser
- Verify: buildings visible, NPCs still visible, player VRM still walks, terrain still painted
- Check FPS HUD: expect 80-150 FPS on Iris Xe (vs ~18 baseline)
- Check NO console errors
- Toggle `?meshlets=0` (or remove): verify `/game` is byte-identical to current behavior

---

## Risks + open questions

1. **Z-fighting between layers** — R3F's terrain + the bare canvas's buildings both have depth values. If both layers do `depthTest`, the order matters. Mitigation: the bare layer renders ONLY buildings (which sit on terrain); since R3F's terrain is rendered DRAW-ORDER-FIRST (background), the bare layer's buildings always cover it. No z-fight unless transparent NPCs walk in front of buildings.

   Actual fix: ensure the bare canvas does NOT clear depth (only color → transparent background where no triangle hits), and ensure R3F's canvas DOES clear depth + color from its own framebuffer. Each canvas owns its own depth buffer; they composite via alpha in the browser. No conflict.

2. **VRMs in front of buildings** — VRMs are in R3F's canvas (layer 1, on top). They WILL composite over buildings even if standing behind a building in world-space. Mitigation: a depth-aware composite would require reading the bare canvas's depth buffer into R3F. Out of scope for v1; accept "VRMs always on top" as a Phase B v1 limitation; flag for Phase B v2.

3. **Iris Xe VRAM** — TWO WebGPU contexts means TWO copies of any shared resources (Three.js shader modules, texture-loader caches). Memory pressure unclear. Mitigation: measure before/after VRAM via Chrome `?memory=detailed` and pause Phase B if VRAM doubles dangerously.

4. **WebGL fallback** — `/game` currently has a WebGL fallback path (Iris Xe defaults to WebGPU but iOS Safari forces WebGL). The rasterizer is WebGPU-ONLY (no WebGL implementation). Mitigation: when `WEBGPU_ABSENT` is true, `MeshletBuildingsLayer` short-circuits to nothing and `<ArenaBuildings>` mounts as normal. Feature gate AND device gate.

5. **Building click handlers** — DROPPED PER USER 2026-05-24. We don't need building-click interactions in `/game` for the meshlet path. When `?meshlets=1` is active, building click handlers + tooltips simply do not exist. The portal-modal entry point will live elsewhere (Phase C). ArenaBuildings unmounts entirely.

6. **Collision** — VERIFIED 2026-05-24 NON-ISSUE. `world-colliders.ts` (line 248) builds AABB colliders from `buildingZones` in `tilemap-data.ts`, NOT from the 3D meshes. Removing `<ArenaBuildings>` from R3F's render does NOT break collision — players still can't walk through buildings.

---

## Out-of-scope for this plan

- Per-cluster LOD selection (tracked separately; Phase B v2)
- WebGL fallback rasterizer (won't ship — WebGPU-only feature)
- Other content types (NPCs, decorations) into the rasterizer (Phase C)
- Production default flip (Phase D — after metrics)

---

## Definition of done

- `/game?meshlets=1` renders all 11 buildings via the rasterizer
- All other `/game` features unchanged (movement, click, NPCs, chat, modals)
- Iris Xe FPS measured at game scene: **>= 60 FPS** (target 100+)
- Zero console errors
- `/game?meshlets=0` (default) byte-identical to today
- Plan + measurements committed to `docs/`
