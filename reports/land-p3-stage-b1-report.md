# Codex Report — Land P3 Stage B1 Chunked Kit-Piece Render Layer

Date: 2026-08-07  
Branch: `feat/land-p3-kit`  
Frozen base: `c02b0d0eb652a1993f04a4e4d2eed20ffb1b227c`

## Outcome

Stage B1 is implemented in the requested worktree and left uncommitted. Every visitor now hydrates the public active-piece feed and can render placed kit pieces through 12 fixed, cached spatial chunks. Geometry is merged per `(chunk, pieceKey)` so each batch shares the piece GLB's authored cache-owned material and texture. Walking performs only chunk visibility work and never causes geometry rebuilds.

No `apps/api/**`, partner/Hatcher, `skill-protocol.ts`, `npc-simulation.ts`, Cove/activity, or `land-structures.tsx` implementation file was edited by this task.

## Files touched by this implementation

- `apps/web/src/lib/three/land-kit-assets.ts` (new): 12-key web asset map, grid-to-world transform, yaw/stack lift, and XZ/height normalization math.
- `apps/web/src/lib/three/land-kit-pieces.tsx` (new): public hydrator, fixed chunk definitions/bounds, cache-aware merges, culling, GLB failure isolation, disposal, and renderer stats.
- `apps/web/src/stores/land.ts`: `PlacedPiece`, `pieces: Map<parcelCode, PlacedPiece[]>`, and full-replacement setter.
- `apps/web/src/lib/land-query-keys.ts`: `LAND_PIECES_REFRESH_EVENT` and dispatcher for Stage B2 mutations.
- `apps/web/src/lib/api.ts`: typed public `GET /api/land/pieces/public` client call.
- `apps/web/src/components/three/World3DCanvas.tsx`: mounts `LandKitPieces` beside `LandStructures` under the same Suspense boundary.
- `packages/shared/src/constants/land-kit.ts`: feature-gate current reading now records that the B1 stats probe exists and staging capture remains pending.
- `3dStructure.md`: audited B1 architecture, approved textured-material divergence, draw/visibility budgets, and probe.
- `reports/land-p3-stage-b1-report.md`: this report. No explicit `-o` pathname was present in the supplied brief, so the repository's report directory was used.

The 12 GLBs under `apps/web/public/models/land-kit/` were already present when work began and were consumed without modification.

## Fixed chunk partition

Quadrants are deterministic origin-sign buckets in the order `X-/Z-`, `X+/Z-`, `X+/Z+`, `X-/Z+`; zero belongs to the positive side. Counts derive directly from the frozen 56-entry `LAND_PARCELS` array.

| Ring | X-/Z- | X+/Z- | X+/Z+ | X-/Z+ | Ring total |
| --- | ---: | ---: | ---: | ---: | ---: |
| founder | 3 | 2 | 3 | 2 | 10 |
| starter | 7 | 6 | 7 | 6 | 26 |
| c | 5 | 5 | 5 | 5 | 20 |
| **Total** | **15** | **13** | **15** | **13** | **56** |

`parcelCode -> chunk index` and each chunk's bounding sphere are computed once at module initialization. Spheres include parcel XZ extents plus the maximum three-stack/2.2-cell visual height.

## Merge and rebuild flow

1. `KitPieceHydrator` reads the public piece feed immediately, every 60 seconds, and on `LAND_PIECES_REFRESH_EVENT`. `/api/land/me` was inspected and does not return pieces, so no owner overlay was added, exactly as allowed by the brief.
2. The store replaces and groups the response by `parcelCode`; deleted or archived-feed-absent pieces cannot linger.
3. On Map identity change, the renderer sorts each chunk's rows into a deterministic content revision containing parcel, key, cell, yaw step, and stack level.
4. `React.memo` compares that revision. An identical 60-second response creates a new store Map but reuses every existing merged batch. A change rebuilds only batches in the affected fixed chunk; camera movement changes no revision or React state.
5. One Suspense + error-boundary source component exists per active `pieceKey`. It loads via `useGLTF(...extendLoaderWithMeshopt)`, applies WebGPU-safe geometry normalization, and skips that key entirely on load/source failure.
6. For each non-empty `(chunk, pieceKey)`, every placement clones the normalized source geometry, bakes parcel cell center, 45-degree yaw, uniform fit, XZ centering, bbox min-Y grounding, and stack lift into a matrix, then `mergeGeometries` creates one mesh.
7. The mesh shares the useGLTF-cache material without cloning/disposal. Its merged geometry is owned, `matrixAutoUpdate=false`, identity-updated, WebGPU-safe, tightly box/sphere bounded, and disposed on rebuild/unmount. Temporary placement clones and the owned normalized source geometry are also disposed.

The approved divergence from §2.3 is documented in the renderer header and `3dStructure.md`: textured authored GLBs require per-piece-key material batches, not the old three vertex-colour buckets. The visible hard ceiling is therefore 12 piece-key draws per visible chunk and 48 at the four-chunk cap, with empty pairs omitted.

## Exact per-frame work

The `useSceneFrame` callback allocates no objects and performs only:

1. Copy camera world position into a module-scope vector.
2. Update one module-scope view-projection matrix and frustum.
3. Clear a fixed 12-byte selection array.
4. Loop across 12 fixed chunk groups, set `visible=false`, and compute center distance squared only for groups with resident merged children.
5. Run at most four nearest-selection scans across the same 12 distances (maximum 48 comparisons).
6. Set `visible=true` only for selected chunks inside `5,000^2` world units whose precomputed sphere intersects the frustum. Every other resident chunk remains hidden.

No per-piece traversal, sorting, transform, geometry rebuild, React state update, `Text`, `Billboard`, `InstancedMesh`, or `ShaderMaterial` occurs per frame.

## Baseline probe and asset facts

When the existing stage probe flag/build exposes `window.__WORLD_STAGE_PROBE__`, B1 publishes and rebuild-updates:

```ts
window.__LAND_KIT_STATS__ = {
  chunksResident,
  mergedMeshes,
  trianglesBaked,
};
```

An independent GLTF Transform inspection verified all 12 supplied GLBs decode as exactly one primitive and one material. Their actual per-piece triangle counts range from 613 (`deck-plank`) to 2,079 (`statue-shell`), above §2.3's historical assumptions of 250 small / 900 large. B1 does not invent a new capacity policy beyond the frozen brief; the existing `land_kit_lv4_lv5_render_capacity` gate remains open until the exact staging/Iris Xe probe is captured.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Branch/base | PASS | `feat/land-p3-kit` at exact `c02b0d0e...` before edits |
| Required freshness attempt | PARTIAL/SAFE | `git pull --ff-only` fetched remotes but did not merge because the feature branch has no upstream; branch tracking was not changed |
| Strict web TypeScript | PASS | `bunx tsc --noEmit -p apps/web`, final run exit 0 in 22.6 s |
| Full root build | PASS | `bun run build`: 9/9 Turbo tasks successful; Next production compile and 34/34 static pages succeeded in 19.153 s |
| Grid/asset-map math smoke | PASS | 12 paths; founder cell 76 wu; stack level 3 -> Y 66; yaw step 7 -> `7π/4`; X/Z cell-center formula asserted |
| GLB structural inspection | PASS | 12/12 decode; each has 1 primitive and 1 material |
| Whitespace audit | PASS | no `git diff --check` errors; only the repository's existing LF-to-CRLF warnings |
| React quality review | PASS | expensive merges memoized by content revision, narrow Zustand selector, stable module constants/scratch, complete timer/listener/geometry cleanup, strict props/types |

The root Next build reports that its own type-validation phase is skipped by project configuration; the separate strict `tsc --noEmit` run is therefore the authoritative type gate.

## Deviations, pending evidence, and worktree isolation

- No implementation deviations from the frozen B1 requirements were made. The textured-material divergence was explicitly approved in the brief.
- No browser visual/Iris Xe staging capture was claimed. That is the named feature-gate metric still to collect.
- The requested output path was not included in the supplied prompt/environment, so this report uses `reports/land-p3-stage-b1-report.md`.
- The worktree contained pre-existing shell GLBs and `land-economy.ts` model-path edits. During this task, additional unrelated edits appeared in `GameFeatures.md`, `apps/api/src/services/skill-protocol.ts`, `packages/agent-templates/src/locations/town-guide.ts`, and `packages/shared/src/constants/orientation-skill.ts`. They were not made, reverted, staged, or otherwise altered by this implementation. The successful root build necessarily compiled the shared working tree as it existed at verification time.
- Nothing was committed or pushed.

## Final status block

**Implementation:** PASS  
**Strict web typecheck:** PASS  
**Full root build:** PASS  
**Commit/push:** NOT PERFORMED  
**Required follow-up:** capture `window.__LAND_KIT_STATS__` plus renderer stats on staging/Iris Xe before graduating `land_kit_lv4_lv5_render_capacity`.
