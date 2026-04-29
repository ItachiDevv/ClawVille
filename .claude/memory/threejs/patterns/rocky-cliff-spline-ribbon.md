---
title: Rocky cliff ribbon — stepped cross-section profile swept along a Catmull-Rom spline
category: pattern
tags: [spline, canyon, cliff, vertex-colors, flatShading, mergeGeometries, BufferGeometry, river]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

Build a stepped rocky canyon wall on both sides of a spline-following river in
one merged BufferGeometry (single draw call) using `MeshStandardMaterial`
with `flatShading: true` and baked vertex colours.

## Details

### Profile shape (5 verts per side)

Each cross-section at parametric `t` has 5 vertices per side (left/right):

| Vert | Lateral offset from centreline | Y world |
|------|-------------------------------|---------|
| v0   | `hw + 250`                    | `+10`   |
| v1   | `hw + 100`                    | `  0`   |
| v2   | `hw + 0`                      | `-15`   |
| v3   | `hw - 60`                     | `-35`   |
| v4   | `hw - 30`                     | `-50`   |

`hw = clientSpline.widthAt(t)` (half-channel width at that point).

v4 is slightly inward of v3 (toe-in at the channel floor) — mimics natural
rock undercutting at the waterline and looks more organic than a straight face.

### Y coordinates are in the FUTURE canyon state

These values assume:
- Ground at y = 0
- Water surface at y = -40 (after orchestrator lowers from +40)
- River bed at y = -50

When the orchestrator updates `WATER_Y` and kart Y accordingly, the cliff
top (y=+10) will sit above ground, and the inner-top vertex (y=-15) will
be 25wu above the new water surface — the cliff kisses the waterline
exactly where you'd see it in a real canyon.

### Winding order for inner-facing tris

The canyon walls face INWARD (toward the centreline). From inside the channel:

```ts
if (sign > 0) {   // Left bank
  indices.push(a0, a1, b0);
  indices.push(a1, b1, b0);
} else {          // Right bank
  indices.push(a0, b0, a1);
  indices.push(a1, b0, b1);
}
```

Where `a0/a1` are profile verts vi/vi+1 at cross-section i, and `b0/b1`
at cross-section i+1. This gives CCW winding when viewed from the channel
centre for both left and right banks.

### Triangle budget

```
(N-1) × (PROFILE_VERTS-1) × 2 sides × 2 tris/quad
= 79  ×        4           ×    2    ×     2
= 1264 tris
```

With N=80 cross-sections and `flatShading: true`, each strip becomes a
distinct flat facet — the result looks like layered rock strata.

### Vertex colour strategy

Pure random colour per vertex looks like TV static. Banded rock striations
need cross-section-level colour variation with long "runs" of similar tone.

Solution: slow sine wave (period ≈ 10 sections) drives overall brightness
within the [dark, light] palette range, with a small per-section hash
jitter to break up the regularity:

```ts
const wave   = Math.sin(si * 0.63 + 1.7) * 0.5 + 0.5;     // 0–1
const jitter = hashI(si * 7 + vi * 13) * 0.30 - 0.15;      // ±0.15
const t      = Math.max(0, Math.min(1, wave + jitter));

const r = _COL_DARK.r + (_COL_LIGHT.r - _COL_DARK.r) * t;
// … same for g, b
```

Lower profile vertices (v3, v4 — underwater shadow zone) get a `* 0.75`
darkness multiplier on top, simulating ambient occlusion at the cliff base.

Rock palette (ClawVille):
- base `#8a7a6b` (muted sand-brown)
- light `#9c8a78` (lighter stone)
- dark  `#6e5e52` (darker rust-shadow)

### mergeGeometries — dispose inputs after merge

```ts
const _leftGeo  = buildCliffSideGeo(+1);
const _rightGeo = buildCliffSideGeo(-1);
const _cliffGeo = mergeGeometries([_leftGeo, _rightGeo], false);
_leftGeo.dispose();
_rightGeo.dispose();
```

Inputs are safe to dispose after merge — `mergeGeometries` copies typed
arrays via `TypedArray.set()`, so the merged geometry is independent.

### Material

```ts
const _cliffMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading:  true,
  roughness:    0.9,
  metalness:    0.05,
  side:         THREE.FrontSide,
});
```

`receiveShadow` goes on the Mesh/JSX, NOT in the material constructor
(it is an Object3D property, not a material property — TypeScript will reject it).

### Performance invariants

- Geometry and material built at module scope (zero per-frame work).
- `frustumCulled={false}` — canyon walls extend across the whole track.
- `matrixAutoUpdate={false}` — static world position.
- `castShadow={false}` — cliffs don't need to cast shadows.

## Context

Built for ClawVille Reef Race v2 canyon depth pass (2026-04-29).
The `clientSpline` singleton from `reef-race-spline-instance.ts` provides
`centerlineAt`, `normalAt`, and `widthAt` — all Vec2 `{x, z}` (XZ plane).
Y is controlled entirely by the profile table above.
