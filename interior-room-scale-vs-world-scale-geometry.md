---
title: Room-scale vs world-scale geometry in a scaled interior scene
category: pattern
tags: [geometry, scale, interior, VRM, avatar, proportions, BoxGeometry]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary
When a room GLB is auto-fit to a `INTERIOR_TARGET_HEIGHT` (e.g. 2000wu) but a VRM avatar renders at a fixed world-scale height (e.g. 270wu), prop geometry heights must be calibrated against the AVATAR height, not the room's max-dim — otherwise props appear wildly mis-scaled relative to the character.

## Details
The casino interior pattern:

```
INTERIOR_TARGET_HEIGHT = 2000wu  (GLB auto-fit scale)
_ROOM_SCALE            = 2000 / 600 ≈ 3.333  (relative to legacy 600wu reference)
CASINO_VRM_TARGET_HEIGHT = 270wu  (avatar height, calibrated to real human proportions)
```

Cabinet heights must be in world-scale units (wu), not room-scale:
```ts
// BAD — room-scaled heights; body becomes 227wu, almost as tall as 270wu avatar
const CABINET_BODY_H = Math.round(68 * _ROOM_SCALE); // 227wu — avatar looks tiny

// GOOD — world-scale heights; body 143wu, cabinet top 159wu = 59% of 270wu = chest
const _CAB_BODY_H_WU = 143; // world units (NOT room-scaled)
const _CAB_BASE_H_WU =  16; // world units (NOT room-scaled)
// Cabinet top = 16 + 143 = 159wu = 59% of 270wu avatar → chest height ✓
```

Width and depth of prop footprints CAN still use room-scale if you want them to fill the room floor proportionally:
```ts
// Width/depth room-scaled so cabinet footprint fills room proportionally
const CABINET_BODY_GEO = new THREE.BoxGeometry(
  Math.round(38 * _ROOM_SCALE),  // 127wu wide — room-scaled (footprint)
  _CAB_BODY_H_WU,                // 143wu tall — world-scaled (height)
  Math.round(28 * _ROOM_SCALE),  // 93wu deep — room-scaled (footprint)
);
```

The rule: **vertical (Y) dimensions of props → calibrate against avatar height. Horizontal (XZ) dimensions of props → can follow room scale.**

## Context
Casino interior `casino-interior.tsx`, Concern 6.0.5. Bug reported 2026-05-18: slot machine tops only reached avatar hip/lower-back despite seemingly-reasonable room-scaled dimensions. Root cause: room max-dim (2000wu) dwarfs avatar height (270wu) by 7.4×, so room-scale constants produce proportions relative to the room ceiling, not a human-scale character.

The `computeVRMAvatarFit()` function also gained an optional `targetHeightOverride` 3rd parameter so interior scenes can pass a scene-specific target without polluting `SPECIES_TARGET_HEIGHT_WU`.
