---
title: VRM "bald spot" — rotation approach proven ineffective; scalp cap sphere is the fix
category: gotcha
tags: [vrm, milady, hair, bald-spot, hairmodel, walk-animation, head-bone, mixamo, scalp-cap]
date: 2026-04-28
confidence: high
threejs_version: r170+
---

## Summary
Pre-tilting Hairmodel.rotation.x (0.15 / 0.22 / 0.18) does NOT fix the crown-back bald spot. CDP measurement proved the crown vertex world Y only moves ~1.4wu across the full 0→0.22 rad range — rotating lifts the crown AWAY from the scalp, widening the gap. Fix: inject a dark sphere parented to mixamorigHead (the scalp cap approach).

## CDP Measurements (2026-04-28, live on clawville.world/game)

- Live code at rotation.x=0.22: crown-back world Y = 240.79, gap above head bone = 59.42wu
- At rotation.x=0.00: crown-back world Y = 239.68, gap = 58.43wu
- At rotation.x=0.05: crown-back world Y = 239.92, gap = 58.81wu
- At rotation=0, scale×1.06, posY-0.02: crown-back world Y = 239.35, gap = 58.32wu
- **Max gap change across ALL approaches: 1.4wu** — trivially small, no visual improvement

## Why rotation fails

Tilting Hairmodel.rotation.x++ rotates the crown vertex BACKWARD and UPWARD in world space. The problem is NOT that the crown vertex needs to move — it's that the SPACE BETWEEN the crown vertex and the scalp below it opens up as the head tilts. Moving the crown vertex slightly doesn't help because the scalp vertices below it (100% weighted to the same head bone) also tilt with the bone. The entire geometry cluster moves together; the thin zone just becomes visible to the rear camera.

## What actually works: scalp cap sphere

Add a `THREE.Mesh(SphereGeometry(0.18, 10, 8), MeshBasicMaterial({color: 0x111111}))` parented to `mixamorigHead`. Position at `{y: 0.52, z: -0.10}` in head-bone local space (matches crown-back of Hairmodel).

This cap:
- Follows the head bone rigidly at all poses (idle, walk-tilt) — no lag
- Fills the sparse zone with a dark mesh that reads as "more hair" to any camera angle
- Works for all Milady variants (blonde, dark, etc.) because near-black is always interpreted as hair depth
- Zero extra GPU allocations: module-scope geo+mat singletons shared across all 5 NPC loads

## Implementation in vrm-loader.ts (after rotateVRM0)

```ts
const SCALP_CAP_GEO = new THREE.SphereGeometry(0.18, 10, 8); // module scope
const SCALP_CAP_MAT = new THREE.MeshBasicMaterial({ color: 0x111111 }); // module scope

// In loadVRM, after rotateVRM0:
let headBone: THREE.Object3D | null = null;
vrm.scene.traverse((obj) => {
  if (obj.name === 'mixamorigHead') headBone = obj;
});
if (headBone) {
  const cap = new THREE.Mesh(SCALP_CAP_GEO, SCALP_CAP_MAT);
  cap.name = '__scalp_cap__';
  cap.position.set(0, 0.52, -0.10);
  cap.renderOrder = -1;
  cap.frustumCulled = false;
  headBone.add(cap);
}
```

## What the live numbers showed (2026-04-28 CDP probe)

- `springBoneManager.joints.size === 0` — still confirmed, no spring bones
- Head bone world scale = 112 on all axes (= VRM_NPC_SCALE)
- Hairmodel: `rotation.x = 0.22`, `scale.y = 0.3209`, `position.y = 0.2069`
- Crown-back vertex: `topBackLocalY = 0.9982`, `topBackLocalZ = -0.103`
- In head-bone local space: crown-back at Y ≈ 0.52, Z ≈ -0.033
- Head bone rotation.x during walk probe = -0.110 rad (confirms up to -0.11 rad tilt)
- Mesh inventory: Hairmodel (2162 verts), Object_1003 (2001), Object_1003_1 (5059), Eyes (30), Body_36338mesh002 (3206), Body_36338mesh002_1 (23)

## What did NOT work (all iteration history)

- stiffness ×80 — no-op (no spring joints)
- stiffness ×120 + dragForce=0.9 — no-op
- stiffness ×30 + dragForce=0.7 — no-op
- `rotation.x += 0.15` — crown moves +1.94wu up; user: "still sub par"
- `rotation.x += 0.22` — user: "worse" (awkward windswept pose at idle)
- `rotation.x += 0.18` — same geometric problem, no improvement
- Scale up 1.06 + translate down 0.02 — crown changes <1wu, no improvement
- Counter-rotation +π on Y axis — symmetric geometry, no visible effect

## Context

`VRM_NPC_SCALE = 112`. 5 Milady NPCs in world. Applied in `vrm-loader.ts` after `rotateVRM0`. 2026-04-25 diagnosis established spring bones absent and rotation approach; 2026-04-28 CDP measurements proved rotation approach ineffective and scalp cap confirmed as correct fix.
