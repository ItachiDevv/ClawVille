---
title: Building targetHeight override — per-building scale without bypassing bbox pipeline
category: pattern
tags: [buildings, scale, computeBuildingScale, targetHeight, scaleOverride, MAX_FOOTPRINT, pivotZBias]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary
Use `targetHeight?: number` on a BUILDING_MODELS entry (not `scaleOverride`) when you want a specific building to be larger/smaller than `BUILDING_TARGET_HEIGHT` while preserving pivot correction and footprint cap.

## Details

### The problem with scaleOverride
`scaleOverride` bypasses `computeBuildingScale()` entirely — it's a raw Three.js scale scalar and requires knowing the GLB's native bbox.y. If the GLB changes, the scale goes wrong silently.

### The targetHeight approach
```ts
// In BUILDING_MODELS entry:
'casino': { model: '...', targetHeight: 1040, ... }

// computeBuildingScale signature:
function computeBuildingScale(
  scene: THREE.Object3D,
  targetHeight: number = BUILDING_TARGET_HEIGHT
): BuildingScaleResult

// useMemo call site:
const targetH = config.targetHeight ?? BUILDING_TARGET_HEIGHT;
const { scale: s, ... } = computeBuildingScale(c, targetH);
// Add config.targetHeight AND config.pivotZBias to the useMemo dep array!
```

### Casino example (commit cf5518a)
- BUILDING_TARGET_HEIGHT = 800 wu (standard)
- Casino: targetHeight = 800 * 1.3 = 1040 wu (30% taller landmark)
- All pivot correction (pivotOffsetX/Y/Z) and MAX_FOOTPRINT cap still apply

### When to use which
- `targetHeight`: proportional resize relative to bbox Y — use for any building that should differ from standard by a factor
- `scaleOverride`: raw GLB-space scale — use only when the GLB has a known static bbox and you need exact pixel precision (legacy; avoid for new entries)

## CRITICAL BUG — MAX_FOOTPRINT must scale with ring radius

`MAX_FOOTPRINT` caps XZ footprint AFTER height normalization. If this cap is too small relative to the ring geometry, it silently reduces scale below the targetHeight.

**Root cause (Phase 6.1 regression):** MAX_FOOTPRINT was 1000wu, set for R=72-tile ring. When ring expanded to R=100 tiles (slot spacing ≈1675wu), many wide buildings (Squidward, Sandy, Krusty Krab, Salty Spitoon, Downtown) have bbox wider than tall. At targetHeight≥1000, their `scaledMaxXZ = max(bbox.x, bbox.z) * scale` exceeded 1000wu. The cap fired: `scale *= 1000 / scaledMaxXZ`, shrinking rendered height to 500-700wu — characters were taller than buildings.

**Fix (2026-05-18 pass 2):** MAX_FOOTPRINT = 1500wu. Gives 175wu clearance per side in the 1675wu slot gap. Most buildings now hit their targetHeight.

**Pass 3 (2026-05-18):** MAX_FOOTPRINT raised again to **1800wu**. Reason: `salty-spitoon.glb` has ~2:1 aspect ratio. At targetHeight=1500 its XZ was still hitting the 1500 cap, rendering at only ~900wu. At 1800wu it renders correctly. The 1800 cap means the widest buildings slightly overlap the theoretical slot boundary — but in practice only salty-spitoon approaches the cap; most buildings are height-constrained, not footprint-constrained.

**Rule:** Start at `ring_circumference / building_count * 0.9 ≈ 1507wu`. If a specific wide-aspect building still fails to reach targetHeight, raise the cap further and document.

## pivotZBias — compensate for foreground geometry displacing bbox center

When a GLB has steps, a path, or a decorative base at its front, the bbox center is pulled toward those foreground elements. `computeBuildingScale()` returns `pivotOffsetZ = bbox_center_z * scale`, which the inner group subtracts — but this pushes the house body too far backward from the player-facing side.

```ts
// Config:
'memory-rag': { ..., pivotZBias: 180 }

// JSX — inner group:
<group position={[-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ + (config.pivotZBias ?? 0)]}>
  <primitive object={cloned} scale={buildingScale} />
</group>
```

Positive pivotZBias moves the building toward village center (toward the player). Add to useMemo dep array.

This is preferred over GLB modification — no asset change required, tunable from config.

## Context
Introduced for Phase 6.0.1 casino as entertainment-district landmark.
Phase 6.1 (2026-05-18): ALL 12 buildings have explicit `targetHeight` overrides — the 800wu default is only the fallback. MAX_FOOTPRINT raised 1000→1500→1800 (pass 3: salty-spitoon wide aspect). pivotZBias added for memory-rag (Squidward, +180wu steps offset). NPC_INSET_WORLD raised 600→1000 (must exceed MAX_FOOTPRINT/2=900 for NPCs to stand outside widest building).
Phase 6.2.1 (2026-05-18): bodyAnchorChild supersedes pivotZBias for memory-rag and mcp-tool-use. pivotZBias: 180 removed from memory-rag config. Size bumps: code-development 1000→1400, api-integrations 1000→1300, cron-automation 1000→1300.
`computeBuildingScale` is in `apps/web/src/lib/three/arena-buildings.tsx`.
