---
title: Lobster DIR_ROTATION left/right values were swapped
category: solution
tags: [lobster, rotation, facing, direction, joystick, mobile, player-pet]
date: 2026-04-12
confidence: high
threejs_version: r170+
---

## Summary
`DIR_ROTATION` for the player pet (and arena NPCs) had left/right rotation values swapped, causing the lobster to face left when moving right, and vice versa.

## Details
The lobster GLB faces **-Z** natively (rotation.y=0 points the model toward negative Z).

To make a -Z-forward model face a world-space movement direction (worldVx, worldVz), the correct formula is:
```
θ = atan2(-worldVx, -worldVz)
```

This derivation: Three.js rotates -Z forward by θ around +Y (right-hand rule) giving world direction (-sin θ, 0, -cos θ). Setting that equal to (worldVx, worldVz) gives sin θ = -worldVx, cos θ = -worldVz → θ = atan2(-worldVx, -worldVz).

Discrete direction table:
- up    (vx=0, vy=-1, worldZ-): atan2(0,  1) = 0
- down  (vx=0, vy=+1, worldZ+): atan2(0, -1) = Math.PI
- right (vx=+1, vy=0, worldX+): atan2(-1, 0) = **-Math.PI/2**  ← was wrongly +PI/2
- left  (vx=-1, vy=0, worldX-): atan2(+1, 0) = **+Math.PI/2**  ← was wrongly -PI/2

The wrong table:
```ts
{ down: Math.PI, left: -Math.PI / 2, up: 0, right: Math.PI / 2, idle: Math.PI }
```

The correct table:
```ts
{ down: Math.PI, left: Math.PI / 2, up: 0, right: -Math.PI / 2, idle: Math.PI }
```

Also fixed: the rotation lerp used naive `(target - current) * 0.15` which could spin the long way when crossing the ±PI boundary. Fixed to shortest-path:
```ts
let rotDiff = targetRot - rotRef.current;
while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
rotRef.current += rotDiff * 0.15;
```

## Context
Bug manifested as mobile joystick: moving right made lobster face left, moving left made lobster face right. The npc-controller.tsx already had the correct formula (atan2(-vx, -vy)) with a comment explaining the derivation — the player-pet.tsx and arena-npcs.tsx discrete tables just had the sign wrong.

Files fixed: `apps/web/src/lib/three/player-pet.tsx`, `apps/web/src/lib/three/arena-npcs.tsx`.
