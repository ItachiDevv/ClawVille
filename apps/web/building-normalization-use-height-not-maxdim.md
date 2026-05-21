---
title: Building GLB normalization — use max(X,Y,Z) NOT size.y (Phase 6.2 REVERSAL)
category: gotcha
tags: [buildings, normalization, scale, bounding-box, aspect-ratio]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary

**REVERSED 2026-05-18 (Phase 6.2).** This gotcha originally said "use size.y, not max". That was correct for R=72/100 ring where targetHeight was small (~800-1500wu) and arc spacing was tight. At R=160 with arc spacing 2680wu and larger targetMaxDim values (1000-1400wu), the problem is opposite: Y-only normalization causes wide/squat buildings (Chum Bucket, Patrick's Rock) to balloon in XZ relative to tall/narrow buildings.

**Correct rule (Phase 6.2+):** use `max(X, Y, Z)` normalization (`targetMaxDim`). See `patterns/building-maxdim-normalization.md`.

## What went wrong (original 2026-04-16 context)

At R=72 ring with small targetHeight=800wu, `max(w,h,d)` normalized wide buildings by their XZ dimension, crushing their height to 200-400wu. Fix was to use size.y.

## What went wrong (Phase 6.2 context)

At R=160 ring with larger targetMaxDim=1000-1300wu, Y-only normalization caused:
- Chum Bucket (squat cylinder, native height < native width): Y-normalize → XZ inflated 2×, reported as "gigantic"
- Patrick's Rock (wide dome): Y-normalize → dome ballooned past neighboring buildings
- Squidward's House (tall narrow Easter Island head): Y-normalize → correct height, but appeared "tiny" relative to over-inflated neighbors

## Fix (Phase 6.2)

```ts
// computeBuildingScale in arena-buildings.tsx
const maxDim = Math.max(size.x, size.y, size.z);
let scale = maxDim > 0.001 ? targetMaxDim / maxDim : 1;
// MAX_FOOTPRINT cap still prevents XZ sprawl for 2:1 aspect buildings
const xzMax = Math.max(size.x * scale, size.z * scale);
if (xzMax > MAX_FOOTPRINT) scale *= MAX_FOOTPRINT / xzMax;
```

## Which to use

The right normalization depends on what you're optimizing for:
- **tight ring, small targets (R=72-100):** Y-height normalization keeps building silhouettes consistent in height
- **wide ring, large targets (R=160+):** max-dim normalization prevents wide buildings from dominating; the extra arc space absorbs the variation in building heights

At Phase 6.2 ring (R=160, 2680wu arc spacing), max-dim is correct.

## Context

ClawVille `arena-buildings.tsx`. Original gotcha written 2026-04-16. Reversed 2026-05-18 as Phase 6.2 ring expansion changed the dominant failure mode.
