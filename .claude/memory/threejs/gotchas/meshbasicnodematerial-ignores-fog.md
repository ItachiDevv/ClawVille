---
title: MeshBasicNodeMaterial ignores THREE.Fog — backdrop renders as hard wall
category: gotcha
tags: [MeshBasicNodeMaterial, fog, DepthBackdrop, transparency, TSL, underwater, wall-artifact]
date: 2026-04-16
confidence: high
threejs_version: r182
---

## Summary
`MeshBasicNodeMaterial` (and `MeshBasicMaterial`) does not participate in Three.js scene fog. A translucent plane using this material will render at full opacity even when it is within the fog near/far range, producing a hard visible wall at its edge.

## Details

The DepthBackdrop in ClawVille's underwater atmosphere is a large vertical `PlaneGeometry` using `MeshBasicNodeMaterial` with `opacityNode`. When `camera.far` and `fog.far` were not updated after the world expanded from 80x80 to 160x160, the backdrop at z=-3200 sat at the fog boundary (fog.far=3600) but rendered at 88% opacity instead of fading out — because node materials bypass the fog calculation entirely.

This produced a visible blue-green translucent "wall" cutting across the scene in front of distant buildings.

### Fixes applied

1. Moved backdrop to z=-5500 — well beyond the northernmost building (z≈-1504), deep enough that even without fog the camera rarely reaches it.
2. Added horizontal edge-fade via `opacityNode` (TSL): outer 40% of the plane fades to 0, eliminating the hard vertical edge visible when orbiting.
3. Changed `side: FrontSide` → `DoubleSide` so the plane does not vanish when the camera briefly crosses behind it.
4. Fixed `camera.far` 4000→6800 and `fog` near/far 800,3600→1200,6400 to match the 160x160 world.

### Rule of thumb
Any atmospheric backdrop plane that uses `MeshBasicMaterial` or `MeshBasicNodeMaterial` must be placed **beyond `camera.far`** OR have its own custom distance fade in `opacityNode`. You cannot rely on fog to hide its edges.

## Context
Surfaced in ClawVille 2026-04-16 after world expanded to 160x160 but World3DCanvas camera.far and fog constants were not updated to match. The world-proportions pattern memory had the correct values but the actual code was never updated.
