---
title: VRM half-rate early-return gate kills mixer at mid-distance
category: gotcha
tags: [vrm, animation, mixer, performance, throttle, early-return]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary
An early-return gate meant to throttle spring-bone updates accidentally kills the entire useFrame including the mixer update, halving keyframe frame rate at mid-distance.

## Details
Pattern that looks reasonable but is broken:
```ts
if (camDistSq > HALF_RATE_DIST_SQ && (frame + seed) % 2 !== 0) {
  return; // WRONG: also kills mixer.update below
}
// ...
animator.updateMixerOnly(dt, isMoving); // never runs on odd mid-dist frames
```

The early-return is placed above the animator call, so the mixer only runs every other frame when the NPC is at mid-distance. Result: 30Hz keyframe animation with visible jank. Nori (town-guide.tsx) never had this gate and runs at 60Hz unconditional.

Fix: remove the early-return entirely. Tier the spring-bone throttle instead:
```ts
// Mixer is ALWAYS 60Hz
animator.updateMixerOnly(dt, isMoving);
// Spring-bone is tiered: close=30Hz, mid-dist=15Hz
const springMod = camDistSq > HALF_RATE_DIST_SQ ? 4 : 2;
if ((frame + seed) % springMod === 0) {
  animator.updateSpringOnly(acc);
}
```

## Context
arena-npcs.tsx VRMNpcMesh, B9 fix 2026-04-24. The split between mixer (60Hz) and spring (30Hz) was correct in intent, but the early-return gate was placed before both calls instead of only gating the spring call.
