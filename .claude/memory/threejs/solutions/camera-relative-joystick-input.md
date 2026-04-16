---
title: Lobster model facing + correct atan2 formula + screen-relative movement
category: solution
tags: [joystick, mobile, rotation, facing, atan2, lobster, model-orientation, camera-relative]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
lobster.glb faces -Z at rotation.y=0. Use atan2(-vx, -vy). Movement MUST be screen-relative (NOT camera-relative) — camera-relative fails on mobile because OrbitControls touch orbit accumulates over ~10 seconds and inverts the camera direction, causing 180° movement inversion.

## Details

### CRITICAL: This has been flipped incorrectly three times — do not flip again

**lobster.glb faces -Z at rotation.y=0. Head at -Z, tail at +Z.**

### Correct formulas (verified by live user testing multiple times)

**player-pet.tsx DIR_ROTATION table:**
```typescript
const DIR_ROTATION: Record<string, number> = {
  down: Math.PI, left: Math.PI / 2, up: 0, right: -Math.PI / 2, idle: Math.PI,
};
```

**Continuous facing in player-pet.tsx:**
```typescript
continuousRot = Math.atan2(-vx, -vy);   // -Z model — CORRECT
// NOT: Math.atan2(vx, vy)              // +Z assumption — WRONG, 180° off
```

**NPC controller facingAngle:**
```typescript
const facingAngle = Math.atan2(-worldVx, -worldVz);   // -Z model — CORRECT
// NOT: Math.atan2(worldVx, worldVz)                   // +Z assumption — WRONG
```

**arena-location-npcs.tsx computeNpcPlacement facing:**
```typescript
const facingRotY = Math.atan2(dx, dz) + Math.PI;   // -Z model needs +PI flip
// NOT: Math.atan2(dx, dz)                          // that's for +Z model — wrong
```

### Why camera-relative movement fails on mobile (CRITICAL)

Camera-relative movement was tried TWICE (commits f85a6d6 and 32f731a) and BOTH TIMES
caused the exact same bug: "joystick pulled SE, lobster moves NW" after ~10 seconds.

Root cause: OrbitControls is enabled on the canvas with `enableRotate={true}`. On mobile,
single-finger touch on the canvas (outside the joystick zones) causes OrbitControls to orbit
the camera. After ~10 seconds of play, the camera has accumulated ~180° of unintentional
orbit rotation. When theta shifts by π, camForward.xz is fully negated. Camera-relative
movement then maps joystick direction to exactly the opposite world direction.

The math is correct (cross product gives right sign at all angles) but the USER BEHAVIOR
on mobile causes the issue — fingers drift outside joystick zones and orbit the camera.

Screen-relative movement is immune to this: joystick direction always maps to the same
world-space direction regardless of camera angle. The trade-off is that after intentional
camera orbit (right joystick), the movement direction may not match the new screen view.
This is acceptable for ClawVille where the FPSFollowCamera keeps the default camera angle.

### DO NOT switch to camera-relative again without:
1. Disabling OrbitControls touch rotation on mobile (`enableRotate={isTouchDevice ? false : true}`)
2. OR ensuring the right joystick is the ONLY way to orbit (prevents accidental orbit)

### atan2 sign table (lobster faces -Z at rotY=0)
- up    (vx=0, vy=-1 → worldZ-): atan2(0,  1) = 0
- down  (vx=0, vy=+1 → worldZ+): atan2(0, -1) = PI
- right (vx=+1, vy=0 → worldX+): atan2(-1, 0) = -PI/2
- left  (vx=-1, vy=0 → worldX-): atan2(+1, 0) = +PI/2
- idle: PI (face +Z = toward camera at default angle)

### Joystick (nipplejs) convention
- Nipplejs UP → angle.radian = π/2 (standard math convention)
- mobile-controls.tsx: `vy = -Math.sin(rad)` → for UP gives vy=-1
- vx = joystickVelocity.x, vy = joystickVelocity.y (direct mapping, screen-relative)

## Context
ClawVille. The +Z assumption was introduced in commits f85a6d6, 97ac953 and the
camera-relative movement in f85a6d6, 32f731a. Both were reverted/should be reverted.
This solution file has been updated three times now. The -Z, screen-relative answer is
the ONLY live-test-verified correct answer. Any future analysis concluding +Z or
camera-relative should require live test evidence before acting.
