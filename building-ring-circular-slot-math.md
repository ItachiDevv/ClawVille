---
title: Circular building ring — slot math, rotY formula, tilemap constraint
category: pattern
tags: [buildings, ring, circular, tilemap, rotY, TILE_SIZE, slots]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary
Formula for placing 12 buildings on a true circle (30° spacing) on the ClawVille 240×240 tile grid (Phase 6.1), and the rotY formula to make each building face the plaza center.

## Details

### Grid constants (Phase 6.1 — 2026-05-18)
- MAP_COLS = MAP_ROWS = 240 tiles (expanded from 160 in Phase 6.1)
- TILE_SIZE = 32 wu
- MAP_WIDTH = MAP_HEIGHT = 7680 wu
- Center tile: (120, 120) — world (0, 0, 0)
- Zone footprint per building: 14×14 tiles
- Ring radius: R = 100 tiles = 3200 wu

### Circular slot geometry
```
θ_slot = -π/2 + slot * (π/6)    // slot 0 = North, clockwise
cx_tile = 120 + R * cos(θ_slot)
cy_tile = 120 + R * sin(θ_slot)
zone_x = round(cx_tile) - 7     // upper-left of 14×14 zone
zone_y = round(cy_tile) - 7
```

### rotY formula (faces plaza center)
```
rotY = atan2(120 - cx_tile, 120 - cy_tile)
```
**Critical:** rotY values are IDENTICAL to the old R=72 layout. atan2 depends only on the direction angle (dx/dy ratio), not the ring radius magnitude.

### Maximum safe ring radius on 240×240 grid with 14×14 zones
- Northernmost slot: cy = 120 - R → zone_y = 120 - R - 7 = 113 - R
- For zone_y ≥ 0: R ≤ 113 tiles
- **R = 100 tiles** (3200 wu) is the confirmed shipped value — gives 13-tile border clearance
- R = 113 is the hard maximum; anything above clips the northernmost zone outside the map

### Why the grid had to expand (and not just R)
R=90 on the 160-grid: zone_y = 73-90 = -17 (out of bounds). The only clean solution was to
expand the grid to 240×240 (center at 120,120) which gives a max safe R of 113. R=100 was
chosen for 13 tiles of clearance — comfortable breathing room without going to the extreme.

### positionX/Y in map-locations.ts
```
positionX = zone_x * TILE_SIZE   // (upper-left tile × 32)
positionY = zone_y * TILE_SIZE
```

### model-authored rotYOffset values (stay with their building regardless of slot)
- `salty-spitoon`: rotYOffset = -π/2
- `boating-school`: rotYOffset = +π/2
- `sandy-treedome`: rotYOffset = +π

All other buildings: no rotYOffset.

### Per-building targetHeight overrides (Phase 6.1)
Standard default: `BUILDING_TARGET_HEIGHT = 800 wu`. Per-building overrides in BUILDING_MODELS:
| Building | targetHeight | Rationale |
|---|---|---|
| visual-creation | 1100 | landmark at the prominent N slot |
| code-development | 900 | chum bucket is naturally squat |
| mcp-tool-use | 1000 | krusty krab door must clear avatar |
| messaging-channels | 1000 | treedome dome reads as large |
| api-integrations | 1000 | parity with krusty krab |
| app-publishing | 950 | school is lower-profile by design |
| cron-automation | 1200 | civic anchor, taller than shops |
| deployment-ops | 1500 | lighthouse — tallest by definition |
| agent-security | 900 | rock is naturally squat |
| casino | 1040 | entertainment district landmark (+30%) |
| claw-arcade | 900 | compact peer to Patrick's rock |
| memory-rag | 1100 | moai head landmark at NNW |

## Context
Phase 6.1 shipped 2026-05-18. Expanded from 160-grid R=72 (Phase 6.0.1 circle revert) to
240-grid R=100. Canonical values verified in `tilemap-data.ts` buildingZones + `arena-buildings.tsx` BUILDING_MODELS.
