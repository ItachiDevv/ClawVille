---
title: Building GLB normalization must use height (size.y), not max(w,h,d)
category: gotcha
tags: [buildings, normalization, scale, bounding-box, aspect-ratio]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
Normalizing building GLBs to `BUILDING_TARGET_HEIGHT` using `max(w,h,d)` produces
wildly varying visual heights for wide/squat models. Always normalize by `size.y`.

## Details

### What went wrong
`computeBuildingScale` used `maxDim = Math.max(size.x, size.y, size.z)`. For
architectural buildings that are wider or deeper than they are tall (e.g. salty-spitoon,
boating-school), `maxDim` was the width or depth — not the height. This clamped the
WIDTH to `BUILDING_TARGET_HEIGHT=800`, leaving the actual height far below 800.

### Measured effect in ClawVille
With `max(w,h,d)` normalization and BUILDING_TARGET_HEIGHT=800:

| Building | GLB | Rendered H | Rendered W |
|---|---|---|---|
| canvas-studio | pineapple-house | 346 | 800 |
| webhook-gateway | salty-spitoon | 416 | 1007 |
| voice-tower | boating-school | 380 | 1112 |
| security-fortress | building-submarine | 210 | 603 |
| memory-vault | bb-building | 800 | 554 |

Only 3/10 buildings reached the intended 800-unit height.

### Fix
Use `size.y` as the normalizing dimension. This makes every building exactly 800 units
tall; wide buildings remain wide but all stand at the correct height.

```ts
const h = size.y > 0.001 ? size.y : Math.max(size.x, size.y, size.z);
return BUILDING_TARGET_HEIGHT / h;
```

Fall back to `maxDim` only when `size.y ≤ 0.001` (completely flat mesh).

### When to deviate
If a building GLB is intentionally horizontal (e.g. a flat underwater bunker), add a
per-model override in `BUILDING_MODELS[id]` rather than changing the normalization strategy.

## Context
ClawVille `arena-buildings.tsx` — surfaced during the 2026-04-16 scale regression audit.
10 buildings measured; 7 were below BUILDING_TARGET_HEIGHT by 2-4x.
