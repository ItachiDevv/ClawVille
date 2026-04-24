---
title: VRM draw-call reduction techniques
category: performance
tags: [vrm, mtoon, skeleton, bones, lookAt, expressionManager, draw-calls]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary
Four cheap VRM load-time or init-time reductions that collectively halve draw calls and cut skeleton CPU cost per VRM.

## Details

### 1. MToon outline pass off (B1)
MToon renders each mesh twice — fill + outline silhouette. Set `outlineWidthMode = 0` (None) on all MToonMaterial instances at load time:
```ts
vrm.scene.traverse((obj) => {
  const mat = (obj as THREE.Mesh).material as any;
  if (!mat) return;
  const mats: any[] = Array.isArray(mat) ? mat : [mat];
  for (const m of mats) {
    if (m?.isMToonMaterial) m.outlineWidthMode = 0;
  }
});
```
Halves draw calls per VRM mesh. Reversible: 1 = World, 2 = Screen.

### 2. removeUnnecessaryJoints (B3)
VRoid VRMs ship with finger/toe/face bones Mixamo clips never drive:
```ts
VRMUtils.removeUnnecessaryJoints(vrm.scene);
```
Reduces bone count 20-40%. Call after `removeUnnecessaryVertices`, before `rotateVRM0`. Safe — preserves all 54 mandatory humanoid bones.

### 3. Disable lookAt + expressionManager on wanderers (B4)
Wandering NPCs don't lipsync or eye-track. Disable in a useEffect:
```ts
useEffect(() => {
  if (!vrm) return;
  (vrm as any).lookAt = undefined;
  (vrm as any).expressionManager = undefined;
}, [vrm]);
```
three-vrm checks truthiness before calling each module — safe at runtime. Do NOT do this for the player pet.

### 4. Verse Engine skeleton.update batching (B2)
Three.js calls skeleton.update() once per SkinnedMesh before draw. A VRM shares one skeleton across 3-4 meshes = 3× redundant calls. Replace with a no-op and call once manually:
```ts
// In constructor:
const seenSkeletons = new Set<THREE.Skeleton>();
vrm.scene.traverse((obj) => {
  const sm = obj as THREE.SkinnedMesh;
  if (!sm.isSkinnedMesh || !sm.skeleton) return;
  if (seenSkeletons.has(sm.skeleton)) { sm.skeleton.update = () => {}; return; }
  seenSkeletons.add(sm.skeleton);
  const orig = sm.skeleton.update.bind(sm.skeleton);
  this._skeletonUpdateFns.push(orig);
  sm.skeleton.update = () => {};
});

// In update() and updateMixerOnly() after mixer.update():
for (const fn of this._skeletonUpdateFns) fn();
```
Restore originals in dispose() for safe re-construction.

## Context
ClawVille arena-npcs.tsx + vrm-loader.ts + vrm-character-animator.ts. Phase A+B initial perf fixes 2026-04-24. These apply to wandering Milady VRMs; the 10 building SpongeBob GLBs are NOT VRMs and must not get VRM-specific changes.
