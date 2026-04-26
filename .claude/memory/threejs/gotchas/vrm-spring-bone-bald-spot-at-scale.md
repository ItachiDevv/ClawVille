---
title: VRM spring-bone "bald spot" at high scale — two independent problems (stiffness + inertia)
category: gotcha
tags: [vrm, spring-bone, scale, milady, hair, physics, arena-npcs, dragForce]
date: 2026-04-25
confidence: high
threejs_version: r170+
---

## Summary
At VRM_NPC_SCALE=112, hair lags behind body translation ("bald spot") due to TWO independent problems: (1) stiffness overwhelmed by world-space displacement, (2) inertia term carries forward old-world-position on every frame. Fix: stiffness × 120 AND dragForce SET to 0.9 for hair joints at load time in vrm-loader.ts.

## Details

### Verlet integrator (VRMSpringBoneJoint.update)
```
nextTail = currentTail
  + (currentTail - prevTail) * (1 - dragForce)   // inertia term
  + worldSpaceBoneAxis * stiffness * delta          // restoring force
  + gravityDir * gravityPower * delta               // gravity
```

### Problem 1 — Stiffness overwhelmed
At scale 112, body translates ~13–20wu/s. Default stiffness=1.0 → restoring force = 1.0 × 0.016 = 0.016wu/frame — overwhelmed. Fix: multiply stiffness × 120 for hair joints.

### Problem 2 — Inertia term locks tail to old world position (translation lag)
The inertia term carries forward `(1 - dragForce)` fraction of `(currentTail - prevTail)` — which is in WORLD SPACE. When the body translates δ wu/frame, prevTail is at the OLD world position. With default dragForce=0.4, that is 60% old-position carryover. Stiffness alone CANNOT fix this — it restores toward `boneAxisWorld` (natural rest direction), NOT toward the per-frame translation vector. Even infinite stiffness leaves hair 1–2 frames behind on translation.

Fix: SET (not multiply) `dragForce = 0.9` for hair joints. This gives only 10% inertia carryover → hair converges within 1–2 frames of body motion.

### Why stiffness goes to 120 (not 80)
dragForce=0.9 kills the momentum-assist that was keeping hair near the head during stationary oscillation. Adding 40 more stiffness compensates — restoring force now has enough punch to snap back within the same frame momentum assist disappears.

### Fix applied in vrm-loader.ts
```ts
if (vrm.springBoneManager) {
  const HAIR_STIFFNESS_SCALE  = 120; // world-scale compensation + compensates for momentum-assist loss
  const OTHER_STIFFNESS_SCALE = 20;  // skirt/tail unchanged
  const HAIR_DRAG_FORCE       = 0.9; // SET, not multiply — kills 90% inertia carryover
  for (const joint of vrm.springBoneManager.joints) {
    const boneName = joint.bone?.name ?? '';
    const isHair   = /hair/i.test(boneName);
    joint.settings.stiffness *= isHair ? HAIR_STIFFNESS_SCALE : OTHER_STIFFNESS_SCALE;
    if (isHair) joint.settings.dragForce = HAIR_DRAG_FORCE;
  }
}
```

### Hair joint detection
`/hair/i` regex. Milady VRM joint names confirmed: `J_Sec_Hair01`, `J_Sec_R_HairBack01_C`, `J_Sec_FrontHair_C` — all match.

### API facts
`vrm.springBoneManager.joints` is a `Set<VRMSpringBoneJoint>` (iterable with for-of).
Each joint: `.bone.name` (string), `.settings.stiffness` (number), `.settings.dragForce` (number, default 0.4).
Applied once at load; safe under VRM_CACHE @invariant.

### Key insight
**Stiffness fixes the spring returning to rest. dragForce fixes the translation lag.** They are independent levers. Cranking only stiffness (as was done with ×80) makes hair stiffer at rest but still 1–2 frames behind on body translation.

## Context
Phase 1 fix (2026-04-25): stiffness × 80 only — reduced bald spot but translation lag persisted.
Phase 2 fix (2026-04-25 same session): + dragForce SET 0.9, stiffness bumped to × 120.
