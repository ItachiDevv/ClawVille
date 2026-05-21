---
title: AVATAR_SCALE must be calibrated against actual GLB bbox — never assume from comments
category: gotcha
tags: [scale, AVATAR_SCALE, lobster, GLB, bbox, calibration]
date: 2026-04-17
confidence: high
threejs_version: r170+
---

## Summary

`AVATAR_SCALE` (formerly `PET_SCALE`) in `player-avatar.tsx` is a flat multiplier applied to the lobster/crayfish GLB.
If the GLB is ever updated, the native height changes and `AVATAR_SCALE` becomes miscalibrated.
Always read the actual GLTF accessor bounds to verify native height before setting this constant.

## Details

The lobster.glb native height is measurable from GLTF accessor bounds:

```js
// From Node.js:
const data = fs.readFileSync('apps/web/public/models/lobster.glb');
const chunkLen = data.readUInt32LE(12);
const json = JSON.parse(data.slice(20, 20 + chunkLen));
json.accessors.forEach(acc => {
  if (acc.type === 'VEC3' && acc.min && acc.max)
    console.log('bbox max.y:', acc.max[1]); // lobster = 1.12
});
```

As of 2026-04-17, `lobster.glb` has `bbox.max.y = 1.12 native units` and `min.y = 0`
(pivot is at feet).

**The bug (2026-04-16 → 2026-04-17):**
- `AVATAR_SCALE=20` was set during pass 2 scale-down with comment "targets ~48 wu"
- That assumed native height ≈ 2.4 units (true for the OLD lobster GLB)
- Current GLB: 1.12 units → `20 × 1.12 = 22.4 wu`
- Wandering NPC via `computeNpcScale`: `45 / 1.12 = 40.2` scale → `40.2 × 1.12 = 45 wu`
- Player avatar appeared 2× smaller than NPC lobsters on screen

**Fix:** `AVATAR_SCALE = 40` → `40 × 1.12 = 44.8 wu ≈ TARGET_NPC_HEIGHT = 45 wu`.

## Context

This class of bug is hard to detect by looking at code comments alone. The comment said
"~48 wu" but the actual render was 22.4 wu. Always verify GLB geometry bounds from the
GLTF JSON before trusting any scale comment. The wandering NPC path (`computeNpcScale`)
auto-measures the GLB and is immune to this — but `AVATAR_SCALE` is hardcoded and needs
manual recalibration after any GLB swap.
