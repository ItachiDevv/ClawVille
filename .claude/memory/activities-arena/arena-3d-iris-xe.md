---
name: arena-3d-iris-xe
description: "Iris-Xe GPU bans bind all arena 3D (lib/three/activities/reef-race/**, app/{activity,arena}/**); chase camera follows the body (never pin Y=0 vs WATER_Y=-200); new arena render goes through the 3da manager, not solo."
category: constraint
confidence: high
date: 2026-06-22
---

# Iris-Xe bans bind all arena 3D — render via the 3da manager

**Status: ENFORCED.** Composes `[[iris-xe-arena-3d]]`, `[[live-smoke-realtime-engines]]`.

All `apps/web/src/lib/three/activities/reef-race/**` and `apps/web/src/app/{activity,arena}/**` obey the project GPU bans:
- NO drei `<Text>` / `<Billboard>` in a game/world scene (hard Iris-Xe crash — every reef-race file header already notes it).
- NO `InstancedMesh + ShaderMaterial` (silent WebGPU crash).
- NO per-frame `new Vector3()` in `useFrame` (GC thrash — reef-race uses module-scope scratch, e.g. ReefRaceScene.tsx:97,383).
- Every cloned `SkinnedMesh` -> `frustumCulled = false`.

## The v2 water/camera scar
Reef-race v2 water sits at `WATER_Y = -200` (canyon, water-surf.tsx:49). The chase camera + racing plane MUST follow the body, NEVER pin `Y=0` (that produced 'water gone / green track', and a revert once missed the camera). This is a layout-physics bug class that only shows in-browser — see `[[live-smoke-hidden-state-invariants]]`.

## Manager rule
Non-trivial arena 3D (shaders, materials, cameras, GLB, the spline track, atmosphere) goes through the `3da` MANAGER (it owns `.claude/memory/threejs/` + the Iris-Xe burns + the world-dimensions SSOT), not a solo edit. Local testing is `bun run build && bun run start` (Iris-Xe-safe); NEVER `bun run dev`. Arena 3D changes update `3dStructure.md` same-diff.
