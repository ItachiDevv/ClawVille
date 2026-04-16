---
title: renderer.compileAsync(scene, camera) eliminates post-mount pipeline hitch
category: performance
tags: [WebGPU, compileAsync, pipeline-compile, long-task, jank]
date: 2026-04-11
confidence: high
threejs_version: r170+
---

## Summary
`WebGPURenderer.compileAsync(scene, camera)` pre-compiles all render pipelines asynchronously, moving the post-mount pipeline-compile main-thread block into the loading-spinner phase so users never see the frame stutter.

## Details

**Problem:** Three.js WebGPURenderer compiles GPU render pipelines lazily on first draw. If the scene has many unique materials, the first useFrame tick triggers a 200-400ms main-thread block (visible as a "long task" in CDP). In ClawVille this measured as a 274ms block at t=2641ms.

**Solution:** Call `compileAsync(scene, camera)` once after the scene is populated. It walks all scene objects and pre-compiles pipelines in parallel before the first draw call.

**Critical timing gotcha:** `onCreated` fires BEFORE R3F's children are added to `scene.children`. Calling `compileAsync` there compiles nothing. You must call it after the first R3F commit.

**Correct pattern — a child component inside Canvas:**

```tsx
function PreCompilePipelines() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (typeof (gl as any).compileAsync === 'function') {
        (gl as any).compileAsync(scene, camera).catch((err: unknown) => {
          console.warn('[World3D] compileAsync failed:', err);
        });
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
```

Render `<PreCompilePipelines />` as a sibling of all scene content inside `SceneContents`. The `rAF` delay ensures all sibling meshes have been added to `scene.children` before compilation runs.

**No-op on WebGL:** `WebGLRenderer` doesn't have `compileAsync` (it has `compile()`). The `typeof` guard makes it safe for both renderer types.

**Why async matters:** `compile()` is synchronous and blocks the main thread. `compileAsync()` uses the GPU async pipeline API — it submits work to the GPU without blocking JS.

## Context
ClawVille cold-load pass (2026-04-11). Target: eliminate the 274ms long task at t=2641ms that appeared after scene mount.
