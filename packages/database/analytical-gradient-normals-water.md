---
title: Analytical gradient normals for height-field water displacement
category: pattern
tags: [water, shader, normals, wave, analytical-derivative, finite-difference, glsl]
date: 2026-06-01
confidence: high
threejs_version: r182
---

## Summary
Compute displaced-surface normals analytically by evaluating the displacement function at 3 points (center + 2 finite-diff samples) and using the height-field normal formula, so specular highlights ride the wave crests.

## Details

```glsl
// Calm amplitudes (2026-06-01 v2): ±2.5wu total — gentle undulation at kart speed.
// Halved temporal speeds so surface evolves slowly relative to forward motion.
float dispY(float px, float pz, float t) {
  return  sin(px * 0.005 + pz * 0.003 - t * 0.45) * 1.4
        + sin(px * 0.009 - pz * 0.006 - t * 0.70) * 0.7
        + sin((px + pz) * 0.003 - t * 0.30)        * 0.4;
}

void main() {
  float eps = 2.0;  // finite-diff step (wu)
  float y0 = dispY(position.x,       position.z,       uTime);
  float yx  = dispY(position.x + eps, position.z,       uTime);
  float yz  = dispY(position.x,       position.z + eps, uTime);

  // Height-field normal: tangentZ × tangentX gives +Y dominant result.
  // Equivalent to normalize(cross(vec3(0,yz-y0,eps), vec3(eps,yx-y0,0))).
  vNormal = normalize(vec3(-(yx - y0), eps, -(yz - y0)));
}
```

Fragment uses `normalize(vNormal)` instead of hardcoded `vec3(0,1,0)` — specular highlight then visibly tracks wave crests as camera moves.

**Crest foam** via `vDisp` varying: pass `y0` as `vDisp`, normalize to [0,1] using the actual max amplitude as divisor: `dispNorm = vDisp/2.5*0.5+0.5` (for ±2.5wu). Then `smoothstep(0.60, 0.75, dispNorm)` — wider gate than needed for large waves so gentle waves still show some foam.

**Cross product orientation gotcha**: `cross(tX, tZ)` gives N.y < 0 (wrong). Must use `cross(tZ, tX)` OR the direct formula `normalize(-(yx-y0), eps, -(yz-y0))`.

**UV scroll for rushing river**: downstream-dominant (V-axis), rates 0.10/0.18 UV/s (not 0.03/0.06). At UV scale 12 over 28000wu track = ~5040wu/s apparent scroll — matches kart speed feel.

**Flow streaks** (faint current lines): `fract(vUv.y*6.0 - t*0.35)` × smoothstep band × `0.015` brightness add. Keep the multiplier ≤ 0.02 — at 0.06 the dark inter-band negative space reads as dark horizontal banding rather than current lines. The perceptual problem is high inter-band contrast, not the bright bands themselves.

## Context
Shipped in water-surf.tsx for ClawVille Reef Race v2 (2026-06-01 v1, calmed 2026-06-01 v2). v1: analytical gradient normals replaced flat vec3(0,1,0) normal — specular highlights now ride wave crests. v2: excessive ±9wu amplitude (octaves 4.5/3.0/1.5) heaved aggressively faster than forward motion; calmed to ±2.5wu (1.4/0.7/0.4) + halved temporal speeds. Flow streak contrast reduced 4× to eliminate dark-band striping artifact.
