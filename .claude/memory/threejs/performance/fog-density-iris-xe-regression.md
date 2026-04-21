---
title: Fog density directly controls fragment count on Iris Xe — never push far > camera.far
category: performance
tags: [fog, iris-xe, fps-regression, fragment-count, camera-far]
date: 2026-04-20
confidence: high
threejs_version: r170+
---

## Summary
Pushing fog near/far outward exposes more scene geometry to rasterization. On Intel Iris Xe this directly drops FPS — there are no spare fragment units.

## Details
Commit `9e7341a` changed `<fog args={[COLOR, 1200, 6400]} />` to `<fog args={[COLOR, 1800, 9000]} />` to soften the underwater fog falloff so distant buildings stayed readable. This caused a regression from ~90 FPS to ~50 FPS on Iris Xe.

**Why it hurts:** Three.js LinearFog does NOT perform frustum-culling based on fog distance — culling is done by `camera.far`. `camera.far = 6800` in this project. So setting fog far to 9000 means:
- All geometry between 6400 and 6800 wu (previously fog-fully-opaque = nearly invisible) is now in the fog transition zone and gets fully rasterized + fog-blended.
- That includes parts of the building ring at ~2176 wu radius + seaweed + wandering NPCs + light rays.
- Any fog far BEYOND camera.far (here 9000 > 6800) is silently wasted CPU/GPU computation with zero visual effect.

**Rule:** fog far must be ≤ camera.far. Prefer fog far that fully-opaqued-away anything the GPU was already working to render before this change was made.

**Calibrated values for ClawVille 5120×5120 world (160×160 tiles):**
- near = 1200, far = 6400 (matches camera.far=6800 with 400 wu margin)
- Building ring radius ≈ 2176 wu — ring buildings are at ~50% fog opacity, readable but hazier at distance.

## Context
Performance bisect 2026-04-20. World3DCanvas.tsx `<fog>` component. Reverted in FPS-fix commit on master.
