---
title: InstancedMesh + ShaderMaterial crashes WebGPU silently
category: gotcha
tags: [webgpu, instancedmesh, shadermaterial, crash, silent-failure]
date: 2026-04-08
confidence: high
threejs_version: r170+
---

## Summary
Combining InstancedMesh with ShaderMaterial causes WebGPU renderer to crash silently — no console errors, just a blank canvas.

## Details
When using `WebGPURenderer`, creating an `InstancedMesh` with a custom `ShaderMaterial` will cause the renderer to fail silently. The scene renders nothing, and there are zero console errors or warnings.

**Does NOT work:**
```typescript
const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms });
const mesh = new InstancedMesh(geometry, material, count);
```

**Works instead:**
```typescript
// Option 1: Use MeshBasicMaterial or MeshStandardMaterial with instancing
const material = new MeshBasicMaterial({ color: 0x00ff00 });
const mesh = new InstancedMesh(geometry, material, count);

// Option 2: Use TSL NodeMaterial for custom effects
import { MeshStandardNodeMaterial } from 'three/webgpu';
```

## Context
Discovered while building vegetation systems in ClawVille. Wasted significant debugging time because there's no error output. This affects all WebGPU contexts, not just specific hardware.
