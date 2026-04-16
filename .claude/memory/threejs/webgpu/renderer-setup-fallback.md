---
title: WebGPU renderer setup with WebGL fallback
category: webgpu
tags: [webgpu, webgl, renderer, setup, fallback, detection]
date: 2026-04-08
confidence: high
threejs_version: r170+
---

## Summary
Standard pattern for initializing WebGPURenderer with automatic WebGLRenderer fallback.

## Details

```typescript
import WebGPURenderer from 'three/addons/renderers/webgpu/WebGPURenderer.js';
import WebGLRenderer from 'three';

async function createRenderer(canvas: HTMLCanvasElement) {
  // Check WebGPU support
  if (navigator.gpu) {
    const renderer = new WebGPURenderer({ canvas, antialias: true });
    try {
      await renderer.init();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      return renderer;
    } catch (e) {
      console.warn('WebGPU init failed, falling back to WebGL', e);
      renderer.dispose();
    }
  }
  
  // Fallback
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  return renderer;
}
```

### Key points:
- Always cap `devicePixelRatio` at 2 — higher values tank performance on HiDPI screens
- `WebGPURenderer.init()` is async — must await before rendering
- Dispose the failed WebGPU renderer before creating WebGL fallback
- WebGPU detection: `navigator.gpu` exists but `init()` can still fail (e.g., driver issues)

## Context
Essential boilerplate for any Three.js project targeting modern browsers while supporting older ones.
