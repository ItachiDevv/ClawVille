---
title: Arcade cel-shaded water — hard-step stripes + lateral wave-lines
category: pattern
tags: [water, shader, arcade, cel-shading, reef-race, step, foam, wave-lines]
date: 2026-04-29
confidence: medium
threejs_version: r182
---

## Summary

Pure-cyan flat water with binary hard-step foam stripes, lateral wave-line accents,
and pulsing edge foam — Wave Race 64 / OutRun style, no gradients.

## Details

### Key technique: hard step() everywhere

The central discipline is NO smoothstep. Every foam decision is binary:

```glsl
// foam stripes — ON or OFF, nothing in between
float foamMask = step(0.62, stripeNoise);

// edge foam — solid white band, not a fade
float edgeFoam = step(edgeDist, edgeWidth);

// wave-lines — step on fract() for thin lines
float waveLine = step(0.96, fract(vUv.y * 10.0 + uTime * 0.25));
```

### Why value hash (not simplex) for arcade foam

The bilinear hash (`hashV(floor(p)) + bilinear(fract(p))`) produces
rectangular grid artifacts at high frequency. This is INTENTIONAL — the
aliasing at high altitude looks like classic pixel-water from arcade games.
Simplex would produce smooth blobs that read as modern noise.

### Stripe visibility from altitude

Scale 28.0 on UV space = 28 cycles across UV.y range 0..1. At
top-down 2000-5000wu altitude the smooth approach aliases to grey smear;
the hard-step version stays visible as distinct cyan+white bands because
there's no anti-aliasing to blend them into mid-grey.

### Lateral wave-lines: the key arcade differentiator

```glsl
float waveLine = step(0.96, fract(vUv.y * 10.0 + uTime * 0.25 + vWorldPos.z * 0.0001));
color = mix(color, uColorAccent, waveLine * 0.85);
```

`fract(y * FREQ + time * speed)` = sawtooth wave; `step(0.96, ...)` = top 4%
= thin stripe. With 10 frequencies and speed 0.25, you get ~10 lines marching
forward — classic F-Zero / Wave Race visual signature.

### Pulsing edge foam

Width = 0.04 + sin(uTime * 3.0) * 0.01. Hard step on distance:
`step(edgeDist, edgeWidth)`. Pulsing at 3Hz gives rhythmic bow-wave feel.
No noise — the rhythm is the feature.

### Geometry

Exact same buildWaterRibbonGeo() as river-scene.tsx and water-surf.tsx:
64 cross-sections, spline-following ribbon at WATER_Y=-200. Geometry is
identical across all three implementations so the Critic can swap them.

## Context

Built as Implementer 2's entry in a 2-way water shader competition for Reef Race v2.
Implementer 1 (water-surf.tsx) uses smooth depth-gradient + smoothstep foam.
This file deliberately diverges: hard edges, saturated flat color, arcade aesthetic.
Critic/orchestrator selects winner based on visual comparison at all camera distances.

WATER_Y=-200 must match racing-karts.tsx and rocky-banks.tsx — cascade all four files
together if this value ever changes.
