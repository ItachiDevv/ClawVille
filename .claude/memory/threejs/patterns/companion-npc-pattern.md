---
title: Companion NPC pattern — passive passive presence beside primary
category: pattern
tags: [npc, location-npc, companion, clawville, arena-location-npcs]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary

Extend a primary-NPC config with an optional `companion` field to render a second
passive NPC beside the primary, using the same bbox-aware scale + pivot-offset logic.

## Details

### Type shape

```ts
type LocationNpcConfig = NpcModelConfig & {
  companion?: NpcModelConfig & {
    offsetX?: number;  // world-unit X offset from primary (default 80)
    offsetZ?: number;  // world-unit Z offset from primary (default 0)
  };
};
```

### Rendering

Extract a `NpcMesh` component that loads one GLB, normalizes scale, handles terrain
raycast + idle bob + procedural animation. `LocationNpc` renders primary (showLabel=true)
+ companion (showLabel=false, no chat routing).

Companion seed = primarySeed + 17 to stagger raycasts away from the primary on the
same 20-frame cycle.

### Companion offsets used in ClawVille

- Gary next to SpongeBob: `offsetX: 60, offsetZ: 0`
- Karen next to Plankton: `offsetX: 80, offsetZ: 0`

### DeferredNpcPreloads

Must iterate both `cfg.model` and `cfg.companion.model` to warm the useGLTF cache
before the Suspense boundary is hit.

## Context

Gary and Karen don't have their own buildings in the canonical SpongeBob layout.
They stand as companions at slots 0 (canvas-studio) and 7 (skill-forge) respectively.
Companion is a passive presence — agents interacting with the building chat with the
primary NPC only.
