---
title: Lobster model facing + correct atan2 formula + screen-relative movement
category: solution
tags: [joystick, mobile, rotation, facing, atan2, lobster, model-orientation, camera-relative]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary

lobster.glb faces **+Z** at rotation.y=0 (EMPIRICALLY VERIFIED 2026-04-16 late PM, clean side-view).
Use `atan2(vx, vy)` for screen-relative pixel input. Movement MUST be screen-relative (NOT
camera-relative) — camera-relative fails on mobile because OrbitControls touch orbit accumulates
over ~10 seconds and inverts the camera direction.

**WARNING — this is the THIRD conclusion about the native axis. The +X conclusion from the AM
session was WRONG (camera was orbited). Only run the overlay with a pure side-view to re-verify.**

## Facing formula — +Z native model (empirically verified 2026-04-16 late PM)

See full proof and hard-rule in `gotchas/lobster-faces-plus-z-at-rot-zero-empirical.md`.

**player-pet.tsx DIR_ROTATION table:**
```typescript
// +Z native: down=0, up=PI, right=PI/2, left=-PI/2, idle=0
const DIR_ROTATION: Record<string, number> = {
  down: 0, up: Math.PI, right: Math.PI / 2, left: -Math.PI / 2, idle: 0,
};
```

**Continuous facing in player-pet.tsx (screen-relative vx/vy):**
```typescript
continuousRot = Math.atan2(vx, vy);   // +Z model — CORRECT (no negations)
// NOT: Math.atan2(-vy, vx)            // +X assumption — WRONG (from AM session)
// NOT: Math.atan2(-vx, -vy)           // -Z assumption — WRONG (original)
```

**NPC controller facingAngle (world-space worldVx/worldVz):**
```typescript
const facingAngle = Math.atan2(worldVx, worldVz);   // +Z model — CORRECT
// NOT: Math.atan2(-worldVz, worldVx)                // +X assumption — WRONG
// NOT: Math.atan2(-worldVx, -worldVz)               // -Z assumption — WRONG
```

**arena-npcs.tsx DIR_ROTATION: same as player-pet.tsx table above.**

### atan2 sign table (+Z native, rotation.y=0 → head faces +Z)
- down  (vx=0,  vy=+1): atan2(0,  +1) = 0         (+Z = native forward = screen-down)
- up    (vx=0,  vy=-1): atan2(0,  -1) = PI         (-Z = screen-up)
- right (vx=+1, vy=0):  atan2(+1,  0) = PI/2       (+X = screen-right)
- left  (vx=-1, vy=0):  atan2(-1,  0) = -PI/2      (-X = screen-left)
- idle: 0 (faces +Z = toward default camera at positive +Z high angle position)

## Why camera-relative movement fails on mobile (CRITICAL — unchanged)

Camera-relative movement was tried twice and BOTH TIMES caused "joystick pulled SE, lobster
moves NW" after ~10 seconds.

Root cause: OrbitControls is enabled with `enableRotate={true}`. Single-finger touch outside
joystick zones causes OrbitControls to orbit the camera. After ~10s, camera has accumulated
~180° of unintentional orbit. camForward.xz is fully negated, mapping joystick to opposite
world direction.

Screen-relative movement is immune. The trade-off (movement doesn't follow intentional orbit)
is acceptable because FPSFollowCamera keeps the default angle in normal play.

**DO NOT switch to camera-relative again without:**
1. Disabling OrbitControls touch rotation (`enableRotate={isTouchDevice ? false : true}`)
2. OR ensuring right joystick is the only way to orbit

## Joystick (nipplejs) convention — unchanged
- Nipplejs UP → angle.radian = π/2
- mobile-controls.tsx: `vy = -Math.sin(rad)` → for UP gives vy=-1
- vx = joystickVelocity.x, vy = joystickVelocity.y (direct mapping, screen-relative)

## Context
The +Z facing was proven empirically on 2026-04-16 late PM with a clean side-view screenshot.
The +X conclusion from the AM session was based on a camera-orbited screenshot and was WRONG.
All prior memory claiming "-Z" was also wrong. See full proof and warning (including the
hard-rule requiring overlay values before any future change) in
`gotchas/lobster-faces-plus-z-at-rot-zero-empirical.md`.
