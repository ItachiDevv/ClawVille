---
title: Dynamic import('three/webgpu') inside renderer factory — dual-instance crash
category: gotcha
tags: [webgpu, ios, safari, fallback, dual-instance, nodejs, nodemat, webgl, webpack, chunk-splitting]
date: 2026-05-21
confidence: high
threejs_version: r182
---

## Summary

Any `await import('three/webgpu')` INSIDE `createWebGPURenderer` or the glFactory catch block creates a second webpack chunk with a separate Three.js module instance. `IndexNode`, `NodeShaderStage`, etc. from the second instance are different objects from those used by materials registered via `extend(THREE)` (from the static top-level import). This causes `IndexNode.VERTEX` to appear `undefined` during shader compilation on FIRST LOAD for browsers without `navigator.gpu`.

## Crash signature

```
SES_UNCAUGHT_EXCEPTION: TypeError: can't access property "VERTEX", yb is undefined
```

`yb` is the minified name for `IndexNode` in the second module instance. MetaMask's LavaMoat SES wrapper catches and re-throws uncaught errors with this prefix.

## Who it affects

- **Chrome / Brave / Edge corporate** (any Chromium without WebGPU, older versions)
- **First-time visitors only** (cold cache — chunks load fresh, module instances are separate)
- Does NOT affect repeat visitors (second chunk cached and fused with first)
- Introduced by `cc26908` which added `FORCE_WEBGL=true` for `WEBGPU_ABSENT` browsers, causing them to hit `createWebGPURenderer` (which had `await import('three/webgpu')`) for the first time

## Root cause

```ts
// World3DCanvas.tsx line 6 — static import (module instance A, chunk 1)
import * as THREE from 'three/webgpu';
extend(THREE as any); // registers NodeMaterials from instance A

// Inside createWebGPURenderer() — dynamic import (module instance B, chunk 2)
const { WebGPURenderer } = await import('three/webgpu'); // ← DIFFERENT INSTANCE
const renderer = new WebGPURenderer({ ... });
// When renderer compiles a NodeMaterial shader from instance A using IndexNode from B:
// B's IndexNode.VERTEX !== A's IndexNode.VERTEX → undefined crash
```

Webpack chunk splitting: static `import` at top → bundled into the page chunk; `await import(...)` inside an async function → split into a separate lazy chunk. Two chunks = two module evaluation contexts = two instances.

## Also affected: plain 'three' catch block (original pre-fix bug)

```ts
// ALSO WRONG — different library altogether
const { WebGLRenderer } = await import('three');
return new WebGLRenderer({ ... }); // no knowledge of NodeMaterial from three/webgpu
```

## The fix (committed 7350cfb, 2026-05-21)

Use `THREE.WebGPURenderer` from the static import namespace everywhere:

```ts
// CORRECT — same module instance as extend(THREE) above
const renderer = new THREE.WebGPURenderer({
  canvas,
  antialias: false,
  forceWebGL: FORCE_WEBGL,
});
await renderer.init();
```

**Never `await import('three/webgpu')` inside any async function in a file that also does `import * as THREE from 'three/webgpu'` at the top.** The static import is already bundled; the dynamic import creates a second chunk. Use the static namespace.

## Related

- `two-three-instances-nodemat-webgl-crash.md` — the general dual-instance pattern
- `ios-safari-webgpu-navigator-gpu-undefined.md` — related iOS fix
