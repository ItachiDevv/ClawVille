---
title: Three.js fog uses camera world-space distance — kills orthographic top-down scene
category: gotcha
tags: [fog, orthographic, camera, visibility, distance, bumper-shells]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

Three.js `Fog` distance is measured in **world-space distance from the camera**, NOT screen depth. For a top-down orthographic camera elevated far above the scene, ALL geometry can be past `fog.far` and invisible.

## Details

Bumper Shells arena camera: `position=(0, 1100, 300)`, looking at `(0,0,0)`.

Distance from camera to arena floor at origin:
```
sqrt(0² + 1100² + 300²) ≈ 1140 world units
```

Old config: `FOG_NEAR=200, FOG_FAR=900`.

Every piece of geometry on the arena floor (y≈0) was ~1140wu from the camera — past FOG_FAR. Result: **100% fog opacity on all geometry = pitch-black void**.

The fix: push fog well past the camera-to-floor distance.

```ts
// FOG_NEAR and FOG_FAR must account for CAMERA WORLD DISTANCE, not screen depth.
// For an ortho cam at (0,1100,300): camera-to-floor ≈ 1140wu.
// Push fog to 1400/1500 so it only touches geometry at the clip plane.
export const FOG_NEAR = 1400;
export const FOG_FAR  = 1500; // == CAMERA_FAR — safe here (only clips clip-plane fringe)
```

## Iris Xe caveat

The memory note `Fog density directly controls fragment count on Iris Xe` warns about `fog.far > camera.far` in the open world. That concern applies when fog is used as a visibility fade in a large scene. In the Bumper Shells arena it is harmless because fog only touches geometry that is literally at the clip plane — which is nothing the player sees. The tradeoff is acceptable.

## Context

Diagnosed 2026-04-24 from user mobile screenshot — entire Bumper Shells arena rendered as near-black ellipse. Only 2D HUD overlays (cyan lightning bolt icons) were visible. Root cause confirmed by computing camera-to-floor world distance.
