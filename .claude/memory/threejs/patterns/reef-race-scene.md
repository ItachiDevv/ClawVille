---
title: Reef Race 3D scene — per-client chase-cam + track + ghost
category: pattern
tags: [reef-race, chase-cam, TubeGeometry, CatmullRomCurve3, InstancedMesh, ghost, activity]
date: 2026-04-23
confidence: high
threejs_version: r170+
---

## Summary

Full scene architecture for the Reef Race activity. Key decisions: per-client chase-cam (one frustum), TubeGeometry track (radialSegs=4), merged checkpoint gates, InstancedMesh pickups with zero-scale hiding.

## Details

### Chase-cam
- One PerspectiveCamera per client, follows self player only.
- `CAMERA_OFFSET = (0, 200, -350)` in player-local space; rotated by player heading each frame.
- Lerp factor: `lerpFactor = Math.min(1, 5.0 * delta)` — smooth without overshoot.
- No OrbitControls — fully procedural in `useFrame`.
- Module-scope scratch vectors (`_targetPos`, `_camPos`, `_lookAt`, `_rotatedOffset`) — no per-frame allocations.

### Track
- `TubeGeometry(CatmullRomCurve3, 200, 150, 4, true)` — radialSegs=4 keeps quad count minimal.
- Guardrails: 64 segment BoxGeometry slices per side, `applyMatrix4()` for world position, then `mergeGeometries()` → 2 draw calls.
- DO NOT create a `THREE.Mesh` just to get a matrix — compute `Matrix4.compose(pos, quat, scale)` directly, avoids TS BoxGeometry type constraint.
- Coral decorations: 3 InstancedMesh (one per GLB type), seed-based deterministic placement.

### Checkpoint gates
- All 18 geometry pieces (2 pillars + 1 bar per gate) merged by material color → 2 draw calls.
- `mergeGeometries()` from `three/examples/jsm/utils/BufferGeometryUtils.js` — dispose input geos after merge (data is copied, safe per solutions/merge-geometries-dispose-order-safe.md).

### Ghost kart
- `SkeletonUtils.clone()` + immediate `frustumCulled=false` traverse.
- Semi-transparent: traverse all mesh children, `material.clone()`, set `transparent=true`, `opacity=0.45`.
- 10Hz GhostFrame[] path — linear interpolation with ring-buffer-aware sequential scan (O(1) amortized).
- Path looped with modulo: `ghostMs = path[0].t + (elapsedMs % pathDuration)`.
- `drei <Html>` label — no `distanceFactor` (causes per-frame recompute).

### Pickup boxes
- `InstancedMesh(BoxGeometry, MeshStandardMaterial, 16)` — safe on WebGPU.
- Hidden via `mesh.setMatrixAt(i, zeroScaleMatrix)` — instance stays in draw call, just invisible.
- `mesh.rotation.y += delta * 0.8` — 1 mutation for all 16 instances per frame.
- Canvas texture created at module scope (not per-mount): `getPickupTexture()` pattern.

### Boost FX
- Trail: pre-allocated `BufferGeometry` with `TRAIL_MAX_POINTS * 2` vertices (ribbon quad strip).
  Ring buffer head advances per frame; positions mutated in-place, `posAttr.needsUpdate = true`.
- Speed cones: `InstancedMesh(CylinderGeometry, MeshBasicNodeMaterial, 12)`.
  TSL `opacityNode: sin(time.mul(8).add(instanceIndex.toFloat().mul(0.5))).mul(0.5).add(0.5)`.
  Wrap in try/catch — `instanceIndex` TSL node may not be available in all build contexts; degrade to `mat.opacity = 0.5`.

### Store extension (additive)
- Add `reefRace: ReefRaceState` field to ActivityState.
- Add `reefRace` to `emptyState()` pick list.
- `event.lap_completed` case was a no-op — update it to push into `reefRace.laps`.
- `pushLap()` and `setGhostPath()` actions added.

### Reef Glider player scene graph (Phase 1 §4, 2026-04-24)

```
groupRef  (world XZ pos + Y rotation; scale=[20,20,20])
  └── gliderRef  (position.y = KART_Y_ABOVE_TRACK/KART_SCALE = 0.25 local; rotation.z = bank tilt)
        ├── gliderMesh  (shared module-scope BoxGeometry 2.5×0.25×5 + MeshStandardMaterial '#1e293b')
        └── riderMountRef  (position = RIDER_MOUNT_OFFSET_DEFAULT [0, 0.6, -0.5]; rotation.z = 0 always)
              └── clonedScene  (avatar GLB, color-tinted via traverse)
```

Key invariants:
- `gliderRef.rotation.z` = bank tilt; `riderMountRef.rotation.z = 0` always — rider stays level.
- `group.position.y = 0`; Y elevation is `gliderRef.position.y = KART_Y_ABOVE_TRACK / KART_SCALE`.
- Shared BoxGeometry + MeshStandardMaterial created ONCE at module scope — never disposed (page-lifetime).
- Bob: `riderMount.position.y = RIDER_MOUNT_OFFSET_DEFAULT[1] + sin(t * 1.2 * 2π) * 2` local units.
- Bob accumulator in `_bobTime: Record<string, number>` module-scope scratch. No per-frame alloc.
- PR #62 interpolation (4-snap ring, lerpAngle, INTERP_DELAY_MS=100) unchanged.
- Color tint on avatar MeshStandardMaterial children unchanged (traverse + clone pattern).
- entity.species deferred to Phase 1.5 (C8 fix) — Phase 1 uses lobster.glb always.

## Context
Shipped in chunk #6 of Q2 Activity Portals. Pairs with chunk #5 (sim, PR #23).
Phase 1 §4 Reef Glider added 2026-04-24 (SHA 73900ad).
Performance: ≤70 draw calls, ≤220k tris (+1 draw call per player for board), 1×512² shadow, 0 post-processing.
