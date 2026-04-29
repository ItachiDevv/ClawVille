---
title: Variable cliff band width via mulberry32 seeded hash — German River realism
category: pattern
tags: [reef-race, rocky-cliffs, spline, procedural, hash, deterministic]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary
Replace constant `LATERAL_MAX` with per-section mulberry32 hash yielding `[BAND_MIN, BAND_MAX]` wu — organic non-uniform cliff silhouette matching photogrammetric river references.

## Details

```ts
// Pure, deterministic — no time/random state
function mulberry32(seed: number): number {
  let s = (seed >>> 0) + 0x6D2B79F5;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

function lateralMax(sectionIdx: number): number {
  return BAND_MIN + (BAND_MAX - BAND_MIN) * mulberry32(sectionIdx + 7919);
}
// Then inside rock placement loop: replace LATERAL_MAX with lateralMax(si)
```

**Why +7919 seed offset?** Avoids degenerate low-entropy values at small indices.  
**Range in ClawVille:** BAND_MIN=180wu, BAND_MAX=600wu.

## Safety bounds-check (iter-8)
At narrowest corridor (coral hw=880):
- fat band center: 880+600=1480wu; inner edge 1480−347=1133wu > 880. SAFE.
- thin band center: 880+180=1060wu; inner edge 1060−347=713wu < 880. Rocks overhang slightly — intentional visual richness.

## Context
Surfaced 2026-04-29 iter-8 after user referenced German River (Jeffrey Tuhtan, Sketchfab) photogrammetry. Real cliff borders bulge IN and OUT — constant lateral width is the tell of procedural code. Also widened SCALE range 50-70 → 40-90 for height variation.
