---
title: Reef Race Phase 2 — static visual overlays (ribbons, hazards, apex markers)
category: pattern
tags: [reef-race, activity, flat-geo, module-scope, store-subscription, emissive]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

Pattern for adding server-authoritative static zone visuals to an activity scene:
server sends positions in RoomMeta, client builds meshes once from them, falling
back to local builders if snapshot.init hasn't arrived yet.

## Details

### Three-tier fallback for static zone positions

1. `s.room?.reefStaticZones` from activity store (server-authoritative, arrives in snapshot.init).
2. Local builder functions that mirror the server's computation exactly (same math, same constants).
3. Both use primitive identity subscription — `useActivityStore(s => s.room?.reefStaticZones)` — so re-renders fire only on init/reset, never on entity ticks.

### Module-scope geometry + material

All static overlays share one geometry + one material at module scope, never disposed:

```ts
const _ribbonGeo = new THREE.BoxGeometry(1, 4, 1); // scaled per mesh via mesh.scale
const _ribbonMat = new THREE.MeshStandardMaterial({ ... }); // shared across all ribbon instances
```

This means 2 draw calls for 2 ribbons, not 4. Scale and position set via `mesh.scale.set(...)` + `mesh.position.copy(...)` in `useEffect`, then `matrixAutoUpdate = false`.

### Placement without allocations

Ribbon orientation computed from a→b segment:
```ts
const angle = Math.atan2(_dir.x, _dir.z);
mesh.rotation.set(0, angle, 0);
mesh.scale.set(fullWidth, height, segmentLength);
mesh.matrixAutoUpdate = false;
mesh.updateMatrix();
```
No `new THREE.*` inside useFrame or useEffect. Module-scope scratch vectors only.

### useFrame emissive pulse — zero alloc

```ts
useFrame(({ clock }) => {
  _ribbonMat.emissiveIntensity = 0.45 + 0.25 * Math.sin(clock.elapsedTime * Math.PI * 2);
});
```
Mutates a float directly. No Vector3 or Matrix4 created.

### Hazard — TorusKnotGeometry flat on track

```ts
const _hazardGeo = new THREE.TorusKnotGeometry(1, 0.08, 24, 4);
// Placed at y=2, rotated -PI/2 to lay flat, scaled to hazard.radius
mesh.rotation.set(-Math.PI / 2, 0, 0);
mesh.scale.setScalar(hazard.radius);
```

`TorusKnotGeometry` at unit scale (1,0.08,24,4) is cheap: ~96 tris.
No useFrame animation — purely static.

### Apex markers — RingGeometry flat

```ts
const _innerRingGeo = new THREE.RingGeometry(0.75, 1.0, 32);
// Rotated -PI/2 to XZ plane, scaled to APEX_RING_RADIUS = 44wu
mesh.rotation.set(-Math.PI / 2, 0, 0);
mesh.scale.setScalar(APEX_RING_RADIUS);
```
Two geometries (inner/outer) sharing different materials. 4 draw calls total for 2 zones.

### Server-client constant sync

Client-side builders duplicate server constants with `_CLIENT` suffix and inline comments
pointing to the server file. This prevents import of server modules (which pull DB deps)
while keeping the math identical. Example:
```ts
const HAZARD_INSIDE_OFFSET_CLIENT = 150 * 0.40; // REEF_TRACK_HALF_WIDTH * 0.40 = 60wu
```

## Context

Reef Race Phase 2, ClawVille. Three static overlays: boost ribbons on long straights,
sea-urchin hazard patches at hairpins, apex feedback rings at hairpins.
Budget: 8 draw calls total (2+2+4). Under 70-call Iris Xe ceiling.
