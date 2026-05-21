---
title: Location NPC village center tile coords must always match the active grid center
category: gotcha
tags: [arena-location-npcs, npc-placement, facing, village-center, tilemap]
date: 2026-04-14
confidence: high
threejs_version: r170+
---

## Summary
`VILLAGE_CENTER_TILE_X` and `VILLAGE_CENTER_TILE_Z` in `arena-location-npcs.tsx` must be kept in sync with the active tilemap grid. They have been wrong twice; stale values cause all NPCs to face and position incorrectly.

## Details
History of values:
- Original (wrong): `(20, 12)` → world (-384, -256) — from an old smaller grid
- 64x40 grid (2026-04-13): `(32, 20)` → world (0, 0) ✓
- 80x80 square grid (2026-04-14): `(40, 40)` → world (0, 0) ✓
- 160x160 square grid (2026-04-15): `(80, 80)` → world (0, 0) ✓
- 240x240 square grid (2026-05-18 Phase 6.1): `(120, 120)` → world (0, 0) ✓
  - formula: `worldX = -3840 + 120*32 = 0`, `worldZ = -3840 + 120*32 = 0`

The center tile is always `MAP_COLS/2, MAP_ROWS/2`. When the grid is changed, this constant MUST be updated.

## NPC_INSET_WORLD must exceed MAX_FOOTPRINT/2

`NPC_INSET_WORLD` is how many world units NPCs step toward plaza center from their building center. **It must always be > MAX_FOOTPRINT/2** or NPCs spawn inside the widest buildings.

- Phase 6.0 (MAX_FOOTPRINT=1000): NPC_INSET_WORLD=600 ✓ (600 > 500)
- Phase 6.1 (MAX_FOOTPRINT=1500): NPC_INSET_WORLD=600 ✗ (600 < 750) — Mrs. Puff/Sandy inside buildings
- Phase 6.1 pass 2 (MAX_FOOTPRINT=1500): NPC_INSET_WORLD=850 ✓ (850 > 750)
- Phase 6.1 pass 3 (MAX_FOOTPRINT=1800): NPC_INSET_WORLD=1000 ✓ (1000 > 900 = 1800/2)

Formula: `NPC_INSET_WORLD = MAX_FOOTPRINT/2 + 100` (100wu margin of clearance in front of entrance).

## Context
Each time the tilemap grid was resized, this constant was not automatically updated. It's not imported from tilemap-data.ts (to avoid a circular dep with the NPC placement logic), so it's a manual sync point. Add a comment near the constant that says "must equal MAP_COLS/2 and MAP_ROWS/2" to reduce future drift.
