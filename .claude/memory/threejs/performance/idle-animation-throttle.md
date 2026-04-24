---
title: Idle animation throttle — 20Hz for slow procedural animations
category: performance
tags: [useFrame, throttle, procedural-animation, NPC, sin, trig, CPU-bound]
date: 2026-04-23
confidence: high
threejs_version: r170+
---

## Summary

Throttle slow procedural idle animations to 20Hz using `(frame + seed) % 3 === 0` — imperceptible visually, saves ~40% trig ops for large NPC counts.

## Details

When a scene is CPU-bound (hiding 90% of geometry gives only +3 FPS), the bottleneck is per-frame JS work in useFrame hooks, not GPU draw calls.

**Pattern:** Idle animation functions that evaluate multiple Math.sin/cos calls at low frequencies (≤1.3 rad/s ≈ 0.21 Hz) can be safely throttled to 20Hz. Walk animations that use fast squash/stretch (8 rad/s bob cycle) need full 60Hz.

**Gate condition:**
```typescript
const frame = Math.floor(clock.elapsedTime * 60); // already computed for raycasts
if ((frame + seed) % 3 === 0) {
  applyIdleAnimation({ ... });
}
```

**Why `seed` matters:** Without stagger, all 12 location NPCs update on the same 3-frame slot → CPU spike every 50ms instead of smooth 1 NPC/frame spread.

**Applied in ClawVille:**
- `arena-location-npcs.tsx NpcMesh.useFrame`: `applyStationaryIdleAnimation` → 20Hz
- `arena-npcs.tsx GLBNpcMesh.useFrame`: `applyIdleAnimation` (idle state only) → 20Hz
- Walk `applyWalkAnimation` stays at 60Hz
- AnimationMixer (Pearl Krabs) stays at 60Hz (pose discontinuities if skipped)

**Cost math:** 12 location NPCs × 5 sin calls × 60fps = 3600 trig ops/sec → 1200/sec at 20Hz. Saves 2400 trig evaluations/second.

**Nyquist check:** animation max frequency = 1.3 rad/s. To avoid aliasing: sample > 2 × max_freq = 2.6 Hz. 20Hz provides 48× margin.

## Context

ClawVille 2026-04-23 perf iteration. CDP baseline was 26 FPS (CPU-bound confirmed by A/B: hiding 3186 meshes only +3 FPS). Applied after confirming the scene had no more cheap GPU wins.
