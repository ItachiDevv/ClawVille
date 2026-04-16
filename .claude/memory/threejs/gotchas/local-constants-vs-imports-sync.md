---
title: Local MAP_WIDTH/MAP_HEIGHT constants cause silent sync bugs
category: gotcha
tags: [clawville, constants, sync, map, building-placement, seaweed, terrain]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
Files that declare their own `const MAP_WIDTH = 2048` instead of importing from `tilemap-data.ts` will silently diverge if the canonical source changes.

## Details
In ClawVille, `apps/web/src/lib/pixi/tilemap-data.ts` is the single source of truth for:
- `MAP_WIDTH`, `MAP_HEIGHT`, `TILE_SIZE` (2048, 1280, 32)
- `buildingZones` — array of all 10 building positions

These files had LOCAL duplicates that should always import instead:
- `arena-terrain.tsx` — had `const MAP_WIDTH = 2048; const MAP_HEIGHT = 1280;` AND a hardcoded `BUILDING_ZONES` array duplicating `buildingZones`
- `arena-npcs.tsx` — had `const MAP_WIDTH = 2048; const MAP_HEIGHT = 1280;`
- `merged-seaweed.tsx` — had `const MAP_WIDTH = 2048; const MAP_HEIGHT = 1280; const TILE_SIZE = 32;` AND a hardcoded `BUILDING_ZONES` array

The BUILDING_ZONES arrays in terrain and seaweed used `{ x, y, w, h }` shape while `buildingZones` uses `{ x, y, width, height }`. When building positions changed in `tilemap-data.ts`, exclusion zones in terrain and seaweed didn't update.

## Fix
Import from tilemap-data in all 3D files:
```ts
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
```
Then derive exclusion zones dynamically:
```ts
const BUILDING_ZONES = buildingZones.map(z => ({
  cx: -HALF_MW + (z.x + z.width  / 2) * TILE_SIZE,
  cz: -HALF_MH + (z.y + z.height / 2) * TILE_SIZE,
  radius: Math.max(z.width, z.height) * TILE_SIZE * 2.0,
}));
```

## Context
ClawVille 2026-04-13 audit. The building exclusion zones in terrain and seaweed could miss excluding new building positions if the buildingZones array was updated without updating the local hardcoded arrays.
