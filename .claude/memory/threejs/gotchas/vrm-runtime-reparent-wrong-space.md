---
title: Object3D.attach(headBone, hairMesh) puts hair in wrong transform space
category: gotcha
tags: [vrm, hair, headbone, attach, reparent, transform-space, walk-animation]
date: 2026-04-28
confidence: high
threejs_version: r182
---

## Summary

Calling `headBone.attach(hairMesh)` at runtime to make hair "follow" the head bone does not work for VRM Hairmodel. `Object3D.attach()` preserves world transform at the moment of reparent, but the head bone is animated, not statically transformed — the captured world position becomes wrong as soon as the head tilts. Result: every avatar's hair appears displaced from its skull during walk animation, often diagonally.

## Why this fails

`Object3D.attach(child)` on a moving target:
1. Reads the child's current world transform.
2. Reparents to `this` (which has its own current world transform).
3. Recomputes the child's local transform to PRESERVE its world transform at this instant.

For a static parent, this works fine — the child stays put visually. For an animated bone, the head bone's world transform is recomputed every frame from skinning matrices. The child (hair) is now in the bone's local space, but its TRS was calibrated against the bone's world transform AT THE INSTANT OF ATTACH. As the head tilts, the bone's world transform changes; the child rides along but with the wrong baseline. Visible result: hair offset from skull diagonally during walk.

## Why it seems like it should work

Three.js scene graph parenting under an animated bone DOES propagate the bone's animated world transform to children — for newly added children created in bone-local space. The trap is that `attach()` is for migrating EXISTING world-positioned objects under a new parent while preserving their look. It is the opposite of what hair-bone-following needs.

## What you'd want instead (and why it still doesn't work)

If you wanted hair to track the head bone, the runtime approach would be:
1. Compute hair vertices in the head bone's bind-pose local space at load.
2. Replace hair Mesh with a SkinnedMesh weighted to the head bone.

But this is exactly the asset-bake operation, and doing it at runtime in JS is fragile (vertex format conversion, IBM math, skin assignment) — it's better done offline. See `gotchas/vrm-spring-bone-bald-spot-at-scale.md` for the shipped asset-level fix (`scripts/bake-vrm-hair.mjs`).

## Code that DOES NOT WORK

```ts
// Don't do this in vrm-loader.ts
vrm.scene.traverse((obj) => {
  if (obj.name === 'Hairmodel' || obj.name === 'Sketchfab_model') {
    headBone.attach(obj); // WRONG — hair displaces during walk
  }
});
```

This was attempted as "Option A" in the bald-spot debug saga 2026-04-27 → 2026-04-28. Symptom: every Milady's hair landed in the wrong place at rest pose AND drifted further during walk. Reverted same session.

## Context

Reverted in commit `c0d1d91` (2026-04-28) with a warning comment block in vrm-loader.ts. The attempt was made specifically against Milady VRMs where `Hairmodel`, `Sketchfab_model`, and `Hatmodel` are plain Meshes parented to the Head scene node. The shipped fix is asset-level (`scripts/bake-vrm-hair.mjs` in commit `c2b7cd5`), not runtime.
