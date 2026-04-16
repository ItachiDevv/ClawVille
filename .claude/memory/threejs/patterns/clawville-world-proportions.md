---
title: ClawVille world proportion constants
category: pattern
tags: [clawville, buildings, camera, proportions, tile-grid, dual-joystick]
date: 2026-04-16 (ring expansion pass)
confidence: high
threejs_version: r170+
---

## Summary
Canonical proportion values for ClawVille's 3D world after the 2026-04-16 proportions pass.

## Details

### Map grid (current — 160x160 square)
- MAP_COLS=160, MAP_ROWS=160, TILE_SIZE=32
- MAP_WIDTH=5120, MAP_HEIGHT=5120
- HALF_W=2560, HALF_H=2560
- Village center tile: (80, 80) → world (0, 0) — fully symmetric square

### Building ring layout (tilemap-data.ts buildingZones)
Buildings are 14x14 tiles, on a ring of radius 68 tiles (2176 wu) from center (80,80).
Ring expanded from 56→68 tiles on 2026-04-16 to eliminate building overlap.
rotY formula: cx = x + w/2, cz = y + h/2; dx = 80-cx, dz = 80-cz; rotY = atan2(dx, dz)
(model faces +Z at rotY=0; BUILDING_MODELS rotY values unchanged — diff is sub-0.003 rad)

Ring geometry at r=68:
- Radius: 2176 wu
- Circumference/10: 1367 wu per slot
- MAX_FOOTPRINT: 1000 wu → 367 wu (~11 tile) gap between buildings
- Max zone edge: tile 155 (config-citadel bottom) — fits within 160-tile map

| i | Building | Center tile | Zone top-left | World (x,z) |
|---|---|---|---|---|
| 0 | canvas-studio | (80,12) | (73,5) | (0,-2176) |
| 1 | memory-vault | (120,25) | (113,18) | (1280,-1760) |
| 2 | webhook-gateway | (145,59) | (138,52) | (2080,-672) |
| 3 | cron-hub | (145,101) | (138,94) | (2080,+672) |
| 4 | voice-tower | (120,135) | (113,128) | (1280,+1760) |
| 5 | config-citadel | (80,148) | (73,141) | (0,+2176) |
| 6 | tool-workshop | (40,135) | (33,128) | (-1280,+1760) |
| 7 | skill-forge | (15,101) | (8,94) | (-2080,+672) |
| 8 | channel-bridge | (15,59) | (8,52) | (-2080,-672) |
| 9 | security-fortress | (40,25) | (33,18) | (-1280,-1760) |

### Key constants
| Constant | Value | File | Notes |
|---|---|---|---|
| BUILDING_TARGET_HEIGHT | 800 | arena-buildings.tsx | Normalizes by height (size.y) not max-dim — 2026-04-16 scale fix |
| MAX_FOOTPRINT | 1000 | arena-buildings.tsx | Tightened 1400→1000 with ring expansion 56→68 tiles |
| CHARACTER_HEIGHT | 140 | arena-location-npcs.tsx | Raised from 32 — 2026-04-16 scale regression fix |
| PET_SCALE | 55 | player-pet.tsx | Raised from 16 — 2026-04-16 scale regression fix |
| NPC_SCALE | 50 | arena-npcs.tsx | Raised from 13 — 2026-04-16 scale regression fix |
| NPC_INSET_TILES | 4.0 | arena-location-npcs.tsx |
| VILLAGE_CENTER_TILE_X/Z | 80, 80 | arena-location-npcs.tsx |
| DECO_INNER_EXCLUSION_R | 2700 | arena-terrain.tsx | 2176 (ring) + 224 (zone half) + 300 buffer; was 2300 for r=56 ring |
| VILLAGE_CX / VILLAGE_CZ | 0, 0 | arena-terrain.tsx |
| decoration TARGET_COUNT | 80 | arena-terrain.tsx |
| decoration N_CLUSTERS | 24 | arena-terrain.tsx |
| decoration CLUSTER_RADIUS | 280 | arena-terrain.tsx |
| building exclusion radius multiplier | 2.0 | arena-terrain.tsx, merged-seaweed.tsx |
| Building label offset | BUILDING_TARGET_HEIGHT + 20 | arena-buildings.tsx |

### Fixed landmarks (5120x5120 map)
- Shipwreck: (-1900, -2, -700) — NW wilderness
- Submarine: (1900, -2, 700) — SE wilderness
- underwater-decorations.glb: (-600, -2, 1900)

### Atmosphere (underwater-atmosphere.tsx)
- CausticPlane: PlaneGeometry(6400, 6400) at y=150
- DepthBackdrop: PlaneGeometry(14400, 900), z=-5500, DoubleSide, edge-fade opacityNode (fades to 0 at ±60% from centre)
- Dust: FIELD_W=3600, FIELD_D=2400, FIELD_H=350

### Camera (World3DCanvas.tsx)
- camera.far: 6800
- game mode initial position: [0, 600, 1300]  (was [0,700,1600] before 2026-04-16 proportions pass)
- arena mode initial position: [0, 560, 1000]
- OrbitControls target: [0, 10, 0]
- FPS_FOLLOW_DISTANCE: 240
- maxDistance: 5500, minDistance follow: 40, explore: 160
- Fog: near=1200, far=6400

### Dual joystick (mobile)
- Left joystick: movement (feeds setJoystickVelocity) — nipplejs static mode, bottom-left
- Right joystick: camera orbit (feeds setCameraJoystickVelocity) — nipplejs static mode, bottom-right
- ArrowKeyRotationController reads cameraJoystickVelocity in useFrame and adds to dTheta/dPhi
- Right stick X: -dTheta (stick right = orbit right = theta decreases)
- Right stick Y: +dPhi (stick up = look up = phi increases)

## Context
Map doubled 2026-04-15: 80x80 (2560x2560) → 160x160 (5120x5120).
2026-04-16 proportions pass: buildings/characters felt tiny relative to 5120-unit world.
Fix: BUILDING_TARGET_HEIGHT 480→800, building footprint 10×10→14×14 tiles (centers unchanged),
PET_SCALE 10→16, NPC_SCALE 8→13, CHARACTER_HEIGHT 20→32, camera start [0,700,1600]→[0,600,1300].
No map width change. Building world positions unchanged (only footprint and visual scale grew).

2026-04-16 scale regression fix (second pass — CDP bbox measurements):
- Buildings: normalization changed from max(w,h,d) to size.y (height). Wide buildings
  (salty-spitoon, boating-school) were having their width clamp to 800, crushing height.
  All 10 buildings now normalized to BUILDING_TARGET_HEIGHT=800 by height only.
- Buildings + Location NPCs: bbox measurement now excludes SkinnedMesh bind poses.
  Box3.setFromObject() on rigged scenes can inflate bbox 100x; per-Mesh geometry
  traversal gives the true visual extent.
- Location NPCs: CHARACTER_HEIGHT 32→140. Per-model scaleOverride added for Karen (93)
  and Larry (140) as fallback if non-skinned bbox also fails.
- Wandering NPCs: NPC_SCALE 13→50. At scale=13, measured 31-37 world units — invisible
  against 800-unit buildings. Scale=50 targets ~115-142 world units.
- Player pet: PET_SCALE 16→55. Matches wandering NPC height range, slightly larger.
