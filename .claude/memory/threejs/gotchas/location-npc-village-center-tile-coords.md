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
  - formula: `worldX = -1024 + 32*32 = 0`, `worldZ = -640 + 20*32 = 0`
- 80x80 square grid (2026-04-14): `(40, 40)` → world (0, 0) ✓
  - formula: `worldX = -1280 + 40*32 = 0`, `worldZ = -1280 + 40*32 = 0`
- 160x160 square grid (2026-04-15): `(80, 80)` → world (0, 0) ✓
  - formula: `worldX = -2560 + 80*32 = 0`, `worldZ = -2560 + 80*32 = 0`

The center tile is always `MAP_COLS/2, MAP_ROWS/2`. When the grid is changed, this constant MUST be updated.

## Context
Each time the tilemap grid was resized, this constant was not automatically updated. It's not imported from tilemap-data.ts (to avoid a circular dep with the NPC placement logic), so it's a manual sync point. Add a comment near the constant that says "must equal MAP_COLS/2 and MAP_ROWS/2" to reduce future drift.
