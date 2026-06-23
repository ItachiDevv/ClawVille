---
name: map-locations-ssot
description: "World roster SSOT: tilemap-data buildingZones is authoritative; map-locations positionX/Y is metadata-only; the 3 parity tables + world-dimensions + VRM-path-uniqueness + the menu<->constant coupling must move same-diff."
category: constraint
confidence: high
date: 2026-06-22
---

---
name: map-locations-ssot
description: buildingZones (tilemap-data) is the authoritative building-position SSOT; map-locations positionX/Y is metadata-only; the 3 parity tables + world-dimensions + VRM-path-uniqueness + UI consumers move same-diff.
category: constraint
confidence: 0.85
date: 2026-06-22
---

# World roster + world-dimensions SSOT (the menu<->backend decoupling guard)

**Three building-position parity tables that MUST agree:**
1. `apps/web/src/lib/pixi/tilemap-data.ts` `buildingZones` — **AUTHORITATIVE**, all 12 buildings (3da/apps-web territory, CONSUMED). Circle geometry: R=130 tiles, center (288,288), 30deg/slot, zone upper-left = round(cx)-7, 14x14 zone.
2. `npc-definitions.ts` `BUILDING_TILE_ZONES`:42-63 — the 10 TEACHING buildings only (no cove/claw-arcade); comment :41 'MUST EXACTLY MATCH buildingZones'. Derives `NPC_BUILDING_CENTERS`.
3. `map-locations.ts` positionX/Y — **METADATA ONLY** (:14-19 'do NOT use for proximity checks'). Authoritative position for ALL gameplay/3D/UI is buildingZones.

Editing the ring in one without propagating slot-by-slot to the others is the canonical decoupling. cove (slot 9) + claw-arcade (slot 8) are entertainment, resolved from the `MAP_LOCATIONS` rect (npc-simulation.ts:102-109), not from the 10-teaching tables.

**World-dimensions SSOT:** `WORLD_PX_WIDTH/HEIGHT=18432`, center 9216, `SPAWN_PX={9216,9756}` must equal across the web client (`game.ts`, module-load assert), the API (`world.ts` TOWN_CENTER:50), and the DB (`avatars.position_x/y` defaults, migration 0002). The S3 bug: client moved to 18432/center 9216 but the server still defaulted 2560 + the validator rejected >5120 -> logged-in players restored a stale corner. Change world size only by updating tilemap-data MAP_COLS/ROWS + world-dimensions.ts + game.ts + world.ts + the avatars migration in LOCKSTEP; world.ts:167 clamps stale positions to SPAWN_PX.

**VRM-path uniqueness:** every NPC in `NPC_DEFINITIONS` MUST use a unique species->VRM path (vrm-loader caches one parsed VRM per path; sharing clobbers scene/skeleton). Free wanderers (buildingId='') MUST spawn clear of BUILDING_TILE_ZONES + the exclusion pad (A* returns empty on a blocked start tile -> wander-planner deadlock).

**The menu<->constant coupling (why this guard exists):** every UI surface reads identity from `MAP_LOCATIONS` + positions from `buildingZones` — `world-map-modal.tsx:95-104` (warp markers), `minimap.tsx:168` (markers + click-to-move), `location-hud.tsx:42` (proximity HUD). The `.find(l=>l.id===…)` lookups silently return undefined on a stale id (marker/HUD vanishes, no error). A building id/name/theme change moves the constant + buildingZones + building-types lists + the DB seed + EVERY UI lookup + Nori `town-guide.ts` knowledge[] in ONE diff.

**Deployment:** all parity tables + world-dimensions SSOT present + consistent in this worktree (S3 LIVE). Related: `[[world-roster-ssot]]` `[[npc-entity-interpolation-contract]]`.
