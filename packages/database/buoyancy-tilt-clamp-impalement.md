---
title: Buoyancy wave-gradient tilt MUST be clamped or board impales vertically
category: gotcha
tags: [buoyancy, wave, tilt, pitch, roll, reef-race, clamp]
date: 2026-06-07
confidence: high
threejs_version: r182
---

## Summary
Feeding the raw wave gradient into board pitch/roll without a clamp will make the board go vertical (perpendicular to the wave face) on any steep swell. Clamp to ±12° (0.209 rad).

## Details
At large amplitudes (±25wu over ~700wu wavelength), the local gradient angle = atan2(25, 700/4) ≈ 8° avg, but a steep face can reach 20–30°+. Without a clamp the board nose tilts to near-vertical, visually impaling the board through the water surface.

## Fix
```ts
const MAX_TILT = 0.209; // 12°
const raw = Math.atan2(dispF - dispC, EPS);
const clamped = raw < -MAX_TILT ? -MAX_TILT : raw > MAX_TILT ? MAX_TILT : raw;
```
Use module-scope scalar math (no per-frame allocs).

## Context
Previous attempt impaled the board and was reverted. This fix shipped 2026-06-07 in the Reef Race surf-feel rebuild. Also: compose wave pitch with existing jump nose-up angle, not override it — `glider.rotation.x = -(noseAngle + wavePitch)`.
