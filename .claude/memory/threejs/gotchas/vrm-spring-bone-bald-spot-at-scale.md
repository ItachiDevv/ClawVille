---
title: VRM "bald spot" at high scale — NOT spring bones; static Hairmodel forward-tilt geometry gap
category: gotcha
tags: [vrm, milady, hair, bald-spot, hairmodel, walk-animation, head-bone, mixamo]
date: 2026-04-25
confidence: high
threejs_version: r170+
---

## Summary
After exhaustive CDP probing: these Milady VRMs have NO spring bone joints (springBoneManager.joints.size=0). The bald spot is caused by the Mixamo walk animation forward-tilting the head bone (up to -0.10 rad), which exposes the geometrically thin crown-back region (222 verts) of the static Hairmodel mesh to a rear-above camera. Fix: pre-tilt Hairmodel.rotation.x += 0.15 at load time.

## What the live numbers showed (2026-04-25 CDP probe, 300-frame walk sample)

- `vrm.springBoneManager.joints.size === 0` for ALL 5 Milady VRMs — no spring bones registered at all. Prior iterations tuning stiffness/dragForce were complete no-ops.
- `Hairmodel` is a static non-skinned Mesh parented directly to `mixamorigHead` (Bone). It tracks the head bone with `diff range = 0.07wu over 300 walking frames` — essentially zero lag.
- Body SkinnedMesh top vertices (scalp): 100% weighted to bone index 29 (`mixamorigHead`). No differential deformation between scalp and hair that could create a gap.
- Hairmodel geometry vertex Z range: `[-0.759, +0.759]` (symmetric). Hair color from texture: dark olive-green at all back vertices. NOT a geometry coverage or material issue.
- Walk animation: head bone Y oscillates `19–34wu` vertically. Head bone `rotation.x` range: `-0.10 to +0.007 rad` (forward tilt up to 5.8°).
- Crown-back geometry: only **222 verts** at `Z < -0.2 AND Y > 0.5` (sparse crown coverage vs 989 total back verts).
- Live test: `Hairmodel.rotation.x += 0.15` moves crown vertex `+1.94wu (UP)` and `-2.02wu (world Z toward rear-camera)`. This is the correct direction for coverage improvement.

## Root cause

The Mixamo walk animation forward-tilts the head bone up to 0.10 rad. When the head tilts forward, the crown (thin geometry region) is presented to the rear-above camera. The Hairmodel tilts with the head bone (rigid parenting) but its crown coverage is sparse. The scalp skin also tilts with the head (100% head bone weight), so there's no positional gap — it's a pure geometric coverage gap at the thin crown.

## Fix applied in vrm-loader.ts (after rotateVRM0)

```ts
vrm.scene.traverse((obj) => {
  if (!(obj as THREE.Mesh).isMesh) return;
  if ((obj as any).isSkinnedMesh) return;
  if (!obj.parent) return;
  if ((obj.name ?? '') === 'Hairmodel') {
    // Tilt hair crown upward/backward (+X = top toward -Z = back of head).
    // Measured: +0.15 rad moves crown +1.94wu up, -2.02wu toward rear camera.
    // Max walk tilt = 0.10 rad; pre-tilted 0.15 rad, net = 0.05 rad at peak.
    obj.rotation.x += 0.15;
  }
});
```

Applied once per VRM at load time; safe under VRM_CACHE @invariant.

## What did NOT work (iteration history)

- Iteration 1: stiffness ×80 — no-op (no spring joints), bald spot unchanged
- Iteration 2: stiffness ×120 + dragForce=0.9 — no-op (no spring joints)
- Iteration 3: stiffness ×30 + dragForce=0.7 — no-op (no spring joints)
- Counter-rotation by +π on Y axis — geometry is symmetric Z, would have no visible effect

## Key API facts

- `vrm.springBoneManager.joints` is a `Set<VRMSpringBoneJoint>` with getter on the prototype.
- `vrm.springBoneManager._joints` is the underlying private Set — check `.size` to confirm if spring bones exist.
- Milady VRM bone names include: `mixamorigHead`, `mixamorigNeck`, `mixamorigSpine`, `mixamorigSpine2`, `Normalized_*` variants.
- Static accessory meshes (`Hairmodel`, `Hatmodel`, glasses `Sketchfab_model` groups) are parented to raw Mixamo bones, NOT to skinned mesh bones. They're NOT affected by the VRM humanoid normalization pipeline.
- `Hairmodel.material.name = "Skin"` — shares same material+texture as `Body_36338mesh002`. This is the atlas texture with hair UVs mapped to a dark-colored region. NOT the bald spot cause.

## Context

`VRM_NPC_SCALE = 112`. 5 Milady NPCs in the world. All share same Hairmodel name and same root cause. Phase-related: VRM NPC wandering system, `arena-npcs.tsx`, `vrm-loader.ts`.
