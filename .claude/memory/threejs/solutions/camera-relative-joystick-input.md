---
title: Lobster model facing + correct atan2 formula + screen-relative movement
category: solution
tags: [joystick, mobile, rotation, facing, atan2, lobster, model-orientation, camera-relative]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
lobster.glb faces **+X** at rotation.y=0 (EMPIRICALLY VERIFIED 2026-04-16 with debug overlay).
Use `atan2(-vy, vx)` for screen-relative pixel input. Movement MUST be screen-relative (NOT
camera-relative) — camera-relative fails on mobile because OrbitControls touch orbit accumulates
over ~10 seconds and inverts the camera direction, causing 180° movement inversion.

## Facing formula — +X native model (empirically verified 2026-04-16)

See full proof in `gotchas/lobster-faces-plus-x-at-rot-zero-empirical.md`.

**player-pet.tsx DIR_ROTATION table:**
```typescript
// +X native: right=0, down=-PI/2, left=PI, up=PI/2, idle=-PI/2
const DIR_ROTATION: Record<string, number> = {
  right: 0, down: -Math.PI / 2, left: Math.PI, up: Math.PI / 2, idle: -Math.PI / 2,
};
```

**Continuous facing in player-pet.tsx (screen-relative vx/vy):**
```typescript
continuousRot = Math.atan2(-vy, vx);   // +X model — CORRECT
// NOT: Math.atan2(-vx, -vy)           // -Z assumption — WRONG (prior incorrect state)
```

**NPC controller facingAngle (world-space worldVx/worldVz):**
```typescript
const facingAngle = Math.atan2(-worldVz, worldVx);   // +X model — CORRECT
// NOT: Math.atan2(-worldVx, -worldVz)                // -Z assumption — WRONG
```

**arena-npcs.tsx DIR_ROTATION: same as player-pet.tsx table above.**

### atan2 sign table (+X native, rotation.y=0 → head faces +X)
- right (vx=+1, vy=0): atan2(0,  +1) = 0         (+X = native forward)
- down  (vx=0,  vy=+1): atan2(-1,  0) = -PI/2     (rotate -90° → faces +Z = screen-down)
- left  (vx=-1, vy=0): atan2(0,  -1) = PI         (-X)
- up    (vx=0,  vy=-1): atan2(+1,  0) = +PI/2     (-Z = screen-up)
- idle: -PI/2 (faces +Z = toward camera at default +Z high angle position)

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
The +X facing was proven empirically on 2026-04-16 with a live debug overlay. All prior
memory and commits claiming "-Z" were wrong. See the full proof and warning in
`gotchas/lobster-faces-plus-x-at-rot-zero-empirical.md` before considering any change.
