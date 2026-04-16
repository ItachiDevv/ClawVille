---
title: NPC terrain-raycast stagger — seed MUST be integer, idToSeed() returns float
category: gotcha
tags: [terrain, raycast, performance, Date.now, synchronization, NPC, float, modulo]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
Using `(frame + seed) % N === 0` to stagger NPC raycasts fails silently if `seed` is a float — float modulo with strict `=== 0` almost never fires (probability ~0.001 per NPC). `idToSeed()` returns a FLOAT (0..10 with 2 decimal places), so you MUST wrap it with `Math.round()` before using it in a modulo stagger.

## Details

### The original bug (ALL NPCs sync to same frame)
```ts
const frame = Math.floor(Date.now() / 50);
if (frame % 3 === 0) { /* raycast — ALL NPCs hit this simultaneously */ }
```

### The attempted fix (introduced a silent regression)
```ts
const seed = useMemo(() => idToSeed(npc.id), [npc.id]); // FLOAT 0..10
const frame = Math.floor(Date.now() / 50);
if ((frame + seed) % 3 === 0) { /* NEVER fires — float modulo never === 0 */ }
```
`idToSeed` computes `(Math.abs(hash) % 1000) / 100`, producing values like 4.84, 1.90, 6.50.
`(integer + 4.84) % 3` produces e.g. 1.84 — never 0 with strict equality.
Tested with all 10 ClawVille NPC IDs: 0 fires in 1200 frames vs expected 60.

### The correct fix
```ts
// Integer seed — Math.round gives 0..10 integer, still unique per NPC
const seed = useMemo(() => Math.round(idToSeed(npc.id)), [npc.id]);
const frame = Math.floor(Date.now() / 50);
if ((frame + seed) % 3 === 0) { /* fires ~100 times per 300 frames, spread across NPCs */ }
```

The integer seed is still fine as an animation time-phase offset (seed added to elapsed time) — no change needed for `applyWalkAnimation` / `applyIdleAnimation` / `applyStationaryIdleAnimation`.

### For arena-location-npcs (elapsedTime-based frame counter)
Same fix — % 20 window, same float problem:
```ts
const frame = Math.floor(clock.elapsedTime * 60); // integer
const seed = useMemo(() => Math.round(idToSeed(zoneId)), [zoneId]); // integer
if ((frame + seed) % 20 === 0) { /* staggered raycast */ }
```

## Context
Diagnosed during 2026-04-13 3D audit. Fixes 3 and 6 in commit 669c604 introduced this regression. Corrected in commit bd37996. Affects `arena-npcs.tsx` and `arena-location-npcs.tsx`.
