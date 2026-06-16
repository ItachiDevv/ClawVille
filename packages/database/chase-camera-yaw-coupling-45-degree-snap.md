---
title: Chase camera coupled to avatar yaw causes 45° viewport snap on A/D press
category: gotcha
tags: [camera, chase-cam, yaw, casino, WASD, player-movement, feedback-loop]
date: 2026-05-19
confidence: high
threejs_version: r182
---

## Summary
If a behind-avatar chase camera tracks the avatar's yaw AND movement is camera-relative (W = camera.forward), strafe input (A/D) creates a positive feedback loop:

1. A press → strafe vector `vx,vz` = perpendicular to camera forward
2. `targetRot = atan2(vx, vz)` → avatar yaw rotates ~90° to face strafe direction
3. Chase camera yaw lerps toward avatar yaw → camera orbits around avatar
4. Camera forward direction now points elsewhere → strafe vector rotates → targetRot rotates → ...

Result: every A/D tap snaps the viewport ~45°. Holding A spins the world.

The earlier "fix" was to make the camera yaw lerp SLOWER than the avatar yaw (0.05 vs 0.15) — that just slowed the spin, didn't fix the runaway. The real fix is to decouple them entirely.

## Details
The root cause is that camera position depends on avatar yaw at all:
```ts
// BAD — camera snaps with avatar turn (immediate or lerped, doesn't matter)
const behindX = -Math.sin(rotRef.current) * CAM_BEHIND;
const behindZ = -Math.cos(rotRef.current) * CAM_BEHIND;
```

Lerped version is just slower runaway, not a fix:
```ts
// STILL BAD — feedback loop with camera-relative strafe, just slower
_casinoCamYaw += (rotRef.current - _casinoCamYaw) * 0.05;
const behindX = -Math.sin(_casinoCamYaw) * CAM_BEHIND;
const behindZ = -Math.cos(_casinoCamYaw) * CAM_BEHIND;
```

Real fix — camera yaw is fully decoupled from avatar yaw. The camera anchor is the spawn direction (Math.PI), and only arrow-key orbit changes it:
```ts
// GOOD — camera yaw never auto-tracks avatar; user-driven via arrows only
const orbitYaw = _casinoCamYaw + _casinoArrowYawOffset; // both static unless arrows pressed
const behindX = -Math.sin(orbitYaw) * CAM_BEHIND;
const behindZ = -Math.cos(orbitYaw) * CAM_BEHIND;
```

Avatar body still rotates to face movement direction (`atan2(vx, vz)`). Only the camera is fixed.

Key invariants:
- The combination of (camera-relative WASD) + (camera-tracks-avatar-yaw) is fundamentally unstable. Pick one or the other:
  - Tank controls (avatar-relative WASD, A/D = turn): camera CAN track avatar yaw.
  - Camera-relative WASD: camera CANNOT track avatar yaw — must be independent.
- `_casinoCamYaw` is module-scope so VRM + GLB branches share spawn anchor.
- Reset `_casinoCamYaw = Math.PI` + `_casinoArrowYawOffset = 0` on casino mount so re-entry starts behind-spawn.

## Context
Casino interior `casino-interior.tsx`. Bug originally reported 2026-05-18 (first WASD walkable casino deploy). The 0.05 lerp shipped that day reduced symptom severity but didn't eliminate it — user re-reported 2026-05-19 "A or D once turns the character roughly 45 degrees at a time, very unplayable". Both `CasinoVRMAvatarInner` and `CasinoGLBAvatarInner` needed the full decoupling.

The world player-avatar (`player-avatar.tsx`) doesn't have this issue — it uses OrbitControls (user-driven mouse-orbit camera), so camera yaw was never coupled to avatar yaw.
