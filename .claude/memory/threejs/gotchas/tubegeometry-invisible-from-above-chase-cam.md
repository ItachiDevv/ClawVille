---
title: TubeGeometry track invisible from above — use flat ribbon BufferGeometry
category: gotcha
tags: [TubeGeometry, track, FrontSide, backface-culling, chase-camera, reef-race]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

`TubeGeometry` with small `radialSegments` (e.g., 4) is a HOLLOW TUBE — a chase camera positioned above and behind the player sees only the outer top-face edge (very thin) or back-faces (culled). The track is nearly invisible.

## Details

For a CatmullRomCurve3 lying in the XZ plane (y=0), TubeGeometry with `radialSegments=4` produces a square cross-section. The top face has normal `+Y`. The chase camera at `(0, 200, -350)` relative to the player is ABOVE the tube centerline. With `FrontSide` (default), the top face IS front-facing from above — but the face is only as tall as the tube's side-face thickness. From typical chase camera angles, the visible surface area is nearly zero: you see the track edge-on.

Additionally, the track is HOLLOW. Looking down from above, you're looking at a tube's cross-section — you see the top face from outside but it's a 2D ring, not a solid road surface.

**The fix**: replace with a flat ribbon `BufferGeometry`:
- Sample the curve at N intervals
- At each sample, compute `right = normalize(tangent × worldUp)` in XZ plane
- Left vertex: `pos - right * halfWidth`, right vertex: `pos + right * halfWidth`
- All normals = `(0, 1, 0)` (pointing up)
- Material: `side: THREE.DoubleSide` (visible from any camera angle)

This creates a flat road surface at y=0, clearly visible from the chase camera above.

```ts
function buildFlatRibbonGeo(curve, segments, halfWidth) {
  const positions = [], normals = [], uvs = [], indices = [];
  const _pt = new THREE.Vector3(), _tan = new THREE.Vector3();
  const _right = new THREE.Vector3(), _up = new THREE.Vector3(0,1,0);

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, _pt);
    curve.getTangentAt(t, _tan).normalize();
    _right.crossVectors(_tan, _up).normalize();

    positions.push(_pt.x - _right.x * halfWidth, 0, _pt.z - _right.z * halfWidth);
    normals.push(0, 1, 0); uvs.push(0, t);
    positions.push(_pt.x + _right.x * halfWidth, 0, _pt.z + _right.z * halfWidth);
    normals.push(0, 1, 0); uvs.push(1, t);

    if (i < segments) {
      const b = i * 2;
      indices.push(b, b+1, b+2, b+1, b+3, b+2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}
```

## Context

Reef Race activity. Track was nearly invisible after the three/webgpu → plain three port (PR #59). The port itself was correct; the track was already effectively invisible due to the hollow tube shape. Second bug: the CatmullRom control points didn't match the server's ellipse (`REEF_TRACK_A=1100, REEF_TRACK_B=700`) so entity positions from the server landed off-track. Both fixed 2026-04-24.
