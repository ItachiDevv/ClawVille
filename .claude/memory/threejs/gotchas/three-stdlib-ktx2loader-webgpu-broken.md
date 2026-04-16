---
title: three-stdlib KTX2Loader.detectSupport() crashes on WebGPURenderer
category: gotcha
tags: [ktx2, three-stdlib, webgpu, detectSupport, WebGPURenderer, renderer.extensions]
date: 2026-04-11
confidence: high
threejs_version: r182
---

## Summary
`three-stdlib`'s `KTX2Loader.detectSupport(renderer)` calls `renderer.extensions.has(...)` which is undefined on `WebGPURenderer`, causing a crash. Use `three/addons/loaders/KTX2Loader.js` instead.

## Details

**three-stdlib 2.36.1 KTX2Loader** (WebGL only):
```js
detectSupport(renderer) {
  this.workerConfig = {
    bptcSupported: renderer.extensions.has("EXT_texture_compression_bptc"),  // CRASH on WebGPU
    // ...
  };
}
```

**Three.js r182 KTX2Loader** (WebGPU + WebGL):
```js
detectSupport(renderer) {
  if (renderer.isWebGPURenderer === true) {
    this.workerConfig = {
      bptcSupported: renderer.hasFeature('texture-compression-bc'),  // WebGPU path
      // ...
    };
  } else {
    this.workerConfig = {
      bptcSupported: renderer.extensions.has("EXT_texture_compression_bptc"),  // WebGL
      // ...
    };
  }
}
```

### Correct import

```ts
// DO NOT use:
import { KTX2Loader } from 'three-stdlib';

// USE instead (three/addons/* → three/examples/jsm/*, same path that merged-seaweed uses):
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
```

`drei`'s `GLTFLoader.setKTX2Loader(loader)` expects `three-stdlib`'s KTX2Loader type, so cast with `as any` when passing the three/addons instance.

### On Intel Iris Xe (WebGPU)

`renderer.hasFeature('texture-compression-bc')` → `true` → BC7 format selected.
Without this check, bptcSupported stays `false` → falls back to uncompressed RGBA8.

## Context
ClawVille KTX2 loader wiring (2026-04-11). Noticed when evaluating three-stdlib's KTX2Loader source — the version shipped in drei/three-stdlib is pinned to a version before WebGPURenderer support was added to detectSupport().
