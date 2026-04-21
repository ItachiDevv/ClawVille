---
title: Lobster model facing + correct atan2 formula + camera-relative movement (player + NPC)
category: solution
tags: [joystick, mobile, rotation, facing, atan2, lobster, model-orientation, camera-relative]
date: 2026-04-21
confidence: high
threejs_version: r170+
---

## Summary

lobster.glb faces **+Z** at rotation.y=0 (EMPIRICALLY VERIFIED 2026-04-16 late PM, clean side-view).
Use `atan2(vx, vy)` where vx/vy are world-XZ velocities. **Both player and NPC modes now use
camera-relative movement** (2026-04-21). Old screen-relative revert concerned mobile OrbitControls
touch orbit — does NOT apply to keyboard arrow-key orbit.

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

## Camera-relative movement (current, 2026-04-21)

Both `player` mode (`player-pet.tsx`) and `npc` mode (`npc-controller.tsx`) now use
camera-relative WASD. Pattern:
```typescript
camera.getWorldDirection(_playerCamForward);
_playerCamForward.y = 0;
_playerCamForward.normalize();
_playerCamRight.crossVectors(_playerCamForward, _playerWorldUp).normalize();
vx = _playerCamForward.x * inputFwd + _playerCamRight.x * inputRight;
vy = _playerCamForward.z * inputFwd + _playerCamRight.z * inputRight;
```

## Why screen-relative was used before (and why it was wrong for keyboard users)

Camera-relative was reverted TWICE for the mobile touch-orbit bug: OrbitControls with
`enableRotate={true}` lets single-finger touch orbit the camera ~180° over 10s →
`camForward.xz` negated → joystick SE moves lobster NW.

Screen-relative was immune but broke for arrow-key orbit (intentional orbit, not accidental).
After orbiting with arrows and pressing D, the lobster moved "world-east" instead of
screen-right. Camera-relative is the correct behavior.

**Mobile caveat still applies:** If OrbitControls touch rotation is enabled, camera-relative
can still break on mobile after accidental orbit. Mitigation: disable touch rotation
(`enableRotate={isTouchDevice ? false : true}`) or ensure right joystick is the only orbit path.

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
