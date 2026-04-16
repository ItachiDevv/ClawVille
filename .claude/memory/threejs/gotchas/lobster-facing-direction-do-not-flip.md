---
title: lobster.glb faces -Z — do NOT flip atan2 to +Z formula
category: gotcha
tags: [lobster, facing, rotation, atan2, clawville, model-orientation]
date: 2026-04-14
confidence: high
threejs_version: r170+
---

## Summary
lobster.glb faces -Z at rotation.y=0. The formula atan2(-vx, -vy) is correct. Flipping to atan2(vx, vy) produces 180° wrong facing. This has been incorrectly reversed THREE times.

## Details

The correct state for ClawVille:
- `continuousRot = Math.atan2(-vx, -vy)` in player-pet.tsx
- `facingAngle = Math.atan2(-worldVx, -worldVz)` in npc-controller.tsx
- `DIR_ROTATION = { down: Math.PI, left: Math.PI/2, up: 0, right: -Math.PI/2, idle: Math.PI }`
- `facingRotY = Math.atan2(dx, dz) + Math.PI` in arena-location-npcs.tsx

The lobster-parts.ts comment `isBehind = m.center.z > zMidpoint; // +Z = behind (tail)` IS correct
and consistent with -Z facing. Do not use it as evidence for +Z.

## Why +Z keeps appearing and why it is wrong

The incorrect reasoning chain (happened in commits f85a6d6, 97ac953, and sessions 2026-04-13/14):
1. User reports lobster faces wrong direction
2. Analysis concludes lobster-parts.ts comment is "just a heuristic, not authoritative"
3. Flips to atan2(vx, vy)
4. User tests — bottom-left joystick → lobster faces top-right (180° off) — proves +Z is wrong
5. Must revert

## Do not change without live test evidence

If a future session concludes the model faces +Z, STOP. Require the user to confirm on the
live deployed site before making any code change to the facing formula.

## History of incorrect flips
1. Commit f85a6d6 — wrong flip to +Z → 4a62337 correctly reverted
2. Commit 97ac953 — wrong flip to +Z again → fixed in session 2026-04-14
3. Session 2026-04-13 full audit incorrectly verified +Z as correct (trusted code comment, not live test)
