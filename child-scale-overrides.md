---
title: childScaleOverrides — differential scale on named GLB child groups
category: pattern
tags: [building, scale, glb, differential, pathway, sign, Squidward, KrustyKrab]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary
When a GLB bundles a building body + pathway/sign into one file, the pathway/sign can dominate the max-dim bbox and compress the building body. Apply a per-child scale multiplier AFTER the uniform scale computation to boost just the building body.

## Details

### Problem
Yanez Designs (Sketchfab) GLBs for Squidward's House and Krusty Krab bundle:
- The actual building (head/restaurant) as one named group node
- A pathway/sign as a sibling group node far in front (large Z extent)

The large Z extent of the pathway/sign dominates `max(X,Y,Z)` in `computeBuildingScale`, causing the scale factor to compress the building body to a fraction of target height. Squidward head was ~518wu; Krusty Krab building was ~288wu — both looked tiny vs adjacent buildings.

### Solution: `childScaleOverrides` field on BUILDING_MODELS

```typescript
interface BuildingConfig {
  // ... other fields ...
  /**
   * Differential scale multipliers applied to named child Object3D nodes.
   * Keys are Three.js-sanitized GLTF node names (non-word chars → '_').
   * Applied BEFORE mergeStaticMeshesByMaterial so scales bake into vertex positions.
   */
  childScaleOverrides?: Record<string, number>;
}
```

### Implementation

```typescript
function applyChildScaleOverrides(scene: THREE.Object3D, overrides: Record<string, number>): void {
  if (!overrides || Object.keys(overrides).length === 0) return;
  scene.traverse((child) => {
    const factor = overrides[child.name];
    if (factor != null && factor !== 1) {
      child.scale.multiplyScalar(factor);
    }
  });
}
```

**Critical ordering in useMemo:**
1. `stripDecorativeMeshes(c)` — must run first
2. `stripGroundPlanes(c)` — removes flat base planes
3. `computeBuildingScale(c, targetMD)` — computes uniform scale (uses full bbox including pathway/sign)
4. `c.updateMatrixWorld(true)` — ensure matrices current before override
5. `applyChildScaleOverrides(c, config.childScaleOverrides)` — boost building body only
6. `c.updateMatrixWorld(true)` — propagate override to descendants
7. `mergeStaticMeshesByMaterial(c)` — merges meshes; bakes matrixWorld (which now includes override) into vertex positions

**Why before merge matters:** `mergeStaticMeshesByMaterial` snapshots each mesh's `matrixWorld` (relative to root) and bakes it into vertex positions. After the merge, the parent group nodes exist as empty containers — the scale we set is now baked. If we applied overrides AFTER the merge, the group nodes would be empty and the override would have no effect.

### Node name resolution

Three.js GLTFLoader sanitizes GLTF node names: `name.replace(/[^\w-]/g, '_')`.

- `"Squidward's House"` → `"Squidward_s_House"` (apostrophe → `_s_`)
- `"The Krusty Krab"` → `"The_Krusty_Krab"` (spaces → `_`)
- `"Stones"` → `"Stones"` (unchanged)
- `"Pole"` → `"Pole"` (unchanged)
- `"Enter Sign"` → `"Enter_Sign"` (space → `_`)

Verify with `@gltf-transform/core`:
```js
const { NodeIO } = require('@gltf-transform/core');
const io = new NodeIO();
const doc = await io.read('model.glb');
doc.getRoot().listNodes().forEach(n => console.log(n.getName(), n.getMesh() ? 'MESH' : ''));
```

### Active overrides (2026-05-18)

| Building | `targetMaxDim` | Override | Node | Factor | bodyAnchorChild | Result |
|---|---|---|---|---|---|---|
| `memory-rag` (squidward-house.glb) | 1400 | `childScaleOverrides` | `Squidward_s_House` | 1.4× | `Squidward_s_House` | Head body ~1010wu, stepping stones at base; head center at slot |
| `mcp-tool-use` (krusty-krab-v2.glb) | 1400 | `childScaleOverrides` | `The_Krusty_Krab` | 1.5× | `The_Krusty_Krab` | Restaurant ~605wu, sign/pole at base; restaurant center at slot |

### bodyAnchorChild — companion field for placement fix

The `childScaleOverrides` alone fixes SIZE but not PLACEMENT. When a GLB has body + forward-extending pathway/sign, the full-bbox center (used by `computeBuildingScale`) is pulled toward the pathway. The inner group then anchors that combined center to the ring slot → building body is behind the slot, pathway is in front.

`bodyAnchorChild` (added 2026-05-18): after `childScaleOverrides` propagate via `updateMatrixWorld`, compute the body child's bbox center in scene-local space. Diff it against the saved full-bbox center, multiply by scale → world-space correction. Apply to `pivotOffsetX/Z`. The body center now lands at the slot.

See implementation in `GLBBuilding` useMemo → `if (config.bodyAnchorChild)` block.

IMPORTANT: `pivotZBias` is deprecated for buildings that use `bodyAnchorChild`. The two together double-offset and break placement. Remove `pivotZBias` when adding `bodyAnchorChild`.

### Gotcha: pivotOffsetY / grounding

`computeBuildingScale` computes `pivotOffsetY = bbox.min.y * scale` from the FULL scene (including pathway/sign). Child overrides run AFTER this, so they don't affect grounding. For Squidward the grounding is driven by the Stones node (lowest Y), not the head. The head becomes bigger but doesn't sink into the ground. ✓

### Gotcha: useMemo deps

Add `config.childScaleOverrides` AND `config.bodyAnchorChild` to the `useMemo` dependency array. Both are module-scope constant objects; `Object.is` always returns true so memo never re-invalidates — but deps must be listed for ESLint correctness.

## Context
User flagged Squidward's house and Krusty Krab as too small 3+ times across sessions. Root cause was bundled pathway/sign dominating the max-dim normalizer. `childScaleOverrides` implemented 2026-05-18. User then flagged placement (building pushed back toward ring). Root cause was full-bbox center vs body center. `bodyAnchorChild` implemented 2026-05-18 in `arena-buildings.tsx`.
