---
title: racing-karts.tsx had a LOCAL WATER_Y=40 that did not cascade from river-scene.tsx
category: gotcha
tags: [reef-race, WATER_Y, cascade, constant-isolation, karts]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

`racing-karts.tsx` has its own local `const WATER_Y` — it does NOT import from river-scene.tsx. Every time river-scene.tsx's `WATER_Y` is cascaded, `racing-karts.tsx` must be manually updated too.

- iter-5 (2026-04-29): river-scene +40→-40; racing-karts initially missed; fixed same session.
- iter-6 (2026-04-29): river-scene -40→-200; racing-karts updated to -200 in same diff.

## Current state

`racing-karts.tsx` `WATER_Y = -200`. Karts ride at y≈-195±4wu. Build verified green.

## Lesson

Whenever a shared "water surface Y" constant is cascaded, grep ALL files in the directory for their own hardcoded copies:

```bash
grep -rn "WATER_Y" apps/web/src/lib/three/activities/reef-race/ | grep "[0-9]"
```

Also check `water-material.tsx` — it has `WATER_Y = 40` (line 35) but is NOT imported by river-scene.tsx (dead code / unused alternative implementation). Do NOT update water-material.tsx during a river-scene.tsx cascade.

## Context

Pattern emerged during Reef Race iter-5 wire-up (2026-04-29). Reinforced iter-6 same session.
