---
title: Organic foam cluster technique — two-term softField × clusterMod
category: pattern
tags: [water, shader, foam, simplex-noise, glsl, organic, iris-xe]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary
Replace harsh PS2-era linear foam stripes with organic soft clusters using two multiplicative terms in the fragment shader.

## Details

The "PS2 stripe" problem is caused by a narrow smoothstep range driving foam from a 1D noise field:
```glsl
// BAD — 0.07 range produces hard linear stripes
float foamMask = smoothstep(0.55, 0.62, flowFoam);
```

The fix uses two terms multiplied together:

```glsl
// (a) Wide softField: 0.38 range (5.4× softer) — foam gradually emerges
float softField  = smoothstep(0.40, 0.78, flowFoam);

// (b) clusterMod: fine-scale simplex at UV*24 breaks remaining linear pattern
//     into irregular organic patches.
//     Inner snoise()*0.5+0.5 maps [-1,1] → [0,1]; mix(0.5,1.0,...) keeps
//     range [0.5,1.0] so it only dims, never fully zeroes, existing foam.
float clusterMod = mix(0.5, 1.0, snoise(vUv * 24.0 + vec2(0.0, uTime * 0.015)) * 0.5 + 0.5);

// (c) Combined: intensity scalar 0.7 preserved from original
float whiteCap   = softField * clusterMod * 0.7;
baseColor = mix(baseColor, foamColor, whiteCap);
```

Key decisions:
- `mix(0.5, 1.0, ...)` range: never drops to 0 (would erase all foam); 0.5 min gives 50% dimming at darkest cluster → "foam flecks" not "foam gaps"
- Scale 24 on clusterMod: ~24 oscillations across ribbon width; visible organic texture without aliasing from altitude
- `uTime * 0.015` scroll: very slow (full period ~420s) so clusters drift lazily rather than strobing

## Iris Xe budget
This is the 3rd snoise call per fragment (water-surf.tsx has 2 existing calls for flow layers + this 1 for clusters). Total 3 simplex noise calls per fragment is well within Iris Xe budget (~25 ops each = ~75 ops; budget ~300+ ops).

## Context
Shipped in water-surf.tsx for Reef Race v2 river (commit during 2026-04-29 session). User feedback: original `smoothstep(0.55, 0.62)` looked "like a 2003 PS2 game — jagged harsh stripes". This technique eliminates the linear banding while keeping foam intensity at the same 0.7 scalar.
