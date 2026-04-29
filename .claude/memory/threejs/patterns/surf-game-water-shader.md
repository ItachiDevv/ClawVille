---
title: Surf-game-quality water shader — depth + refraction-feel + foam + sun glint
category: pattern
tags: [water, shader, shadermaterial, reef-race, depth, foam, sun-glint, simplex-noise, drei, r3f]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary
Multi-layer water shader that reads as DEEP from any camera angle. Uses UV.x edge-to-center depth shift, fake refraction shimmer, low-frequency dual-octave noise for surface motion, soft white-cap foam, pulsing bank-edge foam, and fake Phong sun glint.

## Details

### What killed the previous shader (lessons learned)

The river-scene.tsx inline shader used noise scales of 56/20 (iter-7f), which means
56 oscillations across the ribbon UV width. At chase-cam altitude the ribbon subtends ~1.5°
of FOV, so 56 oscillations = sub-pixel — color averaging produces grey sludge.

**Rule: noise scale N means N oscillations across the 0..1 UV range. Cap at 12–20 max from
aerial perspective views. 56+ always aliases to grey.**

The depth gradient used `length(uv - 0.5) * 1.5` (vignette from the 2D UV center), which
is wrong for a river ribbon: "deep" should be at UV.x=0.5 (channel center), not at (0.5,0.5)
(midpoint along the track). Use `min(uv.x, 1-uv.x)` for edge-to-center depth.

### Vertex shader (minimal)

No Y displacement — the ribbon is already at the correct Y (WATER_Y=-200). Displacement
clipping into the canyon floor/wall was the main reason to avoid it. Just pass vUv and
vWorldPos through.

```glsl
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```

### Fragment: depth

```glsl
float edgeDist    = min(vUv.x, 1.0 - vUv.x);  // 0 at banks, 0.5 at center
float depthFactor = smoothstep(0.0, 0.25, edgeDist);
// Refraction wiggle — cheap shimmer without RTT
float wiggle      = sin(uTime * 0.4 + vWorldPos.z * 0.003) * 0.015;
float depthPerturbed = clamp(depthFactor + wiggle, 0.0, 1.0);
vec3 baseColor    = mix(uColorShallow, uColorDeep, depthPerturbed);
// Rim brightness at edge (wet waterline)
baseColor += (1.0 - depthFactor) * 0.18;
```

### Fragment: multi-layer noise (correct scales)

```glsl
// scroll1 = large-slow pattern; scroll2 = smaller-fast pattern
vec2 scroll1 = vUv + vec2(0.0, -uTime * 0.03);
vec2 scroll2 = vUv + vec2(0.0, -uTime * 0.06) + vec2(17.3, 4.1);
float n1 = snoise(scroll1 * 12.0) * 0.5 + 0.5;
float n2 = snoise(scroll2 *  8.0) * 0.5 + 0.5;
float flowFoam = n1 * 0.6 + n2 * 0.4;
```

### Fragment: white-cap foam (soft crest-only)

```glsl
float foamMask  = smoothstep(0.60, 0.65, flowFoam);  // top 5% of noise
baseColor = mix(baseColor, uColorFoam, foamMask);
```

### Fragment: edge foam (pulsing bank waterline)

```glsl
float edgeFactor = 1.0 - smoothstep(0.0, 0.06, edgeDist);
// Sin period 2π/0.01 ≈ 628wu — pulse visible even from altitude
float edgeFoam   = edgeFactor * (0.7 + 0.3 * sin(uTime * 1.5 + vWorldPos.z * 0.01));
baseColor = mix(baseColor, vec3(0.96, 0.98, 1.0), edgeFoam * 0.85);
```

### Fragment: sun glint (fake Phong)

```glsl
// cameraPosition is a built-in ShaderMaterial uniform
vec3 normal    = vec3(0.0, 1.0, 0.0);
vec3 viewDir   = normalize(cameraPosition - vWorldPos);
vec3 reflected = reflect(-uSunDir, normal);
float spec     = pow(max(dot(reflected, viewDir), 0.0), 32.0);
float glint    = spec * 0.28 * depthFactor;  // strongest at center
baseColor     += vec3(glint);
```

### Uniforms (drei shaderMaterial defaults)

```ts
{
  uTime:         0,
  uColorShallow: new THREE.Color('#7fdfff'),   // light cyan (bank)
  uColorDeep:    new THREE.Color('#1d6f8a'),   // deep teal (center)
  uColorFoam:    new THREE.Color('#f2faff'),   // blue-white foam caps
  uSunDir:       new THREE.Vector3(0.345, 0.924, 0.168), // normalized DIR_POSITION
}
```

### Geometry convention (spline ribbon)

UV.x=0 left bank, UV.x=1 right bank, UV.y=arclength fraction 0..1.
This means `min(uv.x, 1-uv.x)` correctly gives edge-to-center distance.

## Context

Built for `water-surf.tsx` in Reef Race v2. Replaced the inline `_waterShaderMat` in
`river-scene.tsx` which used noise scale 56 (aliased from altitude) and vignette depth
gradient (wrong axis for a river ribbon). User complaint was "0 depth like a real surfing
game". Build verified TypeScript-clean 2026-04-29.

Key prior-art studied:
- Codrops stylized water tutorial (`.firecrawl/codrops-stylized-water.md`)
- thaslle/stylized-water shaders (`.firecrawl/water-vertex.glsl`, `water-fragment.glsl`)
- river-scene.tsx iter-7f water shader (understood its failures before replacing)
