---
title: Aura shader — GLSL fresnel sphere for avatar glow effects
category: pattern
tags: [shader, aura, cosmetic, fresnel, ShaderMaterial, WebGL]
date: 2026-04-28
confidence: high
threejs_version: r170+
---

## Summary
Fresnel-based transparent sphere renders an aura glow around an avatar root. Uses ShaderMaterial (GLSL) — NOT TSL/NodeMaterial — because this component lives in the main world canvas which uses WebGLRenderer.

## Details

### Why GLSL, not TSL
The main ClawVille world scene uses R3F's default Canvas → WebGLRenderer (plain `import * as THREE from 'three'`). NodeMaterial / MeshBasicNodeMaterial in that context causes a per-frame `.replace() on undefined` crash (gotcha: `two-three-instances-nodemat-webgl-crash.md`). For cosmetics that need to render in the world scene, use ShaderMaterial + raw GLSL.

TSL is fine in the dedicated activity canvases (ReefRace, BumperShells) which use WebGPURenderer.

### Vertex shader
```glsl
varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vViewDir = normalize(cameraPosition - worldPos.xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```

### Fragment shader
```glsl
uniform vec3  uColor;
uniform float uTime;
uniform float uSpeed;
uniform float uOpacity;

varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  float fresnel = 1.0 - abs(dot(normalize(vNormal), normalize(vViewDir)));
  fresnel = pow(fresnel, 2.0);
  float pulse = 0.7 + 0.3 * sin(uTime * uSpeed);
  float alpha = fresnel * pulse * uOpacity;
  gl_FragColor = vec4(uColor, alpha);
}
```

### Material setup
```ts
const mat = new THREE.ShaderMaterial({
  uniforms: {
    uColor:   { value: color.clone() },
    uTime:    { value: 0 },
    uSpeed:   { value: 1.5 },
    uOpacity: { value: 0.7 },
  },
  vertexShader: AURA_VERT,
  fragmentShader: AURA_FRAG,
  transparent:  true,
  depthWrite:   false,
  side:         THREE.FrontSide,
  blending:     THREE.AdditiveBlending,
});
```

### Geometry
Module-scope singleton `SphereGeometry(1, 20, 14)` — 20×14 segments. Enough smoothness at typical zoom; low enough for Iris Xe. Scale the mesh by `radius` (default 35wu for a ~45wu tall avatar). NEVER dispose this geometry — it's shared.

### compileAsync
Call after the mesh is added to the parent, using feature-detect:
```ts
if (typeof (gl as any).compileAsync === 'function') {
  (gl as any).compileAsync(mesh, camera, scene).catch(console.warn);
}
```

### Frame update
Store uniforms on `mesh.userData.cosmeticUniforms`. A sibling `AuraFrameUpdater` component traverses `parentObject` once per frame and increments `uTime`:
```ts
parentObject.traverse((child) => {
  const u = child.userData?.cosmeticUniforms;
  if (u?.uTime) u.uTime.value += delta;
});
```

### assetMeta fields
```jsonc
{
  "color": "#44aaff",   // hex string or number
  "speed": 1.5,         // pulse speed (rad/s)
  "radius": 35          // sphere scale in world units
}
```

## Context
Introduced in Phase 3.3 (cosmetic render pipeline). `cosmetic-loader.tsx`. Aura variants use `rigType: 'universal'` and `assetUrl: 'shader:aura-<name>'` as a registry key (the loader ignores assetUrl for auras and uses the shader template directly, reading only assetMeta).
