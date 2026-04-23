---
title: camForward.y before XZ zero causes altitude drift on mouse orbit
category: gotcha
tags: [swim, altitude, camera, orbit, arrow-keys, WASD, player-pet, npc-controller]
date: 2026-04-17
confidence: high
threejs_version: r170+
---

## Summary

Capturing `camForward.y` before zeroing and feeding it into `playerAltitude` via `camForwardY * inputFwd * SPEED * delta` couples vertical swim to mouse orbit — any incidental camera tilt while holding W causes the pet to drift up or down.

## Details

The commit `33711bd` introduced this pattern: capture `camForwardY = _camForward.y` before `_camForward.y = 0`, then when airborne accumulate `worldVy = camForwardY * inputFwd` into `playerAltitude`. The intent was 3D swim by tilting the camera. The problem: mouse orbit also changes camera pitch, so casual orbit while holding W causes unintended altitude drift that the user cannot easily correct.

**The fix (commit `d92397d`):** zero `_camForward.y` immediately with no prior capture. WASD is always flat XZ. Vertical swim is now driven ONLY by `keyState.arrowup` (+1) / `keyState.arrowdown` (-1), gated on airborne, using `verticalInput * SPEED * delta`. Arrow keys simultaneously rotate the camera via `ArrowKeyRotationController` — both effects fire from the same key press, and that is expected behaviour.

```ts
// WRONG (33711bd): couples vertical to camera pitch / mouse orbit
const camForwardY = _camForward.y;
_camForward.y = 0;
if (airborne && inputFwd !== 0) {
  jumpState.playerAltitude += camForwardY * inputFwd * SPEED * delta;
}

// CORRECT (d92397d): explicit key-only vertical
_camForward.y = 0; // always flat
// ...XZ movement as normal...
if (airborne) {
  let v = 0;
  if (keyState.arrowup)   v += 1;
  if (keyState.arrowdown) v -= 1;
  if (v !== 0) jumpState.playerAltitude = Math.max(0, jumpState.playerAltitude + v * SPEED * delta);
}
```

## Context

Applies to both `PlayerPetGLBInner` and `PlayerPetVRMInner` in `player-pet.tsx`, and to `NpcController` in `npc-controller.tsx`. All three bodies must be updated together or the NPC path re-introduces the same drift in `npc` mode. `NpcKeyState` must include `arrowup`/`arrowdown` fields — the existing `e.key.toLowerCase()` listener picks them up automatically without any listener changes.
