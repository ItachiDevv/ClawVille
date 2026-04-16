---
title: applyStationaryIdleAnimation must NOT set rotation.y = PI + lookAround when used inside a parent group that already has facing baked in
category: gotcha
tags: [npc, rotation, facing, procedural-animation, LocationNpc, arena-location-npcs]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
`applyStationaryIdleAnimation` previously set `group.rotation.y = Math.PI + lookAround`, assuming the group it was applied to was the top-level model group responsible for the -Z model correction. In `arena-location-npcs.tsx`, it is applied to `animGroupRef` (INNER group), while the OUTER `groupRef` already has `facingRotY` (which includes +PI for -Z model correction). This stacked two +PI corrections, making all location NPCs face exactly 180° away from the village center.

## Details
The broken code was:
```ts
group.rotation.y = Math.PI + lookAround;
```

The fix — change to just the relative sway, no base PI:
```ts
group.rotation.y = lookAround;
```

The outer group owns the facing direction:
```tsx
<group ref={groupRef} scale={...} rotation={[0, facingRotY, 0]}>
  <group ref={animGroupRef}>  {/* applyStationaryIdleAnimation applied here */}
```

`facingRotY = Math.atan2(dx, dz) + Math.PI` already encodes the -Z correction.
Adding PI again in the inner group cancels the correction → NPCs face away.

## Context
Discovered in the 2026-04-13 deep 3D audit. Fixed in `procedural-animation.ts`.
The rule: `applyStationaryIdleAnimation` applies RELATIVE rotation sway only.
The parent group owns the absolute facing direction.
SpongeBob character models face +Z at rotation 0 (not -Z like lobster.glb).
The lobster at config-citadel uses `facingRotY` on the outer group correctly.
