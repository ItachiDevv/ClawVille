---
title: WorldLabelsOverlay — distance fade + building-occluder raycast
category: pattern
tags: [labels, occlusion, distance-fade, dom, performance, buildings, npc, iris-xe]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary
NPC + building world-space labels have distance-based opacity fade and 10 Hz building-occluder raycasts added to `world-labels-overlay.tsx` without any per-frame allocations.

## Details

### LabelEntry new fields
```typescript
fadeNear: number;        // wu at which label is at full base opacity (0 = always full within fadeFar)
fadeFar: number;         // wu at which label fades to 0
fadeBaseOpacity: number; // opacity at/within fadeNear (buildings: 0.40, NPCs: 0.65)
_prevOpacity: number;    // skip writes when delta < 0.01
occlude: boolean;        // true for NPC labels, false for building labels
occludePhase: number;    // 0–5, set to _registry.size % 6 at registration (stagger)
_occludeResult: boolean; // cached — updated 10 Hz, read every frame
```

### useWorldLabel new opts
```typescript
fadeNear?: number;       // default 0
fadeFar?: number;        // default Infinity
fadeBaseOpacity?: number;// default 1.0
occlude?: boolean;       // default false
```

### Occlusion architecture (module-scope, zero per-frame allocs)
- `_occRaycaster`, `_occDir`, `_scratchAnchorWorld` — all allocated at module load
- `_occluderMeshes: THREE.Mesh[] | null` — lazily built from `userData.isOccluder` meshes on first raycast; never re-invalidated (buildings are static)
- `_sceneRef` — captured in `WorldLabelsOverlayMount` via `useThree().scene`
- `_occFrameCounter` — incremented once per projection-useFrame pass; gates per `(counter + phase) % 6`
- `_occRaycaster.far = anchorDist - 80` — 80wu buffer prevents NPC-at-building-entrance self-occlusion

### Distance fade in projection loop
- Computed BEFORE `.project(camera)` clobbers `_scratchPos`
- World position stashed in `_scratchAnchorWorld` (doubles as occlusion ray origin)
- `distToCamera = camera.position.distanceTo(_scratchAnchorWorld)`
- When `targetOpacity < 0.01`: `div.style.display = 'none'` (no pointer-events, no paint)

### Label configs shipped 2026-05-18
| Label type | fadeNear | fadeFar | fadeBaseOpacity | occlude |
|---|---|---|---|---|
| Building | 2000wu | 5000wu | 0.40 | false |
| Wandering NPC (GLB + VRM) | 800wu | 3000wu | 0.65 | true |
| Teacher NPC (location) | 800wu | 3000wu | 0.65 | true |

### Visual redesign (same change)
- NPC: `<span>` only, 10px uppercase, black 4-sided text-shadow, no pill background
- Building: `<span>` only, 11px italic cyan, glow text-shadow, CSS hover → opacity 1
- OpenClaw chip text → 7px green dot `●` with `title="OpenClaw agent"`

### Perf budget (Iris Xe, 30 labels)
- Distance fade: 1 `distanceTo` call + 1 compare per label per frame — negligible
- Occlude: max 5 labels tested/frame (30/6); each tests ~300–400 AABB checks ≈ < 0.1ms total
- All occlusion allocs are at module load — zero per-frame

## Context
User reported "labels take up so much of the screen, overlayed over everything" — 25 pills covering all buildings + NPCs like a real-estate listing. Shipped 2026-05-18 as Implementer pass. Files changed: `world-labels-overlay.tsx`, `arena-buildings.tsx`, `arena-npcs.tsx`, `arena-location-npcs.tsx`.
