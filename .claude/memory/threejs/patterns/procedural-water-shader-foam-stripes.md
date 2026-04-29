---
title: Procedural cartoon water shader — simplex noise foam stripes + UV scroll
category: pattern
tags: [water, shader, shadermaterial, simplex-noise, foam, uv-scroll, reef-race, iris-xe-safe]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary
Plain `THREE.ShaderMaterial` on a plain `Mesh` (NOT InstancedMesh) delivers animated cartoon water — multi-octave sin wave vertex displacement + simplex noise foam stripes + UV-scrolled flow — with zero Iris Xe issues.

## Details

### Key clarification on memory entry `reef-race-river-atmosphere.md`
That entry says "Hard pivot from Three.js Water shader (ShaderMaterial, unsafe on Iris Xe)". This referred specifically to the `THREE.Water` class (requires `waternormals.jpg`, complex reflections, alpha sorting). A **plain** `THREE.ShaderMaterial` on a **plain** `Mesh` is Iris Xe safe. The crash gotcha is `InstancedMesh + ShaderMaterial` (documented in `gotchas/webgpu-instancedmesh-shadermaterial.md`).

### Vertex shader — multi-octave sin wave
```glsl
const _waterVertexShader = `
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float x = position.x;
    float z = position.z;
    float wave = sin(x * 0.005 + uTime * 0.8) * 4.0
               + sin(z * 0.003 + uTime * 1.2) * 3.0
               + sin((x + z) * 0.002 - uTime * 0.6) * 2.0;
    vec3 displaced = position;
    displaced.y += wave;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;
```

### Fragment shader — inline 2D simplex noise + foam stripes + bank-edge foam
Full 2D simplex noise is inlined (mod289, permute helpers). Key patterns:
- `scrolledUv = vUv + vec2(0.0, -uTime * 0.05)` — UV-scrolled flow (downstream direction)
- Foam stripes: two `snoise()` passes at different frequencies + `smoothstep + step(0.5, foam)` for binary threshold
- Bank-edge foam: `smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x)` (pulse near UV.x=0/1)
- `mix(uColorNear, uColorFar, depth)` for gradient depth cueing

### Module-scope material + single useFrame
```typescript
// Module scope — computed once, never re-created
const _waterShaderMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime:      { value: 0 },
    uColorNear: { value: new THREE.Color('#4ec5e8') },
    uColorFar:  { value: new THREE.Color('#2a8aaa') },
  },
  vertexShader: _waterVertexShader,
  fragmentShader: _waterFragmentShader,
  side: THREE.DoubleSide,
  fog: true,
  transparent: false,
});

function WaterRibbon() {
  useFrame(({ clock }) => {
    _waterShaderMat.uniforms.uTime.value = clock.getElapsedTime();
  });
  return (
    <mesh
      geometry={_waterGeo}
      material={_waterShaderMat}
      frustumCulled={false}
      matrixAutoUpdate={false}
      renderOrder={2}
    />
  );
}
```

`matrixAutoUpdate=false` on a static-geometry mesh means Three.js never rebuilds its world matrix — safe when it never moves.

### CSM prefix removal (if adapting reference shaders)
The `.firecrawl/water-fragment.glsl` uses `three-custom-shader-material` conventions:
- `csm_vUv` → declare `varying vec2 vUv` in both shaders
- `csm_FragColor` → `gl_FragColor`
- `csm_Position` → standard `position` attribute

### Geometry: static buffer, GPU animation
Keep `_waterGeo` as a static module-scope `PlaneGeometry` or spline-swept ribbon. GPU vertex shader handles all wave displacement via `uTime`. No `pos.needsUpdate = true`, no `computeVertexNormals()` — eliminates the per-frame CPU cost pattern documented in old memory.

### Gameplay juice props using same module-scope pattern
All props built at module scope and placed via spline at load time:
- `clientSpline.centerlineAt(t)` + `normalAt(t)` for lateral offset
- `matrixAutoUpdate=false` after placement
- Power-up boxes: `MeshStandardMaterial` with `emissive` + `emissiveIntensity` (no point lights — stays within Iris Xe budget)
- Wake ribbons: `AdditiveBlending + transparent:true, depthWrite:false` on `MeshBasicMaterial`

## Context
Built for Reef Race v2 (`apps/web/src/lib/three/activities/reef-race/river-scene.tsx`) 2026-04-29. Replaces static `MeshLambertMaterial` water with animated shader. Build passed TypeScript clean with 6/7 task success.
