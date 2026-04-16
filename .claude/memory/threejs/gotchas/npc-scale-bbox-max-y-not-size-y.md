---
title: NPC bbox normalization must use bbox.max.y not size.y
category: gotcha
tags: [npc, bbox, normalization, scale, skinned-mesh, pivot]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary

When normalizing NPC height, use `bbox.max.y` (above-pivot visual extent) as the divisor, NOT `size.y = max.y - min.y`. Using `size.y` inflates the denominator when geometry extends below the pivot (localMinY < 0), compressing the rendered body below the target height.

## Details

Most humanoid/anime GLBs have their pivot at the waist or some other point above the feet. The geometry extends below the pivot origin, giving `min.y < 0`. At scale=1:
- `size.y = max.y - min.y = 1.5 - (-0.5) = 2.0` (includes underground extent)
- `bbox.max.y = 1.5` (visual body above ground)

Using `size.y=2.0`: `scale = 140 / 2.0 = 70` → visual body renders at `70 * 1.5 = 105` wu (too short)
Using `max.y=1.5`: `scale = 140 / 1.5 = 93.3` → visual body renders at `93.3 * 1.5 = 140` wu (correct)

Also: tighten `NPC_SCALE_CLAMP_MAX` to `CHARACTER_HEIGHT / 0.5` (was `/ 0.01 = 14000`). Some GLBs have only tiny non-skinned accessory props (a coin, a pixel of screen glass). Their bbox max.y ≈ 0.05 → computed scale = 2800. This slips past the old 14000 clamp. At scale=2800, the SkinnedMesh body renders at 2800 * 0.68 ≈ 1892 wu (Mr.Krabs bug). Clamp at CHARACTER_HEIGHT/0.5 = 280 catches this.

## scaleOverride must be unconditional

If a model has a `scaleOverride`, apply it ALWAYS — not just as fallback for out-of-clamp values. With the old approach (use computed if in-clamp, fallback to override if out-of-clamp), a model with computed=2000 and scaleOverride=148 would use 2000 (within [0.70, 14000]) and ignore the override. Make override take priority:

```ts
if (modelCfg.scaleOverride != null) {
  s = modelCfg.scaleOverride;  // unconditional
} else if (computed >= CLAMP_MIN && computed <= CLAMP_MAX) {
  s = computed;
} else {
  s = Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, computed));
}
```

## Context

ClawVille location NPCs: Mr.Krabs rendered at 1892 wu, Sandy at 482 wu. SpongeBob, Squidward, etc. rendered at 27-89 wu (target 120-160). All three bugs traced to this single root cause.
