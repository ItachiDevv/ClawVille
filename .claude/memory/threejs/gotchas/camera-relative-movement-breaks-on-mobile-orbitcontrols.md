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

**Option A (prev used, now reverted for keyboard): Screen-relative movement**
```typescript
// LEGACY — was used in player-pet.tsx to avoid the mobile orbit bug.
// Reverted 2026-04-21 because screen-relative diverges from camera orientation
// after arrow-key orbit, making WASD feel wrong for keyboard users.
if (keyState.w) vy = -1;
if (keyState.s) vy = 1;
if (keyState.a) vx = -1;
if (keyState.d) vx = 1;
```

**Option B: Camera-relative (used in ClawVille as of 2026-04-21)**
```typescript
// player-pet.tsx — camera-relative (matches npc-controller.tsx)
camera.getWorldDirection(_playerCamForward);
_playerCamForward.y = 0;
_playerCamForward.normalize();
_playerCamRight.crossVectors(_playerCamForward, _playerWorldUp).normalize();
vx = _playerCamForward.x * inputFwd + _playerCamRight.x * inputRight;
vy = _playerCamForward.z * inputFwd + _playerCamRight.z * inputRight;
```
This fixes the core bug — after arrow-key orbit, WASD moves in the camera direction.
**CAVEAT:** The original mobile orbit bug (Option A revert reason) can resurface if
`OrbitControls enableRotate={true}` is left on for touch devices. If that becomes a
problem, disable touch rotation (`enableRotate={!isTouchDevice}`) rather than
reverting to screen-relative.

**Option C: Disable OrbitControls rotation on touch**
```tsx
<OrbitControls enableRotate={!isTouchDevice} ... />
```
Safe pairing with camera-relative movement — eliminates accidental orbit on mobile.

### History
- Screen-relative reverted TWICE (commits f85a6d6, 32f731a) for the mobile orbit bug.
- Camera-relative restored 2026-04-21: the mobile concern only applies to touch OrbitControls
  orbit — keyboard arrow-key orbit is intentional and bounded. NPC mode was always
  camera-relative and never had issues.

## Context
ClawVille. Three.js r182, R3F v9, nipplejs left joystick for movement, right joystick for
camera orbit, OrbitControls for camera control. FPSFollowCamera keeps camera behind character.
