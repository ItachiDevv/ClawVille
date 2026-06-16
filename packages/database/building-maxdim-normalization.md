---
title: Building scale max(X,Y,Z) normalization
category: pattern
tags: [buildings, scale, normalization, bounding-box, aspect-ratio]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary

Normalize building GLBs to `max(X, Y, Z)` of the bounding box (`targetMaxDim`), not Y-height alone. Prevents wide/squat buildings from ballooning in XZ relative to tall/narrow ones.

## Details

Prior approach used Y-height normalization:
```typescript
const scale = targetHeight / size.y;
```

Problem: a building with native size (10, 3, 10) normalized to targetHeight=1000 computes scale=333, giving an XZ footprint of 3330wu — wildly oversized.

Fix:
```typescript
const maxDim = Math.max(size.x, size.y, size.z);
const scale = maxDim > 0.001 ? targetMaxDim / maxDim : 1;
```

Now all buildings occupy a similar-sized bounding cube regardless of GLB authoring convention. Wide buildings (Chum Bucket, Patrick's Rock) stay within their target budget.

A `MAX_FOOTPRINT` cap still applies after max-dim scaling so a 2:1 aspect building (e.g. Salty Spitoon) can't sprawl past 1800wu:
```typescript
const xzMax = Math.max(size.x * scale, size.z * scale);
if (xzMax > MAX_FOOTPRINT) scale *= MAX_FOOTPRINT / xzMax;
```

`BUILDING_TARGET_HEIGHT = 800wu` is kept as the default fallback for the rare case where no `targetMaxDim` is specified.

## Context

ClawVille Phase 6.2 (2026-05-18). Y-only normalization had been the default since initial building ring. The bug became obvious at R=160 with 2680wu arc spacing — buildings needed to fill their footprint without either dwarfing neighbors or being invisible. Chum Bucket (squat cylinder) was reported as "gigantic" and Squidward (tall narrow) as "tiny" despite similar `targetHeight` values. Switching to max-dim fixed both simultaneously without asset modification.

Confirmed same pattern as `casino-interior.tsx computeAutoFit` (commit 166961d).
