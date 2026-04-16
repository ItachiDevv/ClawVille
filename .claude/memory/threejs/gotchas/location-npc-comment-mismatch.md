---
title: arena-location-npcs JSDoc incorrectly stated +Z model — code was always correct
category: gotcha
tags: [arena-location-npcs, facing, comment, documentation, -Z, lobster]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
The JSDoc for `computeNpcPlacement` in `arena-location-npcs.tsx` said "NPC model default faces +Z" but the code correctly used `atan2(dx,dz) + Math.PI` (the -Z correction). The comment was wrong; the code was right.

## Details
The comment mismatch was: the JSDoc claimed `rotation [0,0,0] → faces +Z`, but the implementation adds `+Math.PI` which is the -Z model correction verified for `lobster.glb` (config-citadel NPC) and assumed for all SpongeBob character GLBs.

Fixed in 2026-04-13 audit — JSDoc now says: "All GLBs used here face -Z at rotation.y=0".

Also: the JSDoc said "2.5 tiles" for the inset distance but the constant `NPC_INSET_TILES = 4.0`. Fixed.

## Context
Caught during full audit of movement/facing/joystick systems. The bad comment would mislead future contributors into "fixing" the +PI by removing it (producing 180° wrong facing). Correcting it reduces future regression risk.

The SpongeBob character GLBs (spongebob.glb, patrick.glb, etc.) are assumed to also face -Z at rest, consistent with the correct rendering observed in production. If any future character GLB faces +Z, the `computeNpcPlacement` formula would need per-model handling.
