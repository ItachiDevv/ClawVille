---
title: racing-karts.tsx had a LOCAL WATER_Y=40 that did not cascade from river-scene.tsx
category: gotcha
tags: [reef-race, WATER_Y, cascade, constant-isolation, karts]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

When river-scene.tsx's `WATER_Y` was cascaded from +40 to -40 (iter-5 canyon depth), `racing-karts.tsx` initially was NOT updated because it had its own local `const WATER_Y = 40` — it does NOT import the constant from river-scene.tsx. The orchestrator completed the cascade in the same session; **the mismatch is resolved** (verified by auditor 2026-04-29).

## Resolution

`racing-karts.tsx` line 72 now reads `const WATER_Y = -40;`. Karts ride at y≈-35±4wu. Auditor confirmed via grep (`grep -n "const WATER_Y" racing-karts.tsx` → `72: const WATER_Y = -40;`).

## Lesson

Whenever a shared "water surface Y" constant is cascaded, grep ALL files in the directory for their own hardcoded copies of the same value:

```bash
grep -rn "WATER_Y" apps/web/src/lib/three/activities/reef-race/ | grep "[0-9]"
```

Any file that defines `WATER_Y` locally will not pick up the cascade. Check `water-material.tsx` too — it still has `WATER_Y = 40` (line 35) but is NOT imported by river-scene.tsx (dead code for this PR path).

## Context

Surfaced during Reef Race iter-5 wire-up (2026-04-29). Resolved same session. Auditor pass confirmed clean.
