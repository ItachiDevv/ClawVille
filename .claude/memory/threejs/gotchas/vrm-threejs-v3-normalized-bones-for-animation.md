---
title: three-vrm v3 — AnimationMixer MUST target normalized bones, not raw bones
category: gotcha
tags: [vrm, three-vrm, animation, t-pose, mixamo, retarget, normalized-bones]
date: 2026-04-23
confidence: high
threejs_version: r182
---

## Summary
In @pixiv/three-vrm v3.x, Mixamo animation retargeting MUST target `getNormalizedBoneNode()`, NOT `getRawBoneNode()`. Using raw bones produces a permanent T-pose.

## Details

### How three-vrm v3 bone hierarchy works
Three-vrm v3 uses a dual-hierarchy model:
- **Raw bones**: the original bones from the GLB (e.g. `mixamorigHips`, `mixamorigSpine`). These are direct children of `vrm.scene`.
- **Normalized bones**: virtual helpers (`Normalized_mixamorigHips`, etc.) under a `VRMHumanoidRig` Object3D, which is also a child of `vrm.scene`.

The AnimationMixer MUST write to normalized bones. `vrm.update(delta)` (called after `mixer.update(delta)`) runs `humanoid.update()` which copies normalized pose → raw bones. The SkinnedMesh reads raw bones for vertex skinning.

### The bug
If `retargetMixamoClip()` uses `humanoid.getRawBoneNode('hips')` to get the track target, the retargeted track writes to `mixamorigHips.quaternion`. Then `vrm.update()` reads the normalized rest pose and overwrites `mixamorigHips` every frame — the mixer's writes are lost. Permanent T-pose.

### The fix
```typescript
// WRONG — getRawBoneNode is clobbered by vrm.update()
const node = humanoid.getRawBoneNode(boneName as any);

// CORRECT — getNormalizedBoneNode is what the mixer should drive
const node = humanoid.getNormalizedBoneNode(boneName as any);
```

Normalized bone names are `Normalized_mixamorigHips`, `Normalized_mixamorigSpine`, etc.
The retargeted track names become `Normalized_mixamorigHips.quaternion`.

### Why the mixer finds them
The AnimationMixer is created on `vrm.scene`. `VRMHumanoidRig` is a direct child of `vrm.scene`. `Normalized_mixamorigHips` is a child of `VRMHumanoidRig`. Three.js `getObjectByName()` traverses ALL descendants, so `vrm.scene.getObjectByName("Normalized_mixamorigHips")` finds it correctly.

### Verification
Before fix: all bone quaternions at exact identity (0, 0, 0, 1) even after vrm.update() — confirmed via CDP probe over 4s with no change.
After fix: normalized bones get animator writes, vrm.update() propagates to raw bones, SkinnedMesh deforms correctly.

### Versions where this matters
@pixiv/three-vrm v3.5.2 (ClawVille production). Likely all v3.x. May differ in v1.x/v2.x where the normalized hierarchy was introduced differently.

## Context
Surfaced 2026-04-23 when all 5 VRM Milady wandering NPCs (Miu, Kyoko, Vivi, Maple, Ash) were stuck in T-pose. CDP bone probe showed zero quaternion change over 4 seconds. Traced to `mixamo-retarget.ts` using `getRawBoneNode`. Fixed in `apps/web/src/lib/three/mixamo-retarget.ts`.
