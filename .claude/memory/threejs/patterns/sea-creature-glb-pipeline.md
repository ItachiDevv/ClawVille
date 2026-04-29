---
title: Sea-creature rigged GLB animation pipeline
category: pattern
tags: [glb, animation, AnimationMixer, SkeletonUtils, sea-creature, non-humanoid, fallback]
date: 2026-04-26
confidence: medium
threejs_version: r170+
---

## Summary

Async factory `createSeaCreatureAnimator()` drives non-humanoid rigged GLBs (lobster, crayfish, sea_horse) with baked per-state AnimationClips — no Mixamo retargeting needed.

## Details

Three files:
- `sea-creature-types.ts` — `SeaCreatureSpecies`, `SeaCreatureAnimState` const-as arrays, `SeaCreatureManifest` type.
- `sea-creature-manifest.ts` — hand-maintained manifest; all species default `hasRig: false` so the fallback (static mesh) is taken until real GLBs are dropped.
- `sea-creature-animator.ts` — async factory returning `SeaCreatureAnimatorHandle | null`.

Asset layout when enabled:
```
/models/sea-creatures/<species>/base.glb               — rigged mesh, no clips
/models/sea-creatures/<species>/animations/<state>.glb — one clip per state file
```

Key design decisions:
1. **Manifest-gated**: `hasRig: false` → factory returns null immediately, no network. Caller falls back to existing static-mesh path. Zero regression risk.
2. **Module-scope GLB cache** keyed by URL string (same pattern as `RAW_CLIP_CACHE` in `vrm-character-animator.ts`) — load-once per URL, pending/resolved/rejected states.
3. **Single GLTFLoader** at module scope with `MeshoptDecoder` (from `meshoptimizer` package, NOT `three-stdlib` — see gotcha `two-three-instances-nodemat-webgl-crash`).
4. **SkeletonUtils.clone()** on base scene + `frustumCulled=false` traverse immediately after — prevents pose corruption on multi-player and bind-pose culling on Iris Xe.
5. **Loop vs one-shot**: idle/swim/boost → `LoopRepeat`; hit/victory/wipeout → `LoopOnce + clampWhenFinished`. `hit` auto-reverts to last looping state via `mixer.addEventListener('finished', ...)`.
6. **Crossfade 200ms default**: `currentAction.crossFadeTo(nextAction, fadeSec, false)` + `nextAction.reset().fadeIn(fadeSec).play()` — the `.play()` is mandatory (crossFadeTo schedules weights only; see gotcha `vrm-crossfade-must-play`).
7. **State fallback priority**: requested → swim → idle → first available → bind pose (no-op mixer).
8. **No per-frame allocations**: all AnimationAction refs live in a `Map<SeaCreatureAnimState, THREE.AnimationAction>` built at create time; `tick()` calls only `mixer.update(dt)`.

## Context

Wiring-only session (2026-04-26): no actual rigged GLBs yet. The fallback path keeps existing static-mesh rendering working. Caller (ReefRacePlayer, BumperShellsPlayer) handles null by continuing with their existing static mesh branch — wired separately.

Divergences from brief:
- `MeshoptDecoder` imported from `'meshoptimizer'` (not `'three/examples/jsm/libs/meshopt_decoder.module.js'`) — the entire codebase uses `meshoptimizer` for this; the brief's import path was advisory.
- `mixer.uncacheRoot(scene)` used in dispose (matches pattern in `vrm-character-animator.ts`).
