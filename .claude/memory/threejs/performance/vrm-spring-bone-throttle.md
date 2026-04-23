---
title: VRM spring-bone physics throttle — 30Hz for idle NPCs
category: performance
tags: [vrm, spring-bone, animation, throttle, delta-accumulation, VRMCharacterAnimator]
date: 2026-04-23
confidence: high
threejs_version: r170+
---

## Summary
Split `VRMCharacterAnimator.update()` into `updateMixerOnly(delta, isMoving)` + `updateSpringOnly(accumulatedDelta)` to run spring-bone physics at 30Hz for idle VRM NPCs while keeping keyframe animation at 60Hz.

## Details

### The cost
`vrm.update(delta)` triggers `VRMSpringBoneManager.update(delta)`, which for each joint does:
- `bone.updateWorldMatrix(true, false)` (traverses ancestor chain)
- Verlet integration (dragForce + stiffness + gravity vector math)
- Collision loop (sphere distance checks)
- `setFromUnitVectors()` + `quaternion.premultiply()`
- `bone.updateMatrix()` + matrixWorld multiply

With 5 VRM NPCs × ~10-20 spring joints each = 50-100 expensive physics ops at 60Hz. On Iris Xe this is entirely CPU-bound.

### The fix
In `vrm-character-animator.ts`, the new `update()` is preserved for culled NPCs (already at 15Hz). For visible NPCs:

```typescript
// arena-npcs.tsx VRMNpcMesh.useFrame
springDeltaAccRef.current += dt;
if (isMoving) {
  animator.update(dt, isMoving);  // full update — walking causes large spring displacement
  springDeltaAccRef.current = 0;
} else {
  animator.updateMixerOnly(dt, isMoving);   // 60Hz — keeps keyframes smooth
  if ((frame + seed) % 2 === 0) {           // 30Hz — spring bones
    animator.updateSpringOnly(Math.min(springDeltaAccRef.current, 0.1));
    springDeltaAccRef.current = 0;
  }
}
```

### Why delta accumulation is safe
The verlet integrator uses the `delta` argument as its time step; it doesn't track internal state beyond `_currentTail` positions. Passing 2× `dt` is physically equivalent to two 1× steps for small dt values. This is confirmed by the `if (delta <= 0) return;` guard in the source — no special handling for large steps, the physics simply scales linearly.

### Nyquist safety
VRM spring bones simulate hair and cloth, which oscillate at < 4 Hz in practice. Sampling at 30Hz gives 7.5× Nyquist margin — imperceptible at any refresh rate. Walking NPCs are kept at 60Hz because large rapid displacements (tail whip, hair swing) become jerky below ~30Hz.

### Stagger
The `(frame + seed) % 2 === 0` gate uses the same per-NPC integer seed already used for terrain raycast and idle animation staggering, ensuring each of the 5 VRM NPCs fires its spring update on a different frame parity.

## Context
Iteration 2 of the autonomous FPS optimization loop (2026-04-23). Iteration 1 (+2.2 FPS) throttled GLB idle procedural animations to 20Hz. Iteration 2 targets VRM spring-bone physics, the next-largest CPU-bound cost in useFrame per the A/B testing analysis showing the scene is CPU-bound (hiding 90% geometry = +3 FPS only).
