---
title: Box3.setFromObject() inflates bbox on SkinnedMesh scenes
category: gotcha
tags: [skinned-mesh, bounding-box, normalization, scale, characters]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
`Box3.setFromObject(scene)` on a scene containing `SkinnedMesh` uses the bind-pose
world matrix for skinned nodes, which can inflate the bounding box far beyond the
visible rest-pose geometry — sometimes 60-100x.

## Details

### Root cause
Three.js `Box3.setFromObject()` traverses all children and expands the box using each
object's `matrixWorld`. For `SkinnedMesh`, the bind pose (the T-pose the skeleton was
rigged in) may extend far outside the rest-pose visual geometry. Concretely:
- A character whose bind pose has arms fully extended will have a bbox 2-3x wider
  than the resting/standing mesh
- A computer-screen character (Karen) whose bind-pose skeleton is essentially flat at
  y≈0 gives a near-zero Y bbox, causing `scale = TARGET / near-zero` to blow up to
  thousands — world height 1940 when targeting 32

### Symptoms observed in ClawVille
- Karen (karen.glb): world height 1940 at CHARACTER_HEIGHT=32 (expected 32)
- Larry (lobster_plush.glb): world height 331 at CHARACTER_HEIGHT=32 (expected 32)
- 8/10 location NPCs: world height 17-87 at CHARACTER_HEIGHT=32 (variable quality)

### Fix
Instead of `Box3.setFromObject(scene)`, traverse only non-SkinnedMesh nodes and
compute the bbox from each mesh's geometry bbox transformed by `mesh.matrixWorld`.

CRITICAL: when no non-skinned geometry is found (all-SkinnedMesh model), do NOT fall
back to `setFromObject`. That fallback uses bind-pose matrices, inflating min.y by
100-600x. The inflated min.y then enters the pivot-offset calculation:
`pivotOffsetY = localMinY * finalScale`. If localMinY = -600 and finalScale = 120,
pivotOffsetY = -72000, and `position.y = terrainY - (-72000) = 72000 wu skyward`.

Correct pattern:
```ts
scene.updateMatrixWorld(true);
const bbox = new THREE.Box3();
bbox.makeEmpty();

scene.traverse((child) => {
  if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const geoBB = mesh.geometry.boundingBox!;
    bbox.union(new THREE.Box3().copy(geoBB).applyMatrix4(mesh.matrixWorld));
  }
});

// All-SkinnedMesh model: return safe defaults (pivot at feet, scale ≈ 1.0 native)
if (bbox.isEmpty()) {
  return { scale: Math.min(CLAMP_MAX, TARGET_HEIGHT), localMinY: 0 };
}

const localMinY = bbox.min.y;  // ONLY from non-skinned bbox
const maxY = bbox.max.y;
const computed = TARGET_HEIGHT / (maxY > 0.001 ? maxY : 1.0);
// Unconditional hard cap — not a conditional fallback
const scale = Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, computed));
return { scale, localMinY };
```

Call `scene.updateMatrixWorld(true)` first — cloned scenes not yet in the live
scene graph haven't had `updateMatrixWorld` called by the renderer.

Use module-scope scratch objects for `meshBox` / temp vectors to avoid per-call GC.

### Sanity clamp — unconditional hard cap
The clamp must be `Math.max(MIN, Math.min(MAX, computed))` applied unconditionally,
NOT `if (outside range) { scale = TARGET }`. The latter sets scale to TARGET when the
bbox is inflated but leaves the corrupted localMinY intact, compounding the blowup.

### Where implemented in ClawVille
- `arena-location-npcs.tsx` — `computeNormalizedScale()`
- `arena-npcs.tsx` — `computeNpcScale()`
- `arena-buildings.tsx` — `computeBuildingScale()`

## Context
Surfaced during the 2026-04-16 scale regression audit. CDP bbox sweep revealed Karen at
1940 world units and Larry at 331 at CHARACTER_HEIGHT=32 — both caused by skinned mesh
bind-pose inflation. Initial fix (2026-04-16) excluded SkinnedMesh from traversal but
kept the `setFromObject` fallback — localMinY was still sourced from the inflated bbox.

Second-pass fix (commit 6f2fb8b, 2026-04-16): removed the `setFromObject` fallback
entirely. All-SkinnedMesh models (chihiro, priestess, chibi_goku) now get localMinY=0
and scale=TARGET unconditionally. This eliminated the 71999 / 28598 / 1422 outliers
seen in the CDP wandering NPC sweep.

### Third bug: tiny-accessory localMinY poisons pivot offset (2026-04-16)

A GLB where the body is SkinnedMesh but has a tiny non-skinned accessory (a coin,
a glass pixel) will have the non-skinned bbox path return with:
- `localMinY = -154` (accessory position in local space)
- `computed = 120 / 0.001 = 120000 → clamped to 240 (CLAMP_MAX)`

Then `pivotOffsetY = localMinY * scale = -154 * 240 = -36960`. In the frame loop:
`position.y = terrainY + 2 + bob - (-36960) = terrainY + 36962 wu` — NPC floats
at 37000 world units (the "floating submarine" in sky seen in CDP scan).

**Fix:** in the `computed > CLAMP_MAX → bind-pose fallback` branch, force `localMinY: 0`.
The accessory localMinY is irrelevant — we're using bind-pose for the scale, so
we must also zero out the pivot offset (which would have been derived from that
same accessory, not the character body).

This was the root cause of CDP scan showing `cy: +37087, sy: 75440` for wandering NPCs
group (NOT chihiro/priestess/chibi_goku — they were already fixed). The culprit was
likely hermitcrab.glb, octopus_toy.glb, or sea_horse.glb having a tiny non-skinned prop.

**Layer 2 safety net also added:** one-shot `useFrame` hard cap at 0.5s that measures
rendered height via `Box3.setFromObject(group)` and scales down `group.children[0]`
(the scale subgroup) if rendered height exceeds HARD_MAX (250 wu wandering / 300 wu
location). Module-scope `_renderedBbox` allocated once; `rescaleAppliedRef` prevents
re-firing.
