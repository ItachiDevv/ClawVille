'use client';

/**
 * water-material.tsx — Modern R3F shaderMaterial() pattern for Reef Race water.
 *
 * Exports:
 *   WaterMaterial  — drei shaderMaterial() factory class, extended into R3F
 *   WaterSurface   — React component that renders the animated water plane
 *
 * Visual features:
 *   - Multi-octave sin wave vertex displacement (GPU — zero CPU per-frame cost)
 *   - Inline 2D simplex noise foam stripes (UV-scrolled downstream)
 *   - Bank-edge foam: dual turbulence layers, creamy white blend
 *   - colorNear (#5fdcff) → colorFar (#3aaedf) depth gradient
 *
 * Iris Xe constraints honoured:
 *   - Plain Mesh + ShaderMaterial (NOT InstancedMesh + ShaderMaterial)
 *   - import from 'three' only (not 'three/webgpu')
 *   - Module-scope geometry — zero per-frame allocation
 *   - No drei <Text> or <Billboard>
 *   - frustumCulled=false (animated mesh — bounding sphere is stale)
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { shaderMaterial } from '@react-three/drei';
import { extend } from '@react-three/fiber';
import * as THREE from 'three';

// ─── Track layout constants (must match river-scene.tsx) ─────────────────────
const TRACK_HALF_X   = 1200;
const TRACK_LEN_Z    = 20000;
const TRACK_START_Z  = -500;
const TRACK_CENTER_Z = TRACK_START_Z + TRACK_LEN_Z / 2;
const WATER_Y        = 40;
const WATER_W        = TRACK_HALF_X * 2;   // 2400 wu
const WATER_L        = TRACK_LEN_Z;        // 20000 wu
const WATER_SEG_X    = 64;
const WATER_SEG_Z    = 128;

// ─── Shaders ─────────────────────────────────────────────────────────────────

/**
 * Vertex shader — multi-octave sin wave displacement.
 * All wave motion is GPU-side; geometry is a static PlaneGeometry.
 * PlaneGeometry lives in XY plane; mesh rotation.x=-PI/2 maps to XZ world.
 * We displace along local Z (→ world Y after rotation).
 */
const _vertexShader = /* glsl */`
  uniform float uTime;
  varying vec2  vUv;

  void main() {
    vUv = uv;

    // PlaneGeometry XY plane — after mesh rotation.x = -PI/2:
    //   local X → world X, local Y → world -Z, local Z → world Y
    // Displace local Z so it becomes world Y wave.
    float x = position.x;
    float y = position.y;

    float wave =
        sin(x * 0.005 + uTime * 0.8)  * 4.0
      + sin(y * 0.003 + uTime * 1.2)  * 3.0
      + sin((x + y) * 0.002 - uTime * 0.6) * 2.0;

    vec3 displaced = position;
    displaced.z += wave;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

/**
 * Fragment shader — 2D simplex noise foam stripes + bank-edge foam.
 *
 * Inline simplex noise (mod289 / permute / snoise) so there's no runtime
 * dependency on an external noise texture or glsl-noise import.
 *
 * Key visual layers (bottom to top):
 *   1. Depth-gradient color mix (uColorNear → uColorFar via UV vignette)
 *   2. UV-scrolled foam stripes (simplex at uTextureSize frequency)
 *   3. Bank-edge foam (dual turbulence, creamy white)
 */
const _fragmentShader = /* glsl */`
  uniform float uTime;
  uniform vec3  uColorNear;
  uniform vec3  uColorFar;
  uniform float uTextureSize;

  varying vec2 vUv;

  // ── 2D simplex noise helpers ────────────────────────────────────────────────
  vec3 mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289_2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x)  { return mod289_3(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(
       0.211324865405187,   // (3.0 - sqrt(3.0)) / 6.0
       0.366025403784439,   // 0.5 * (sqrt(3.0) - 1.0)
      -0.577350269189626,   // -1.0 + 2.0 * C.x
       0.024390243902439    // 1.0 / 41.0
    );
    vec2  i  = floor(v + dot(v, C.yy));
    vec2  x0 = v - i + dot(i, C.xx);
    vec2  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4  x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289_2(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                           + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x  = 2.0 * fract(p * C.www) - 1.0;
    vec3 h  = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x  * x0.x    + h.x  * x0.y;
    g.yz = a0.yz * x12.xz  + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  // ── End noise helpers ───────────────────────────────────────────────────────

  void main() {
    // ── 1. Depth gradient (vignette from center of UV) ──────────────────────
    vec2  center = vec2(0.5, 0.5);
    float depth  = distance(vUv, center) * 1.6;
    depth = clamp(depth, 0.0, 1.0);
    vec3  baseColor = mix(uColorNear, uColorFar, depth);

    // ── 2. UV-scrolled foam stripes ─────────────────────────────────────────
    // Flow downstream (negative V direction)
    vec2 scrolledUv = vUv + vec2(0.0, -uTime * 0.05);

    // Two noise octaves for stripe pattern
    float foam1  = snoise(scrolledUv * uTextureSize)  * 0.5 + 0.5;
    float foam2  = snoise(scrolledUv * uTextureSize * 2.0 + vec2(3.7, 1.3)) * 0.5 + 0.5;
    float foam   = (foam1 + foam2) * 0.5;

    // Binary threshold → soft stripe
    float fStr   = smoothstep(0.45, 0.55, foam);
    float foamMask = step(0.5, fStr);

    vec3 foamColor  = vec3(1.0, 0.98, 0.95);
    vec3 finalColor = mix(baseColor, foamColor, foamMask * 0.45);

    // ── 3. Bank-edge foam (dual turbulence layers) ──────────────────────────
    // edgeDist in UV space: 0 at edges (x≈0 or x≈1), 1 at center
    float edgeDist    = min(vUv.x, 1.0 - vUv.x);
    float edgeFactor  = 1.0 - smoothstep(0.0, 0.12, edgeDist);

    vec2 edgeUv1     = scrolledUv * 60.0;
    vec2 edgeUv2     = scrolledUv * 150.0 + vec2(5.1, 2.7);

    float foamTurb1  = snoise(edgeUv1  + vec2(0.0, uTime * 1.2))  * 0.5 + 0.5;
    float foamTurb2  = snoise(edgeUv2  + vec2(0.0, uTime * 2.0))  * 0.5 + 0.5;

    float combined       = foamTurb1 * 0.6 + foamTurb2 * 0.4;
    float bankFoamIntens = 0.6 + 0.4 * combined;

    vec3 bankFoamColor = vec3(1.0, 0.97, 0.92);
    finalColor = mix(finalColor, bankFoamColor, edgeFactor * bankFoamIntens * 0.8);

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

// ─── shaderMaterial() factory ────────────────────────────────────────────────

/**
 * WaterMaterial — drei shaderMaterial factory.
 *
 * Generates a Three.js material class with typed uniform setters/getters.
 * After `extend({ WaterMaterial })`, JSX `<waterMaterial>` is available.
 *
 * Uniform update pattern (direct property assignment — no .uniforms lookup):
 *   matRef.current.uTime = state.clock.elapsedTime;
 */
export const WaterMaterial = shaderMaterial(
  // Uniform defaults — these become JSX props AND class setters
  {
    uTime:        0,
    uColorNear:   new THREE.Color('#5fdcff'),
    uColorFar:    new THREE.Color('#3aaedf'),
    uTextureSize: 45,
  },
  _vertexShader,
  _fragmentShader,
);

// Register with R3F — must be at module scope, runs once on import
extend({ WaterMaterial });

// ─── TypeScript declaration ───────────────────────────────────────────────────
// Tells R3F's JSX types about <waterMaterial> so the element is typed.
// ThreeElements['shaderMaterial'] provides the base mesh-element props.

declare module '@react-three/fiber' {
  interface ThreeElements {
    waterMaterial: ThreeElements['shaderMaterial'] & {
      uTime?: number;
      uColorNear?: THREE.Color;
      uColorFar?: THREE.Color;
      uTextureSize?: number;
    };
  }
}

// ─── Module-scope geometry (static — shader handles all displacement) ─────────

/**
 * Static PlaneGeometry for the water surface.
 * Never mutated after creation — GPU vertex shader handles all wave animation.
 * Zero per-frame CPU cost (no needsUpdate, no computeVertexNormals).
 */
const _waterGeo = new THREE.PlaneGeometry(WATER_W, WATER_L, WATER_SEG_X, WATER_SEG_Z);

// ─── WaterSurface component ───────────────────────────────────────────────────

/**
 * WaterSurface — renders the animated water plane for Reef Race v2.
 *
 * Uses the drei shaderMaterial() pattern:
 *   - Material is registered via extend() at module scope
 *   - uTime is updated via direct property assignment in useFrame
 *   - Geometry is module-scope PlaneGeometry (never mutated)
 *
 * Wire-up in river-scene.tsx:
 *   import { WaterSurface } from './water-material';
 *   // replace <WaterSurface /> in RiverScene body
 */
export function WaterSurface() {
  // InstanceType<typeof WaterMaterial> gives us the generated class instance
  // which has typed setters: matRef.current.uTime = n;
  const matRef = useRef<InstanceType<typeof WaterMaterial>>(null);

  useFrame((state) => {
    if (matRef.current) {
      // Direct property assignment — drei shaderMaterial generates setters
      // that write through to material.uniforms[key].value automatically.
      matRef.current.uTime = state.clock.elapsedTime;
    }
  });

  return (
    <mesh
      geometry={_waterGeo}
      position={[0, WATER_Y, TRACK_CENTER_Z]}
      rotation={[-Math.PI / 2, 0, 0]}
      frustumCulled={false}
      matrixAutoUpdate={false}
      renderOrder={2}
    >
      {/*
        waterMaterial is the lowercase R3F name for WaterMaterial (extend convention).
        ref captures the material instance for useFrame uTime updates.
        attach="material" is implicit on direct children of <mesh>.
      */}
      <waterMaterial
        ref={matRef}
        side={THREE.DoubleSide}
        fog={true}
        key={WaterMaterial.key}
      />
    </mesh>
  );
}
