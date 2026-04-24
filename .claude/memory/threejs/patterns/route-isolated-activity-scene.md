---
title: Route-isolated activity scene pattern (Bumper Shells / Reef Race)
category: pattern
tags: [activity, scene, isolation, webgpu, orthographic, particle-pool, canvas-key]
date: 2026-04-23
confidence: high
threejs_version: r170+
---

## Summary

Pattern for route-isolated R3F scenes in Next.js for minigame activities, sharing no GPU state with the open world.

## Details

### Route isolation
- Activity scenes live at `/activity/:activityId/:roomId` — separate Next.js route unmounts the open world.
- `key={roomId}` on `<Canvas>` forces full WebGPU context recreation between rooms (guards StrictMode double-mount).
- No imports between `apps/web/src/lib/three/` (world) and `apps/web/src/lib/three/activities/`.

### Static orthographic camera (Bumper Shells)
- `OrthographicCamera` configured in a `useEffect` inside a child component (not via Canvas `camera` prop).
- `camera.matrixAutoUpdate = false` after `lookAt()` + `updateMatrix()` — zero per-frame camera matrix work.
- Config: `left=-700, right=700, near=1, far=1500`, position `(0, 1100, 300)`, lookAt `(0,0,0)`.
- This sidesteps Iris Xe's multi-frusta shadow ceiling for 8 players (one fixed frustum = one shadow pass).

### Module-scope particle burst pool
- Pool size at module scope (not React state) — `triggerBurst()` is imperative, callable outside React.
- Pre-compute random spread directions at module load — no per-burst RNG.
- `Float32BufferAttribute` mutated in-place; `needsUpdate=true` per active slot.
- Pool of 4 slots × 16 Points = 64 particles max (Iris Xe fragment budget constraint).
- Steal oldest slot when all active (vs. dropping the burst).

### Static mesh freeze pattern
Every static mesh: `mesh.matrixAutoUpdate = false; mesh.updateMatrix()` in `useEffect(() => {}, [])`.
For InstancedMesh: `instanceMatrix.needsUpdate = true` after all `setMatrixAt()` calls, then freeze.

### Html pickup labels
- NO `distanceFactor` — causes per-frame camera-distance recompute (perf-sweep 2026-04-21 Pattern E).
- Label visibility toggled via `labelRef.current.style.display` imperatively in useFrame.
- NOT via React state or `group.visible` (drei Html ignores parent visible).

### InstancedMesh safety note
- `InstancedMesh + MeshStandardMaterial` = SAFE on WebGPU.
- `InstancedMesh + ShaderMaterial` = SILENT BLANK CANVAS on WebGPU. Never use ShaderMaterial with InstancedMesh.

### PreCompilePipelines placement
- Must be the LAST child inside SceneContents (after all meshes are in the scene).
- Same pattern as World3DCanvas.tsx: `useEffect(() => { rAF(() => { gl.compileAsync(scene, camera) }) })`.

### Store coordination contract
- Scene reads `Map<petId, entity>` for O(1) useFrame lookup — NOT array.find().
- High-frequency WS state lives in a separate `@/stores/activity` (not polluting `game.ts`).
- Scene is READER only; WS hook (general-purpose) is the WRITER.

## Context

Bumper Shells (chunk #4, 2026-04-23). Same pattern applies to Reef Race (chunk #6).
See `apps/web/src/lib/three/activities/bumper-shells/` for full implementation.
