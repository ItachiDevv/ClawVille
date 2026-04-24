---
title: skeleton.update restore must use Map keyed on Skeleton, not index-aligned Array
category: gotcha
tags: [skeleton, vrm, dispose, scene-graph, traversal-order]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary
`dispose()` that re-walks the scene to restore `skeleton.update` using an index-aligned `Array<fn>` will silently restore the wrong function if any scene graph mutation happened between construction and disposal.

## Details
The Verse Engine skeleton-batching pattern (cache original `skeleton.update` per unique skeleton, replace with no-op, call once manually per frame) was originally implemented with an `Array<() => void>`. `dispose()` re-traversed `vrm.scene` a second time with a fresh `seenSkeletons` Set and incremented `fnIdx` to pair each skeleton with the cached function.

Problem: if any reparenting, node removal, or insertion happens between construction and disposal, the second traversal visits skeletons in a different order. `fnIdx` misaligns — skeleton A gets skeleton B's original function restored, or a skeleton is skipped entirely (leaving its `update` permanently as the no-op). The bug is silent: no error, the skeleton just never gets updated.

Fix: use `Map<THREE.Skeleton, () => void>` keyed by the skeleton object itself.
```ts
private _skeletonUpdateFns: Map<THREE.Skeleton, () => void> = new Map();

// constructor — replace Array push:
this._skeletonUpdateFns.set(sm.skeleton, sm.skeleton.update.bind(sm.skeleton));

// iterate in update/updateMixerOnly:
for (const fn of this._skeletonUpdateFns.values()) fn();

// dispose — no traversal needed:
this._skeletonUpdateFns.forEach((fn, skel) => { skel.update = fn; });
this._skeletonUpdateFns.clear();
```

Also: when `for...of` a Map, it iterates `[key, value]` pairs. Call `.values()` to iterate just the functions. Calling `for (const fn of map) fn()` passes a `[key, value]` tuple to `fn`, which is a runtime crash.

## Context
Surfaced during Sakura's code review of the VRM wanderer PR (commit 51a022e). Applicable to any pattern that caches per-object functions for later restoration.
