---
title: Use MeshBasicMaterial for animated vegetation on WebGPU
category: gotcha
tags: [webgpu, vegetation, seaweed, meshbasicmaterial, animation]
date: 2026-04-08
confidence: high
threejs_version: r170+
---

## Summary
Custom vertex-animated vegetation (seaweed, grass, etc.) must use MeshBasicMaterial on WebGPU — ShaderMaterial vertex animation crashes silently.

## Details
When creating procedurally animated vegetation (e.g., swaying seaweed using sin-wave vertex displacement), the standard approach of using ShaderMaterial with a custom vertexShader does NOT work on WebGPU.

**Works on WebGPU:**
```typescript
const material = new MeshBasicMaterial({ 
  color: 0x2d5a1e, 
  side: DoubleSide 
});
// Animate via JS (update geometry positions each frame) or use morph targets
```

**Does NOT work on WebGPU (silent crash):**
```typescript
const material = new ShaderMaterial({
  vertexShader: `// custom sway animation`,
  fragmentShader: `// ...`
});
```

**Best approach for WebGPU vegetation:**
- Use TSL (Three.js Shading Language) for vertex displacement
- Or animate via morph targets
- Or update BufferGeometry positions in JS (less performant but reliable)

## Context
Multiple iterations in ClawVille trying to get seaweed rendering. Final solution required rewriting to MeshBasicMaterial.
