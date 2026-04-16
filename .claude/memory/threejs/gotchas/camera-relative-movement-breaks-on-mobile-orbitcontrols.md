---
title: Camera-relative movement breaks on mobile with OrbitControls enabled
category: gotcha
tags: [mobile, joystick, camera-relative, orbitcontrols, movement, clawville]
date: 2026-04-14
confidence: high
threejs_version: r170+
---

## Summary
Camera-relative joystick movement + OrbitControls with enableRotate=true causes 180° movement inversion after ~10 seconds on mobile. Use screen-relative movement OR disable OrbitControls rotation on touch devices.

## Details

### The bug
User moves with left joystick. Movement works correctly for ~10 seconds. Then joystick SE causes lobster to move NW (exact 180° inversion).

### Root cause
1. OrbitControls is enabled on the canvas with `enableRotate={true}`
2. On mobile, single-finger touch on the canvas (outside joystick zones) triggers OrbitControls orbit
3. User's fingers drift outside joystick zones during play
4. After ~10 seconds, accumulated orbit ≈ π radians (180°)
5. Camera is now on the opposite side of the character
6. camera.getWorldDirection() returns the negated XZ forward vector
7. Camera-relative transform: vx and vy are both negated → movement 180° inverted

### Why the math is correct but behavior is wrong
The camera-relative math using `crossVectors(camForward, worldUp)` gives the correct right
vector for ALL camera angles. The movement WOULD be correct if the user intentionally orbited
the camera and expected movement to adapt. But on mobile, the orbit is ACCIDENTAL — the user
expects the joystick to move the lobster in the direction it's pushed on screen, not relative
to a camera they accidentally moved.

### Fix options

**Option A (used in ClawVille): Revert to screen-relative movement**
```typescript
// player-pet.tsx — screen-relative
vx = joystickVelocity.x;
vy = joystickVelocity.y;
// For WASD:
if (keyState.w) vy = -1;
if (keyState.s) vy = 1;
if (keyState.a) vx = -1;
if (keyState.d) vx = 1;
```
Trade-off: movement direction doesn't adapt to camera orbit, but the FPSFollowCamera
keeps the default angle anyway, so this is acceptable.

**Option B: Disable OrbitControls rotation on touch**
```tsx
<OrbitControls enableRotate={!isTouchDevice} ... />
```
This makes the right joystick the ONLY way to orbit on mobile, preventing accidental orbit.
If using camera-relative movement, this option allows camera-relative to work correctly.

### History
This exact bug occurred TWICE in ClawVille (commits f85a6d6 and 32f731a) before the root
cause was fully understood. Both times were reverted in favor of screen-relative movement.

## Context
ClawVille. Three.js r182, R3F v9, nipplejs left joystick for movement, right joystick for
camera orbit, OrbitControls for camera control. FPSFollowCamera keeps camera behind character.
