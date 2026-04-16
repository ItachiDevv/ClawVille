---
title: Full movement/facing/joystick audit — 2026-04-13 (updated 2026-04-14 after camera-relative revert)
category: pattern
tags: [audit, movement, facing, joystick, atan2, camera, npc-controller, player-pet]
date: 2026-04-14
confidence: high
threejs_version: r170+
---

## Summary
Complete mathematical audit of all 8 directions. player-pet.tsx uses screen-relative movement
(NOT camera-relative). Facing uses atan2(-vx, -vy) for -Z model.

## Verified Correct (as of 2026-04-14 after camera-relative revert)

### player-pet.tsx
- Movement is SCREEN-RELATIVE: `vx = joystick.x`, `vy = joystick.y` (direct mapping)
- `continuousRot = Math.atan2(-vx, -vy)` — all 8 directions verified correct
- `DIR_ROTATION = { down:PI, left:PI/2, up:0, right:-PI/2, idle:PI }` — -Z model correct
- Idle facing = PI = toward +Z = toward camera at default position — correct
- Joystick priority over WASD click path — correct
- Camera removed from useThree() in PlayerPetInner (no longer needed for movement)

### npc-controller.tsx
- Camera-relative movement is KEPT for NPC possession mode (WASD intentional orbit control)
- `facingAngle = Math.atan2(-worldVx, -worldVz)` — correct for -Z model
- Camera-relative WASD: `_camRight = crossVectors(_camForward, _worldUp)` = correct
- Note: same OrbitControls orbit issue can affect NPC mode, but NPC mode is less common

### mobile-controls.tsx
- Left joystick: `vx = cos(rad)*force, vy = -sin(rad)*force` — correct for nipplejs convention
- RIGHT (rad=0): vx=+1, vy=0 — correct → maps to screen-right = +worldX
- UP (rad=PI/2): vx=0, vy=-1 — correct → maps to screen-up = -worldZ (pixel Y decrease)
- Left joystick effect dep: [isMobile, movementFrozen] — destroys on freeze, correct

### arena-location-npcs.tsx
- `facingRotY = atan2(dx,dz) + PI` — correct for -Z models
- `applyStationaryIdleAnimation` gets animGroupRef (inner group), not +PI added — correct

### arena-npcs.tsx
- `DIR_ROTATION = { down:PI, left:PI/2, up:0, right:-PI/2, idle:PI }` — -Z model correct
- `facingAngle` from NpcController used for possessed NPCs, DIR_ROTATION for wanderers — correct

### World3DCanvas.tsx
- `ArrowKeyRotationController`: orbits camera via ArrowKeys + right joystick, correct
- `FPSFollowCamera`: follows NPC in npc mode, player in player/autonomous mode — correct
- `useFollowCam = controlMode !== 'explore'` — explore gets free camera, others get follow — correct

## HISTORY: Camera-relative was attempted TWICE and both times broke mobile

### Attempt 1 (commit f85a6d6):
Added camera-relative movement. Reverted in 4a62337 because touch orbiting breaks it.

### Attempt 2 (commit 32f731a, 2026-04-14):
Re-added camera-relative movement. User reported same ~10s inversion bug. Root cause:
OrbitControls `enableRotate={true}` on canvas — single-finger touch outside joystick zones
orbits the camera, accumulating ~180° over 10 seconds, negating camForward.xz and inverting
all movement. Reverted in the session of 2026-04-14.

### Why camera-relative seems like it should work (but doesn't on mobile):
The math IS correct for all camera angles. The issue is user behavior: mobile users'
fingers drift outside joystick zones and trigger OrbitControls orbit. Screen-relative is
immune to this because joystick→world mapping doesn't depend on camera angle.

### If camera-relative is needed in the future:
Disable OrbitControls rotation on touch devices: `enableRotate={!isTouchDevice}`.
This makes the right joystick the ONLY way to orbit, preventing accidental orbit.

## Not Bugs (By Design)
- player-pet has no building collision (NpcController has it, player-pet does not)
- Both WASD listeners (player-pet + npc-controller) attach to window but guard conditions prevent double-processing
- Camera theta direction: decreasing theta = clockwise viewed from above = first-person "turn right" convention
