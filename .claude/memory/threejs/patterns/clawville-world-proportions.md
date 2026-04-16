---
title: ClawVille world proportion constants
category: pattern
tags: [clawville, buildings, camera, proportions, tile-grid, dual-joystick]
date: 2026-04-16
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
Buildings are 14x14 tiles (expanded from 10x10 on 2026-04-16), arranged in 4 clusters.
Top-left tile was shifted -2 on each axis so building CENTERS stay at same world coords.
rotY formula: cx = x + w/2, cz = y + h/2; dx = 80-cx, dz = 80-cz; rotY = atan2(dx, dz)
(model faces +Z at rotY=0)

| Building | rotY |
|---|---|
| canvas-studio | 0.064 |
| skill-forge | -0.270 |
| tool-workshop | -0.150 |
| channel-bridge | -1.507 |
| webhook-gateway | -1.847 |
| voice-tower | -1.720 |
| cron-hub | 3.077 |
| config-citadel | -2.871 |
| security-fortress | -2.992 |
| memory-vault | 0.613 |

### Key constants
| Constant | Value | File |
|---|---|---|
| BUILDING_TARGET_HEIGHT | 800 | arena-buildings.tsx |
| CHARACTER_HEIGHT | 32 | arena-location-npcs.tsx |
| PET_SCALE | 16 | player-pet.tsx |
| NPC_SCALE | 13 | arena-npcs.tsx |
| NPC_INSET_TILES | 4.0 | arena-location-npcs.tsx |
| VILLAGE_CENTER_TILE_X/Z | 80, 80 | arena-location-npcs.tsx |
| DECO_INNER_EXCLUSION_R | 600 | arena-terrain.tsx |
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
Previous 80x80 expansion was 2026-04-14.
