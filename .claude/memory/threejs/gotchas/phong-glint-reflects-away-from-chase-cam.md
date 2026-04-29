---
title: Phong glint reflects away from +Z chase cam when sun has +Z component
category: gotcha
tags: [water, specular, glint, phong, chase-camera, reef-race, sun-direction]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

When a chase camera faces +Z and the sun direction has a positive Z component, the reflected ray points -Z — giving `dot(reflected, viewDir) < 0` and zero glint on every primary-angle frame.

## Details

Reef Race v2 water shader: `uSunDir = vec3(0.345, 0.924, 0.168)`.

`reflect(-uSunDir, vec3(0,1,0))` = `(-0.345, 0.924, -0.168)` — reflected Z is negative.

Chase cam faces +Z → `viewDir.z ≈ +0.85..0.95`.

`dot(reflected, viewDir) = -0.345×0 + 0.924×(-0.3) + (-0.168)(0.95) ≈ -0.437`.

`max(-0.437, 0.0) = 0` → `pow(0, 32) = 0` → glint = 0.

## Fix applied

Bumped glint scalar from 0.28 to 0.50. This does not fix the primary-angle issue (the scalar multiplies zero), but amplifies the glint on curve segments where camera yaw temporarily creates a positive dot product. The real fix would be to give the sun a negative Z component so the reflected ray points +Z toward the chase cam.

## Context

Surfaced during Critic comparison of water-surf.tsx candidates for Reef Race v2, 2026-04-29. The scalar bump is the Critic-mandated fix; the sun direction is shared with the scene's directional light and cannot be changed in isolation.
