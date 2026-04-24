---
title: FBXLoader parallel multi-file clip extraction pattern
category: pattern
tags: [fbx, FBXLoader, AnimationMixer, AnimationClip, Mixamo, SkeletonUtils, React19]
date: 2026-04-23
confidence: medium
threejs_version: r170+
---

## Summary

Loading a Mixamo-rigged FBX character with N separate animation FBX files (one clip per file) — module-scope parallel `Promise.all`, clip renaming, `SkeletonUtils.clone`, `AnimationMixer` with `LoopOnce` pose holding. React 19 `use()` for suspension.

## Details

### Load pattern

```typescript
// Module scope — kick ALL loads on first import, no rAF deferral needed (single component)
const _assetsPromise: Promise<GuideAssets> = (async () => {
  const loader = new FBXLoader();
  const [character, ...animFbxs] = await Promise.all([
    loader.loadAsync('/models/guide-rigged.fbx'),
    ...ANIM_PATHS.map((p) => loader.loadAsync(p)),
  ]);
  animFbxs.forEach((fbx, i) => {
    if (fbx.animations[0]) {
      fbx.animations[0].name = CLIP_NAMES[i]; // Mixamo default name is "mixamo.com"
      clips.push(fbx.animations[0]);
    }
  });
  character.animations = clips;   // attach so SkeletonUtils.clone carries them
  return { template: character, clips };
})();
```

### React 19 suspension

```typescript
// Inside memo component — suspends until promise resolves
const { template, clips } = use(_assetsPromise);
```

Works cleanly with Next.js 15 App Router + `'use client'` + `<Suspense fallback={null}>`.

### Skeleton clone + AnimationMixer

```typescript
const cloned = useMemo(() => {
  const c = skeletonClone(template) as THREE.Group;
  c.traverse(obj => { obj.frustumCulled = false; }); // MANDATORY for SkinnedMesh
  return c;
}, [template]);

const mixer = useMemo(() => new THREE.AnimationMixer(cloned), [cloned]);
```

After `SkeletonUtils.clone`, the cloned group does NOT carry its own `AnimationClip` copies — clips are shared data. FBXLoader writes bone-name-based tracks (not UUID), so `mixer.clipAction(clip, cloned)` resolves correctly from the cloned skeleton by bone name. This is the standard Three.js Mixamo pattern.

### Single-frame pose hold (1-frame FBX)

```typescript
const action = mixer.clipAction(idleClip, cloned);
action.setLoop(THREE.LoopOnce, 1);
action.clampWhenFinished = true;  // stay at last frame
action.timeScale = 0;             // don't advance — hold at frame 0
action.weight = 1.0;
action.play();
```

### Wave crossfade (click → play once → return)

```typescript
// On click:
wave.reset(); wave.enabled = true; wave.weight = 0; wave.play();
idle.crossFadeTo(wave, FADE, false);

// On 'finished':
idle.enabled = true; idle.weight = 1;
wave.crossFadeTo(idle, FADE, false);
```

### Mixer update in useFrame

```typescript
useFrame(({ clock }, delta) => {
  mixer.update(delta);
  // Procedural breathing additive over mixer (mixer only writes rotation/position from Mixamo):
  if (spineBone) spineBone.scale.y = 1 + Math.sin(clock.elapsedTime * 1.8) * 0.008;
});
```

### Cleanup

```typescript
mixer.stopAllAction();
mixer.uncacheRoot(cloned);
// Dispose cloned geometry + materials — NOT the shared AnimationClip objects
```

## Context

First FBX usage in ClawVille. Used in `town-guide.tsx` for the Mixamo-rigged anime guide at world center south (z=+240). 11 animation FBX files (one Mixamo clip each) loaded in parallel into a single module-scope Promise.

## Caveats

- **FBX embedded textures**: FBXLoader extracts embedded textures into `THREE.Texture` objects. Works in most browsers. If character renders flat/black, textures failed to embed — add a MeshStandardMaterial fallback on SkinnedMesh nodes.
- **FBX file size on Iris Xe**: total ~5-6MB of FBX to parse. FBX is text-parsed (the binary variant) — more CPU-intensive than glTF. On Iris Xe this runs fine as a single character load; the parse happens off the main thread via the Loader's internal callback chain. First-visit parse takes ~1-2s; Suspense hides the stall.
- **Clip bone-name resolution**: `mixer.clipAction(clip, cloned)` needs bone names in tracks to match the cloned skeleton's bone names. Mixamo exports with `mixamorig:*` names which match between character FBX and animation FBXs — resolution works automatically. If you mix non-Mixamo clips, you'll need a bone-name rewrite step.
