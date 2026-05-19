---
title: Chase camera coupled to avatar yaw causes 45° viewport snap on A/D press
category: gotcha
tags: [camera, chase-cam, yaw, casino, WASD, player-movement]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary
If a behind-avatar chase camera computes `behindX/behindZ` directly from `rotRef.current` (the avatar's live yaw), pressing A or D immediately swings the entire viewport by the same angle the avatar turns — feels like the whole world rotating 45° per key press.

## Details
The root cause is that camera position depends linearly on avatar yaw:
```ts
// BAD — camera snaps with avatar turn
const behindX = -Math.sin(rotRef.current) * CAM_BEHIND;
const behindZ = -Math.cos(rotRef.current) * CAM_BEHIND;
```

Fix: introduce a module-scope `_casinoCamYaw` that lerps toward `rotRef.current` at a SLOWER rate than the avatar's own turn rate:
```ts
// GOOD — camera follows with comfortable lag
let camYawDiff = rotRef.current - _casinoCamYaw;
while (camYawDiff >  Math.PI) camYawDiff -= Math.PI * 2;
while (camYawDiff < -Math.PI) camYawDiff += Math.PI * 2;
_casinoCamYaw += camYawDiff * CAM_YAW_LERP; // 0.05 vs avatar's 0.15
const behindX = -Math.sin(_casinoCamYaw) * CAM_BEHIND;
const behindZ = -Math.cos(_casinoCamYaw) * CAM_BEHIND;
```

Key implementation details:
- Use **module scope** (not component scope) so both the VRM branch and GLB fallback branch share the SAME camera yaw ref. Only one avatar branch is ever mounted at a time, but they share the yaw state so there's no discontinuity if the branch switches.
- Initialize `_casinoCamYaw = Math.PI` to match avatar spawn facing (-Z = π).
- `CAM_YAW_LERP = 0.05` gives 3× lag vs avatar turn rate 0.15 — empirically comfortable.
- Shortest-path diff (while loops) is mandatory — without it, crossing the ±π boundary causes the camera to spin the long way around.

## Context
Casino interior `casino-interior.tsx` — Concern 6.0.5. Bug reported 2026-05-18 after first WASD walkable casino deploy. Both `CasinoVRMAvatarInner` and `CasinoGLBAvatarInner` needed the same fix. The world player-avatar (`player-avatar.tsx`) doesn't have this issue because it uses an orbit/FPS camera that the user controls independently — the chase-cam pattern is casino-specific.
