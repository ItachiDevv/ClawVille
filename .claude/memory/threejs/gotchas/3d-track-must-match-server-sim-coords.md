---
title: 3D track curve MUST match server sim coordinate system — entities float off-track
category: gotcha
tags: [reef-race, coordinate-system, track, sim, entity-position, CatmullRomCurve3]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

If the 3D track curve control points don't match the server's track coordinate system, entity positions from the server land in the wrong place relative to the visual track — players appear floating in empty space.

## Details

The Reef Race server sim defines the track as an ellipse:
```ts
// apps/api/src/services/activity/sim/reef-race-config.ts
REEF_TRACK_A = 1100  // X half-axis
REEF_TRACK_B = 700   // Y half-axis (server Y → Three.js Z)
reefCenterlineAt(t) = { x: 1100*cos(π/2 + 2πt), y: 700*sin(π/2 + 2πt) }
// t=0 → (0, 700) → Three.js (0, 0, 700)
```

The 3D scene's entity mapping: `entity.x → THREE.x`, `entity.y → THREE.z`.

If the visual track uses different control points (e.g., a custom chicane layout starting at z=-2400), entity positions at sim coords (0, 700) map to Three.js (0, 0, 700) — but the visual track's start is at (0, 0, -2400). The player is 3100 units from the track.

**Fix**: generate the 3D CatmullRom control points by sampling the SAME formula as the server:

```ts
function makeEllipseTrackPoints(): THREE.Vector3[] {
  const A = 1100; // REEF_TRACK_A
  const B = 700;  // REEF_TRACK_B
  const N = 16;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const angle = Math.PI / 2 + 2 * Math.PI * t;
    pts.push(new THREE.Vector3(A * Math.cos(angle), 0, B * Math.sin(angle)));
  }
  return pts;
}
```

## Context

Reef Race activity, 2026-04-24. The original 3D track had a custom CatmullRom curve with chicanes and hairpins that looked good visually but had nothing to do with where the server placed entities. The visual fix (flat ribbon) alone doesn't help if entities are 3000+ units from the track. Both the track shape AND the coordinate match must be correct.

**Rule**: whenever you design a 3D activity scene track, start with the server sim constants and derive the visual track from them — never design the visual separately and hope they match.
