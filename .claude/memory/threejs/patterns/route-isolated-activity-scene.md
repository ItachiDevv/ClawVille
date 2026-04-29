---
title: Route-isolated activity scene pattern (Bumper Shells / Reef Race)
category: pattern
tags: [activity, scene, isolation, webgpu, perspective, chase-camera, particle-pool, canvas-key, screen-flash]
date: 2026-04-24
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

### Perspective chase camera (Bumper Shells — rebuilt 2026-04-24)
- Canvas `camera` prop: `{ fov: 55, near: 1, far: 2500 }` — no imperative camera child needed.
- `ChaseCameraController` child component runs in `useFrame`:
  - Derive yaw from velocity: `if (speed > 20) yawRef.current = Math.atan2(vx, vz)` — dead-reckon when stopped.
  - Arm: `desired = { entity.x - sin*CHASE_CAM_DISTANCE, CHASE_CAM_HEIGHT, entity.z - cos*CHASE_CAM_DISTANCE }`.
  - Look-ahead target: `lookAt = { entity.x + sin*lookAhead, ARENA_HEIGHT/2 + 30, entity.z + cos*lookAhead }`.
  - Exp-decay lerp: `camera.position.lerp(desired, 1 - Math.exp(-CHASE_CAM_LERP_ALPHA * delta))`.
  - Camera shake added on top AFTER lerp: `camera.position.add(shakeOffset)`.
  - `camera.lookAt(lookAt)` every frame (cheap — no matrix inversion needed).
- Camera shake: `shakeRef = useRef(0)` (mutable, NOT React state — avoids re-renders). Written by
  `HitEventProcessor` in useFrame; read by `ChaseCameraController` in the same frame.
  Shake formula: `offset = sin(elapsed * SHAKE_FREQ * 2π) * amplitude * exp(-SHAKE_DECAY * elapsed)`.

### DOM screen-edge red flash (self-hit feedback)
- Lives OUTSIDE the `<Canvas>` — a position:absolute div layered on top via `position: relative` wrapper.
- Background: `radial-gradient(ellipse at center, transparent 40%, rgba(200,0,0,0.7) 100%)`.
- Flash in: `opacity` transition `0.05s ease-in`; fade out: `opacity` transition `${FLASH_DURATION_S * 0.8}s ease-out`.
- Triggered via React `useState(flashOpacity)` + `setTimeout` to reset — only fires on self-hit, not every frame.
- Why DOM and not Three.js plane: no alpha-sorting, no draw call, works identically on all GPUs.

### Module-scope particle burst pool
- Pool size at module scope (not React state) — `triggerBurst()` is imperative, callable outside React.
- Pre-compute deterministic spread directions at module load using modular arithmetic seeds:
  `angle = (i / COUNT) * Math.PI * 2 + i * 2.399` — no `Math.random()` at module scope.
- `Float32BufferAttribute` mutated in-place; `needsUpdate=true` per active slot.
- Pool of 6 slots × 12 Points = 72 particles max (Iris Xe fragment budget: ≤12 pts/burst).
- Y-biased upward scatter: `d[i*3+1] = 0.3 + upBias * 0.7` for aerial look.
- Steal oldest slot when all active (vs. dropping the burst).

### Gravity drop elimination (replaces flat fade)
- `dropRef = { active, elapsed, velocityY }` as a plain object ref, not React state.
- Each frame when active: `velocityY -= DROP_GRAVITY * dt; group.position.y += velocityY * dt`.
- Label hidden imperatively on elimination: `labelRef.current.style.display = 'none'`.
- `playActivitySound('knockout')` called from `HitEventProcessor` on first elimination frame.

### Static mesh freeze pattern
Every static mesh: `mesh.matrixAutoUpdate = false; mesh.updateMatrix()` in `useEffect(() => {}, [])`.
For InstancedMesh: `instanceMatrix.needsUpdate = true` after all `setMatrixAt()` calls, then freeze.

### Html player name labels
- NO `distanceFactor` — causes per-frame camera-distance recompute (perf-sweep 2026-04-21 Pattern E).
- Dot-product cull: `anchorInFrontOfCamera(_anchorPos, camera)` from `@/lib/three/utils/camera-cull`.
  Updates `labelRef.current.style.display` imperatively in useFrame — not React state.
- NEVER use drei `<Text>` or `<Billboard>` — hard Iris Xe GPU crash.
- HTML label markup uses inline styles; `LABEL_Y_OFFSET` in wu, divided by SHELL_SCALE for R3F local space.

### InstancedMesh safety note
- `InstancedMesh + MeshStandardMaterial` = SAFE on WebGPU.
- `InstancedMesh + ShaderMaterial` = SILENT BLANK CANVAS on WebGPU. Never use ShaderMaterial with InstancedMesh.

### Fog tuning for perspective camera
- Old ortho fog (near=1400, far=1500) was calibrated to the ~1140wu ortho camera distance — wrong for perspective.
- Perspective chase cam actual distances to arena geometry: ~50–600wu from player.
- Correct fog: `FOG_NEAR = ARENA_RADIUS * 1.8` (dissolve starts just beyond edge), `FOG_FAR = FOG_NEAR * 2`.
- For Bumper Shells (ARENA_RADIUS=500): FOG_NEAR=900, FOG_FAR=1800 — arena fully visible, void seam hidden.

### PreCompilePipelines placement
- Must be the LAST child inside SceneContents (after all meshes are in the scene).
- Same pattern as World3DCanvas.tsx: `useEffect(() => { rAF(() => { gl.compileAsync(scene, camera) }) })`.

### Store coordination contract
- Scene reads `Map<petId, entity>` for O(1) useFrame lookup — NOT array.find().
- High-frequency WS state lives in a separate `@/stores/activity` (not polluting `game.ts`).
- Scene is READER only; WS hook (general-purpose) is the WRITER.

## Context

Bumper Shells full rebuild (2026-04-24). Ortho camera was replaced entirely with perspective chase cam.
Same route isolation + static mesh freeze + Html label patterns apply to Reef Race (chunk #6).
See `apps/web/src/lib/three/activities/bumper-shells/` for full implementation.
