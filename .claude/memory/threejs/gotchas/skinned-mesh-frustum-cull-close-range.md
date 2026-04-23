---
title: SkinnedMesh frustum culling causes disappear-at-close-range
category: gotcha
tags: [skinnedmesh, frustum-culling, glb, vrm, close-range, disappear, bounding-sphere]
date: 2026-04-23
confidence: high
threejs_version: r170+
---

## Summary

GLB and VRM SkinnedMesh bounding spheres are computed from the bind pose (T-pose). When the camera gets close or at a steep angle, Three.js culls the mesh because animated geometry extends past the bind-pose sphere. The character or NPC "disappears" when you walk close to them.

## Details

Three.js frustum culling uses `Object3D.frustumCulled = true` by default. For `SkinnedMesh`, the bounding sphere is derived from the skinned geometry in its **rest (T-pose) position**. During animation, limbs and body parts extend well outside this sphere. When the camera moves close to the character, the bind-pose sphere may fall partially or fully outside the frustum, causing Three.js to skip rendering the entire mesh.

**Symptoms:**
- NPC or player pet disappears when you walk directly toward them
- CDP probe shows `skinnedCulled > 0`
- The rig chain (parent walk) points back to the rigged character's root node

**Fix — apply at every clone site:**

```ts
const c = scene.clone(true);  // or SkeletonUtils.clone(scene)
// SkinnedMesh bounding spheres come from bind pose (T-pose); animated geometry
// extends past them, causing the character to disappear when camera is close/angled.
// Must be applied at every clone site — not just the first one you find.
c.traverse((obj) => { obj.frustumCulled = false; });
```

**Critical invariant:** This must be applied at **every single clone site** in the codebase that produces a SkinnedMesh-containing scene graph. Missing even one site will leave those characters culled.

## Sites patched as of 2026-04-23

| File | Clone method | Reason |
|---|---|---|
| `vrm-loader.ts` | VRM load pipeline | All VRM avatars |
| `arena-npcs.tsx` (`GLBNpcMesh`) | `scene.clone(true)` | Wandering GLB NPCs |
| `arena-location-npcs.tsx` | `scene.clone(true)` | Building residents (SpongeBob/Patrick/Squidward/Sandy etc.) |
| `player-pet.tsx` | `scene.clone(true)` | Player's own pet GLB |
| `quest-npc.tsx` | `scene.clone(true)` | Quest NPC (crayfish.glb) |
| `town-guide.tsx` | `SkeletonUtils.clone()` | Town guide (guide.glb) |
| `auction-podium.tsx` | `scene.clone(true)` | Floating jellyfish above auction podium |

## Context

- First discovered 2026-04-21: VRM NPCs disappeared at close range. Fixed in `vrm-loader.ts` and `arena-npcs.tsx`.
- Re-manifested 2026-04-23: CDP probe showed `skinnedCulled: 14` — all from building-resident rigs in `arena-location-npcs.tsx`. The fix had not been applied to that file or to `player-pet.tsx`, `quest-npc.tsx`, `town-guide.tsx`, `auction-podium.tsx`.
- The bug is subtle: every new clone site starts with `frustumCulled = true` (Three.js default) and must explicitly opt out. There is no global override.
- `arena-buildings.tsx` clones are static building geometry (no SkinnedMesh) — they do NOT need this fix.
- `arena-terrain.tsx` clones are static terrain meshes — they do NOT need this fix.

## Checklist for new rigged GLB clone sites

When adding a new component that clones a rigged GLB:
1. Does the GLB contain `SkinnedMesh`? (Yes for all humanoid/creature characters)
2. Immediately after `scene.clone(true)` or `SkeletonUtils.clone()`, add the traverse
3. Verify with CDP: `skinnedCulled` must be 0 after deploy
