---
title: iOS Safari — navigator.gpu undefined causes black scene with WebGPURenderer
category: gotcha
tags: [ios, safari, mobile, webgpu, webgl2, fallback, navigator.gpu, black-screen]
date: 2026-05-20
confidence: high
threejs_version: r182
---

## Summary

On iOS Safari, `navigator.gpu` is `undefined`. Three.js r182's `WebGPUBackend.init()` checks `typeof navigator !== 'undefined'` (for SSR) but NOT `typeof navigator.gpu !== 'undefined'`, so it calls `navigator.gpu.requestAdapter(...)` and throws a TypeError. While the `getFallback()` mechanism in `WebGPURenderer` catches this and falls back to `WebGLBackend`, the catch path can leave the canvas or iOS WebKit in a broken state, resulting in a **pure black 3D viewport** — HUD still renders, 3D canvas is black.

## Details

### Root cause (three/webgpu r182, WebGPUBackend.init line ~78104)

```js
// three/webgpu WebGPUBackend.init():
const adapter = (typeof navigator !== 'undefined')
  ? await navigator.gpu.requestAdapter(adapterOptions)  // ← THROWS on iOS
  : null;
```

The SSR guard (`typeof navigator !== 'undefined'`) is insufficient — it only handles Node.js. On iOS Safari where `navigator` exists but `navigator.gpu` is `undefined`, this is a TypeError.

Three.js catches it via `getFallback()` and creates a `WebGLBackend`, but iOS WebKit may have entered a bad canvas state by the time the catch fires, resulting in no rendering.

### Fix

Pass `forceWebGL: true` to `WebGPURenderer` when WebGPU is absent. This skips the adapter request and goes directly to `WebGLBackend` with full TSL node-material support (GLSLNodeBuilder compiles TSL to GLSL):

```ts
const IOS_SAFARI =
  typeof navigator !== 'undefined' &&
  /iP(hone|ad|od)/i.test(navigator.userAgent) &&
  /WebKit/i.test(navigator.userAgent) &&
  !/CriOS|FxiOS|OPiOS|mercury/i.test(navigator.userAgent);

const WEBGPU_ABSENT =
  typeof navigator !== 'undefined' && !('gpu' in navigator);

const FORCE_WEBGL = IOS_SAFARI || WEBGPU_ABSENT;

const renderer = new WebGPURenderer({
  canvas,
  antialias: false,
  forceWebGL: FORCE_WEBGL,
});
await renderer.init();
```

### Key facts

- `forceWebGL: true` is a documented `WebGPURenderer` option (r182+). Sets `BackendClass = WebGLBackend` directly — no adapter negotiation.
- TSL node materials (`MeshBasicNodeMaterial`, `PointsNodeMaterial`, `MeshStandardNodeMaterial`) fully work on the WebGL2 backend via `GLSLNodeBuilder`. Same visual output as the WebGPU path.
- iOS Safari 17.4+ with WebGPU feature flag enabled: `navigator.gpu` is defined but `requestAdapter()` may return `null` (caught differently). The `forceWebGL` fix also covers this case — we skip WebGPU entirely.
- `WEBGPU_ABSENT` catches non-iOS browsers (e.g. old Firefox, Samsung Browser) that also lack `navigator.gpu`.

## Context

Reported 2026-05-20. User loaded `clawville.world/game` on iPhone (iOS Safari, LTE). HUD rendered normally, 3D viewport was pure black. Desktop Chrome unaffected. Fix: `apps/web/src/components/three/World3DCanvas.tsx` `createWebGPURenderer()`.
