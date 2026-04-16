---
title: drei Text/Billboard crashes Intel Iris Xe GPU
category: gotcha
tags: [drei, text, billboard, intel, iris-xe, crash, gpu]
date: 2026-04-08
confidence: high
threejs_version: r170+
---

## Summary
Using `@react-three/drei` Text or Billboard components causes hard crashes on Intel Iris Xe integrated GPUs.

## Details
The `Text` component from drei (which uses troika-three-text internally) and `Billboard` components trigger GPU-level crashes on Intel Iris Xe. The browser tab may freeze, go black, or show a "WebGL/WebGPU context lost" error.

**Never use in game scenes:**
```typescript
// CRASHES on Intel Iris Xe
import { Text, Billboard } from '@react-three/drei';
<Text>Hello</Text>
<Billboard>...</Billboard>
```

**Safe alternatives:**
- Canvas-based texture for text (render text to a 2D canvas, use as texture)
- Pre-rendered text sprites
- HTML overlays with CSS3DRenderer for UI text
- SDF font rendering with custom implementation

## Context
Discovered in ClawVille 3D world development. Target audience includes users with integrated GPUs — this is a hard requirement to avoid these components.
