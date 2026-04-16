---
title: Building GLB pivot offset — geometry far from scene origin
category: gotcha
tags: [buildings, bounding-box, pivot, positioning, downtown-building]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
Some building GLBs (e.g. `downtown-building.glb`) are authored with their geometry
far from the scene pivot. When placed at a ring world position the building renders
at an entirely wrong location — potentially thousands of world units away.

## Details

### Symptom observed in ClawVille
CDP bbox scan of cron-hub (k=3, world assigned (1696, 544)):
- `cx = 5816` — the building rendered ~4120wu east of its grid slot
- `cy = 516` — correct Y (building was at correct height)
- `size = 637×800×555` — correct dimensions

The building was NOT mispositioned in BUILDING_MODELS. The GLB's geometry bbox
center in local space was at approximately `(5120/scale, ...)` rather than `(0,0,0)`.
When the group was placed at world (1696, 544), the geometry's centroid landed at
world (1696 + 4120, 544) = (5816, 544).

### Root cause
GLB exporter or art pipeline left the geometry uncentered relative to the scene root.
Three.js places the group at the target world position but the geometry vertex data
itself starts ~N units away from the pivot point.

### Fix
After `computeBuildingScale()`, extract the bbox CENTER in local scene space and
scale it to world space. Subtract these offsets from the target world position:

```ts
_buildBbox.getCenter(_buildCenter);
const pivotOffsetX = _buildCenter.x * scale;
const pivotOffsetZ = _buildCenter.z * scale;
// At call site:
position={[cx - pivotOffsetX, y, cz - pivotOffsetZ]}
```

`computeBuildingScale` was changed to return `{ scale, pivotOffsetX, pivotOffsetZ }`.
The `_buildBbox` is already populated by the traversal, so `getCenter` adds zero
extra traversal cost. `_buildCenter` is a module-scope `Vector3` to avoid GC.

### Why this is safe for well-centered GLBs
For models where geometry IS centered on the pivot (most buildings), `_buildCenter ≈ (0, ?, 0)`.
`pivotOffsetX ≈ 0`, `pivotOffsetZ ≈ 0` — the position is unaffected.
The Y component is intentionally not corrected (buildings sit on the sand floor; Y is
controlled separately via yOffset + terrain raycast).

## Context
Surfaced 2026-04-16 CDP scan: cron-hub at cx=5816 instead of ~1696.
Fix applied to both `GLBBuilding` (normal mode) and `EditableBuilding` (edit mode)
in `apps/web/src/lib/three/arena-buildings.tsx`.
