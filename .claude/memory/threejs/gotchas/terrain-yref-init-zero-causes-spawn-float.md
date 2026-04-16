---
title: terrainYRef init at 0 causes pet to spawn 4 units above sand floor
category: gotcha
tags: [terrain, raycast, player-pet, spawn, position, float]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
Initializing terrainYRef to 0 when the sand floor sits at y=-2 causes the pet to spawn floating 4 units above the floor and visibly drift down over ~200ms.

## Details
`player-pet.tsx` keeps a smoothed terrain-Y in `terrainYRef`. The formula is:
```ts
group.position.y = terrainYRef.current + 2 + bob;
```
Sand floor is at `y = -2`. So the intended resting height is `-2 + 2 = 0` (flush with floor).

If `terrainYRef` initializes to `0`, the first-frame position is `0 + 2 = 2`. Since sand is at `-2`, the pet floats 4 world units above it and lerps down at `0.3` per raycast tick (every 3rd frame ≈ 50ms). The drift is visible over ~200ms.

**Fix:** initialize `terrainYRef` to `-2` so the spawn position is correct from frame 0.

```ts
// WRONG
const terrainYRef = useRef(0);

// CORRECT
const terrainYRef = useRef(-2);
```

## Context
Found in Round 4 final audit of ClawVille 3D code (2026-04-13). The bug is subtle — not a crash, just a visible 200ms drift on page load. Applied fix directly to player-pet.tsx.
