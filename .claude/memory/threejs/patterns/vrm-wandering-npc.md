---
title: VRM wandering NPC in arena-npcs.tsx
category: pattern
tags: [vrm, npc, wandering, arena-npcs, VRMCharacterAnimator, facing, scale, frustum-culling, cull-distance]
date: 2026-04-21
confidence: high
threejs_version: r170+
---

## Summary

VRMNpcMesh component in arena-npcs.tsx renders Milady VRM avatars as wandering
demo NPCs, parallel to the existing GLBNpcMesh component.

## Details

### Routing

ArenaNpcs() checks `MODEL_REGISTRY[npc.species]?.avatar_type`. If `'vrm'`,
renders `<VRMNpcMesh>` inside its own `<Suspense fallback={null}>`. GLB path
unchanged.

### Scale

`VRM_NPC_SCALE = 28` — different from picker registry `scale: 13`. Calibration:
VRM native ~1.6m → 28 × 1.6 = 44.8wu matches `TARGET_NPC_HEIGHT = 45`.

### Facing direction

VRM faces -Z (opposite of lobster +Z). Use `VRM_DIR_ROTATION`:
```ts
const VRM_DIR_ROTATION: Record<string, number> = {
  down: Math.PI, up: 0, right: Math.PI / 2, left: -Math.PI / 2, idle: Math.PI,
};
```
For continuous facing (if needed): `atan2(vx, -vy)` not `atan2(vx, vy)`.

### No pivot offset

VRM spec mandates feet at Y=0. Set `group.position.y = currentTerrainY.current`
directly — no pivotOffsetY calculation.

### No color tint

MToon pipeline breaks under MeshStandardMaterial.color.lerp. Skip applyColorTint
entirely. Color field in NpcSpriteState is populated but ignored at render time.

### Single-instance-per-path cache constraint

vrm-loader.ts caches one VRM instance per path (module-level VRM_CACHE map).
Two NPCs sharing a path share vrm.scene and clobber each other's AnimationMixer
state every frame. Each concurrent VRM NPC MUST use a distinct path.

Demo NPC assignment: milady_official_7 (Miu) + milady_official_8 (Kyoko).
official_7/8 chosen to avoid collision with player-pet defaults (official_1 is
category default, official_5 is popular).

### Animator lifecycle

Create `new VRMCharacterAnimator(vrm)` in useEffect (not useMemo) so it's tied
to the component lifecycle. Call `animator.init()` async. Return cleanup that
calls `animator.dispose()`. The animator drives idle<->walk crossfade + spring
bones + vrm.update(delta) each frame.

### Preload

At module scope (not inside a component). ALL VRM paths used by wandering NPCs must
be listed here — missing preloads cause cold-start Suspense delay + animator.init()
race that leaves NPCs in T-pose:
```ts
preloadVRM('/avatars/milady-official-2.vrm');
preloadVRM('/avatars/milady-official-3.vrm');
preloadVRM('/avatars/milady-official-4.vrm');
preloadVRM('/avatars/milady-official-7.vrm');
preloadVRM('/avatars/milady-official-8.vrm');
preloadMixamoClips();
```

### Frustum culling — MUST disable on all VRM nodes

VRM SkinnedMesh bounding spheres are computed from bind pose (T-pose). Animated
pose geometry extends outside the bind-pose sphere. Three.js culls the mesh when
the camera is close or at steep angles — NPC disappears at close range.

Fix applied in `vrm-loader.ts` after `VRMUtils.rotateVRM0(vrm)`:
```ts
vrm.scene.traverse((obj) => { obj.frustumCulled = false; });
```
This applies to every VRM loaded — player pet and all NPCs.

Same issue affects GLB SkinnedMesh clones. Fix in `GLBNpcMesh` useMemo:
```ts
const c = scene.clone(true);
c.traverse((obj) => { obj.frustumCulled = false; });
```

### NPC_CULL_DIST_SQ must cover all spawn positions

`NPC_CULL_DIST_SQ = 2000 * 2000` (not 1200). NPCs that spawn beyond 1200wu from
world origin (Maple at world ~(940,940)=dist 1329wu; Miu at world ~(-1160,440)=dist
1242wu) had `group.visible=false` set on their very first frame — VRM animators never
ran a single tick, causing permanent T-pose. 2000wu covers all possible spawn positions
within the 5120×5120 world (max spawn-to-origin dist ~1400wu in ClawVille).

## Context

Added 2026-04-21 for ClawVille wandering NPC feature. Updated 2026-04-21 (bug fix
session): frustum cull fix + missing preloads for official_2/3/4 + cull distance raise.
Files touched:
- `apps/web/src/stores/npc.ts` — 5 VRM NPC DEMO_NPCS entries
- `apps/web/src/lib/three/arena-npcs.tsx` — VRMNpcMesh + routing fork + cull dist + preloads + frustumCulled GLB fix
- `apps/web/src/lib/three/vrm-loader.ts` — frustumCulled=false after load
