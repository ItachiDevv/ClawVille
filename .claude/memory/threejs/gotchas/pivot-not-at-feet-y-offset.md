---
title: GLB pivot not at feet causes characters to render underground
category: gotcha
tags: [glb, pivot, bounding-box, terrain, y-offset, characters, anime, humanoid]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
When a GLB model's root pivot is at the torso, center-of-mass, or any point above the
feet, placing the group at `terrainY + offset` causes the feet (and lower body) to extend
underground by `|localMinY| * scale` world units.

## Details

### Root cause
Three.js scene placement sets `group.position.y` which is the Y coordinate of the
**group's local origin** — i.e., wherever the GLB's internal pivot is. If the pivot is
at waist height, the entire lower half of the model appears below ground.

This is distinct from the SkinnedMesh bbox inflation bug — it affects ALL mesh types
(regular, skinned) and is purely a matter of where the artist placed the pivot when
authoring the GLB.

### Observed in ClawVille
Screenshot showed purple anime character (chihiro or priestess) rendered underground
with only the head/torso visible above the sand floor. Silhouette: sitting cross-legged,
robed figure — consistent with `young_priestess.glb` or `spirited_away_senchihiro.glb`.

All Hermes-category anime GLBs (`chihiro`, `priestess`, `chibi_goku`) are high-risk
because they are typically modelled with the pivot at center-of-mass or waist, not feet.
Sea creature / crustacean GLBs are usually fine (modelled with pivot at base).

### Symptom
- Character visible from torso up, lower body underground
- No error in console (Three.js does not validate pivot placement)
- The bug is scale-dependent: at scale=1 the offset is tiny (~0.5 units); at scale=50
  the same offset becomes 25+ world units underground

### Fix
After computing final scale (via `computeNormalizedScale` or any method), measure the
local-space bbox min.y of the cloned scene using the same SkinnedMesh-excluded traverse.
Multiply by final scale → world-space pivot offset. Subtract from Y position each frame:

```ts
// In useMemo (once per mount, not per frame):
const localMinY = computeLocalMinY(clonedScene);   // bbox min.y at scale=1
const pivotOffsetY = localMinY * finalScale;        // world units below group origin

// In useFrame (every frame):
group.position.y = terrainY + BASE_LIFT + bob - pivotOffsetY;
// pivotOffsetY < 0 → subtracting a negative = raising the model (fixes underground issue)
// pivotOffsetY = 0 → no change (pivot already at feet)
// pivotOffsetY > 0 → lowered slightly (pivot was below feet, model was floating)
```

`computeLocalMinY` reuses the same SkinnedMesh-excluded traverse from the skinned-mesh
bbox inflation fix — see `gotchas/skinned-mesh-bbox-inflation.md`. Use module-scope
scratch `Box3` objects to avoid GC in the useMemo hot path.

### Where implemented in ClawVille
- `arena-location-npcs.tsx` — `computeNormalizedScale()` now returns `{ scale, localMinY }`;
  `pivotOffsetY` computed in per-NPC `useMemo`, applied in `useFrame`
- `arena-npcs.tsx` — `computeLocalMinY()` helper added; `pivotOffsetY` computed in per-NPC
  `useMemo` alongside clone+tint, applied in `useFrame`
- `player-pet.tsx` — same `computeLocalMinY()` helper; `pivotOffsetY` computed in `useMemo`,
  applied in `useFrame`

### Expected per-species pivot offsets (at their respective scales)
Values are approximate — the exact number depends on GLB authoring:
- `lobster`, `crayfish` (crustacean) — localMinY ≈ 0, negligible offset
- `sweet_crab`, `hermitcrab` — localMinY likely ≈ 0 to -0.1
- `chihiro`, `priestess`, `chibi_goku` (humanoid anime) — localMinY likely -0.5 to -1.5
  (pivot at waist/torso → feet extend 25-75 world units underground at NPC_SCALE=50)
- `jellyfish`, `octopus`, `seahorse` — variable, depends on artist choice

### Design note
The BASE_LIFT constant (6 for location NPCs, 2 for wandering NPCs, 2 for player pet)
provides a small hover gap above terrain. This remains correct after the pivot correction —
it lifts the bottom of the model slightly above terrain so the character doesn't clip into
sand dune geometry. The pivot correction brings the feet to terrainY; BASE_LIFT adds a
small hover above that.

## Context
Surfaced 2026-04-16 during post-scale-fix verification. A purple anime character (priestess
or chihiro) was rendering underground after `NPC_SCALE` was bumped from 13 to 50. At
scale=13 the offset was ~6-20 units (partially masked by BASE_LIFT=2); at scale=50 the
same localMinY produces ~35-75 units underground, making the issue obvious.
