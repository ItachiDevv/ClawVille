---
title: Spline-following ribbon terrain stack (ground + sand + water)
category: pattern
tags: [spline, ribbon, terrain, reef-race, low-poly, MeshLambertMaterial, flatShading]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary
Replace a rectangle water plane with a proper layered terrain stack: ground → sand ribbon → water ribbon, all driven from the same spline.

## Details

A rectangle plane for a winding river renders as a "swimming pool" — filling the entire bounding box with water color, with props floating inside it.

The correct approach: sweep triangle-strip ribbons along the spline centerline.

```ts
function buildWaterRibbonGeo(spline, samples: number, yOffset: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= samples; i++) {
    const t  = i / samples;
    const c  = spline.centerlineAt(t);   // Vec2 {x, z}
    const n  = spline.normalAt(t);        // Vec2 (90° CCW of tangent)
    const hw = spline.widthAt(t);         // half-width

    // Left edge
    positions.push(c.x + n.x * hw, yOffset, c.z + n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(0, t);

    // Right edge
    positions.push(c.x - n.x * hw, yOffset, c.z - n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(1, t);

    if (i < samples) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  return geo;  // 128 tris for 64 samples — trivial budget
}
```

For the sand ribbon, use `halfWidth + SAND_EXTRA_HW` (e.g. 120wu) instead of bare halfWidth.

### Layering order
- Ground plane at y=-1 (below river bed at y=0): `PlaneGeometry` rotated -π/2, grass green `#7cb342`
- Sand ribbon at y=0.5: `halfWidth + 120wu`, cream `#e8d5a8`
- Water ribbon at y=40: `halfWidth` exactly, opaque cyan `#4ec5e8`
- Bank walls (vertical quads from SplineTrack): recolor to match grass `#7cb342` or set `visible=false`

### Scenery props
Props must spawn BEYOND the bank edge: `centerline ± normal * (halfWidth + xJitter)`.
With halfWidth up to 500wu, xJitter must be ≥120wu to clear the sand ribbon.
Recommended minimums: trees=350-450wu, rocks=200-250wu, fence=80wu (at sand edge), grass tufts=150wu.

### Materials: always MeshLambertMaterial + flatShading
Matches the low-poly aesthetic and is Iris Xe safe (no ShaderMaterial).
Water ribbon: OPAQUE, no transparent/depthWrite=false — see-through water looks wrong on mobile.

### HEMI_GROUND_COLOR
Match the ground plane: `'#7cb342'` so up-bounce ambient light tints everything with grass green.

## Context
Reef Race v2. First pass (commit b4006c3e) used a rectangle PlaneGeometry(2400, 20000) which
covered the entire bounding box with solid cyan — no ground visible anywhere, props floating in water.
This pattern fixed it in one pass. Verified build-clean 2026-04-29.
