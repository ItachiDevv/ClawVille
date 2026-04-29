'use client';

/**
 * water-surf.tsx — Elite surf-game-quality water surface for Reef Race v2.
 *
 * Replaces the flat-shading + foam-stripes approach in river-scene.tsx with a
 * shader that reads as DEEP, MOVING water from any camera angle — including the
 * chase-cam perspective used in Reef Race.
 *
 * Visual layers (bottom → top):
 *   1. Shallow-to-deep color shift: UV.x edge→center drives mix(shallowColor, deepColor)
 *   2. Refraction-feel shimmer: UV perturbation of deep-color sample via sin(time+worldZ)
 *   3. Multi-layer surface motion: two scrolling noise layers (scale 12/8, rate slow/fast)
 *   4. White-cap foam stripes: softstep(0.60..0.65) at noise crests only
 *   5. Edge foam: pulsing animated band at bank-water boundary
 *   6. Specular sun glint: fake Phong highlight — pow(dot(R,V), 32) * 0.25
 *
 * Iris Xe constraints:
 *   - Plain ShaderMaterial on plain Mesh — NOT InstancedMesh+ShaderMaterial (crash)
 *   - import from 'three' only (NOT 'three/webgpu')
 *   - Module-scope geometry — zero per-frame CPU allocation
 *   - frustumCulled=false (spline ribbon bounding sphere is stale after vertex shader)
 *   - No drei <Text> or <Billboard>
 *
 * API:
 *   export const WaterSurfMaterial — drei shaderMaterial() class, extend()-registered
 *   export function WaterSurf()    — React component; renders ribbon at WATER_Y=-200
 *
 * Wire-up in river-scene.tsx:
 *   import { WaterSurf } from './water-surf';
 *   // replace <WaterRibbon /> with <WaterSurf />
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { shaderMaterial } from '@react-three/drei';
import { extend } from '@react-three/fiber';
import * as THREE from 'three';

import { clientSpline } from './reef-race-spline-instance';

// ─── Geometry constants (must match river-scene.tsx) ─────────────────────────

/**
 * WATER_Y=-200: deep canyon ravine.  Rocky cliff banks in rocky-banks.tsx
 * are authored against this exact value — do NOT change without cascading.
 */
export const WATER_Y       = -200;
const RIBBON_SAMPLES        = 64;  // cross-section count (63 quads × 2 tris = 126 tris)

// ─── Shaders ─────────────────────────────────────────────────────────────────

/**
 * Vertex shader.
 *
 * NO vertex Y displacement — the ribbon geometry is already at WATER_Y=-200.
 * Adding displacement here would clip through the canyon riverbed (-250) and
 * cause z-fighting with the rocky-banks geometry.
 *
 * Passes:
 *   vUv      — UV.x=0(left bank) .. 1(right bank); UV.y=0..1 arclength fraction
 *   vWorldPos — world-space position used for:
 *               (a) Z-based edge-foam phase offset
 *               (b) sun glint (dot product with cameraPosition - vWorldPos)
 */
const _vertexShader = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Fragment shader — elite surf-game-quality water.
 *
 * Noise helper: inline 2D simplex noise (no texture dependency, no import).
 *
 * Key techniques:
 *
 *   DEPTH (shallow→deep):
 *     edgeDist = min(uv.x, 1-uv.x)  [0 at banks, 0.5 at center]
 *     depthFactor = smoothstep(0.0, 0.25, edgeDist)
 *     baseColor = mix(uColorShallow, uColorDeep, depthFactor)
 *     — Shallow is bright cyan (#7fdfff), deep is rich teal (#1d6f8a).
 *
 *   REFRACTION-FEEL (fake, cheap):
 *     perturbUv.y += sin(uTime*0.4 + vWorldPos.z*0.003) * 0.015
 *     — The deep-color mix target uses this perturbed position to shimmer
 *     slightly without a real refraction pass.
 *
 *   MULTI-LAYER NOISE (scales 12 / 8, two scroll rates):
 *     layer1 = snoise((vUv + vec2(0, -uTime*0.03)) * 12.0)
 *     layer2 = snoise((vUv + vec2(0, -uTime*0.06)) * 8.0 + vec2(17.3, 4.1))
 *     flowFoam = layer1*0.6 + layer2*0.4  (normalized to 0..1)
 *     — Scale 12 at UV.x range 0..1 = 12 oscillations across the ribbon.
 *     At chase-cam distance this is perfectly visible; from far above it softens
 *     to a textured haze rather than aliasing to grey.
 *
 *   WHITE-CAP FOAM (soft, crest-only):
 *     foamMask = smoothstep(0.60, 0.65, flowFoam)
 *     — Only the top 5% of the noise value triggers foam; the transition is
 *     smooth so it never looks like a harsh binary stripe.
 *
 *   EDGE FOAM (bank waterline pulse):
 *     edgeFactor = 1.0 - smoothstep(0.0, 0.06, min(uv.x, 1-uv.x))
 *     edgeFoam = edgeFactor * (0.7 + 0.3 * sin(uTime*1.5 + vWorldPos.z*0.01))
 *     — The sin period is 2π/0.01 ≈ 628wu, so you see animated foam pulses
 *     traveling along the canyon wall every ~628 world units.
 *
 *   SUN GLINT (fake Phong):
 *     normal = vec3(0,1,0)  (flat ribbon)
 *     R = reflect(-uSunDir, normal)
 *     V = normalize(cameraPosition - vWorldPos)
 *     glint = pow(max(dot(R, V), 0.0), 32.0) * 0.25
 *     — cameraPosition is a built-in uniform provided by THREE.ShaderMaterial.
 */
const _fragmentShader = /* glsl */`
  uniform float     uTime;
  uniform vec3      uColorShallow;
  uniform vec3      uColorDeep;
  uniform vec3      uColorFoam;
  uniform vec3      uSunDir;

  varying vec2 vUv;
  varying vec3 vWorldPos;

  // ── 2D Simplex noise (Ashima Arts / Patricio Gonzalez Vivo) ─────────────────
  vec3 _mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 _mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 _permute(vec3 x)  { return _mod289v3(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(
       0.211324865405187,   // (3.0-sqrt(3.0))/6.0
       0.366025403784439,   // 0.5*(sqrt(3.0)-1.0)
      -0.577350269189626,   // -1.0 + 2.0*C.x
       0.024390243902439    // 1.0/41.0
    );
    vec2  i  = floor(v + dot(v, C.yy));
    vec2  x0 = v - i + dot(i, C.xx);
    vec2  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4  x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = _mod289v2(i);
    vec3 p = _permute(_permute(i.y + vec3(0.0, i1.y, 1.0))
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
    g.x  = a0.x  * x0.x   + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  // ── End noise ────────────────────────────────────────────────────────────────

  void main() {

    // ── 1. Depth (edge → center color shift) ───────────────────────────────────
    // edgeDist: 0.0 at banks (uv.x=0 or 1), 0.5 at exact center
    float edgeDist   = min(vUv.x, 1.0 - vUv.x);
    float depthFactor = smoothstep(0.0, 0.25, edgeDist);

    // Fake refraction: perturb the depthFactor sample slightly by worldZ phase.
    // This makes the transition between shallow/deep "shimmer" as time changes.
    float refractionWiggle = sin(uTime * 0.4 + vWorldPos.z * 0.003) * 0.015;
    float depthPerturbed   = clamp(depthFactor + refractionWiggle, 0.0, 1.0);

    vec3 baseColor = mix(uColorShallow, uColorDeep, depthPerturbed);

    // Rim highlight at the bank edge — makes the waterline look bright and wet.
    float rimBright = (1.0 - depthFactor) * 0.18;
    baseColor += rimBright;
    // Clamp IMMEDIATELY after rimBright — prevents shallow-bank over-saturation
    // from compressing the headroom available to foam and glint additions.
    baseColor = clamp(baseColor, 0.0, 1.0);

    // ── 2. Multi-layer surface motion (two scrolling noise layers) ──────────────
    // Both scroll downstream (negative V direction in UV space).
    // Scale 12 = large slow pattern; Scale 8 = smaller fast pattern.
    vec2 scroll1 = vUv + vec2(0.0, -uTime * 0.03);
    vec2 scroll2 = vUv + vec2(0.0, -uTime * 0.06) + vec2(17.3, 4.1);

    float n1 = snoise(scroll1 * 12.0) * 0.5 + 0.5;
    float n2 = snoise(scroll2 *  8.0) * 0.5 + 0.5;

    // Combined flow noise (normalized 0..1)
    float flowFoam = n1 * 0.6 + n2 * 0.4;

    // ── 3. White-cap foam — soft, crest-only ───────────────────────────────────
    // smoothstep(0.60, 0.65) = only the top 5% of noise triggers foam.
    // Soft transition prevents harsh binary stripe look.
    float foamMask   = smoothstep(0.55, 0.62, flowFoam);
    vec3  foamColor  = uColorFoam;  // vec3(0.95, 0.97, 1.0) = slightly blue-white

    baseColor = mix(baseColor, foamColor, foamMask);

    // ── 4. Edge foam (bank-waterline pulse) ────────────────────────────────────
    // edgeFactor: 1.0 at uv.x=0 or 1, falls to 0 at 0.06 from edge.
    float edgeFactor = 1.0 - smoothstep(0.0, 0.06, edgeDist);

    // Animated foam pulse traveling along canyon (period ≈ 628wu in worldZ)
    float edgeFoam   = edgeFactor * (0.7 + 0.3 * sin(uTime * 1.5 + vWorldPos.z * 0.01));

    // Edge foam color: bright nearly-white
    vec3 edgeFoamColor = vec3(0.96, 0.98, 1.0);
    baseColor = mix(baseColor, edgeFoamColor, edgeFoam * 0.65);

    // ── 5. Sun glint (fake Phong specular) ─────────────────────────────────────
    // Water surface normal is (0,1,0) (flat ribbon with +Y normals).
    // cameraPosition is a built-in uniform in THREE.ShaderMaterial.
    vec3 normal  = vec3(0.0, 1.0, 0.0);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    // reflect() expects incident direction → negate sun direction
    vec3 reflected = reflect(-uSunDir, normal);
    float spec = pow(max(dot(reflected, viewDir), 0.0), 32.0);
    // Modulate by depth so glint is strongest in the deep center
    float glint = spec * 0.50 * depthFactor;

    baseColor += vec3(glint);

    gl_FragColor = vec4(baseColor, 1.0);
  }
`;

// ─── WaterSurfMaterial — drei shaderMaterial() factory ────────────────────────

/**
 * WaterSurfMaterial — R3F shaderMaterial class.
 *
 * Uniform defaults become JSX props AND typed setters on the instance:
 *   matRef.current.uTime = state.clock.elapsedTime;  // direct, not .uniforms.xxx.value
 *
 * uSunDir is normalized and matches the directional light in river-scene.tsx.
 * (Light position [340, 910, 230] → normalize ≈ [0.345, 0.924, 0.168])
 */
export const WaterSurfMaterial = shaderMaterial(
  {
    uTime:         0,
    uColorShallow: new THREE.Color('#7fdfff'),   // light cyan — shallow bank water
    uColorDeep:    new THREE.Color('#1d6f8a'),   // deep teal  — river center
    uColorFoam:    new THREE.Color('#f2faff'),   // near-white with blue tint
    uSunDir:       new THREE.Vector3(0.345, 0.924, 0.168), // normalized DIR_POSITION
  },
  _vertexShader,
  _fragmentShader,
);

// Register with R3F — runs once at module scope
extend({ WaterSurfMaterial });

// ─── TypeScript JSX declaration ───────────────────────────────────────────────

declare module '@react-three/fiber' {
  interface ThreeElements {
    waterSurfMaterial: ThreeElements['shaderMaterial'] & {
      uTime?:         number;
      uColorShallow?: THREE.Color;
      uColorDeep?:    THREE.Color;
      uColorFoam?:    THREE.Color;
      uSunDir?:       THREE.Vector3;
    };
  }
}

// ─── Geometry (module scope, baked once) ─────────────────────────────────────

/**
 * buildWaterRibbonGeo — triangle strip swept along the race spline.
 *
 * Ported from river-scene.tsx to make WaterSurf fully self-contained.
 * The geometry produced is IDENTICAL to the one in river-scene.tsx
 * (`_waterGeo`) — same UV convention (x=0 left, x=1 right, y=arclength).
 *
 * When the orchestrator wires WaterSurf into RiverScene it must REMOVE the
 * `_waterGeo` + `WaterRibbon` references from river-scene.tsx to avoid
 * building the geometry twice at module scope.
 *
 * UV contract:
 *   UV.x = 0  → left bank (n direction)
 *   UV.x = 1  → right bank (-n direction)
 *   UV.y = t  → arclength fraction 0..1 (downstream)
 */
function buildWaterRibbonGeo(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals:   number[] = [];
  const uvs:       number[] = [];
  const indices:   number[] = [];

  for (let i = 0; i <= RIBBON_SAMPLES; i++) {
    const t  = i / RIBBON_SAMPLES;
    const c  = clientSpline.centerlineAt(t);
    const n  = clientSpline.normalAt(t);
    const hw = clientSpline.widthAt(t);

    // Left edge
    positions.push(c.x + n.x * hw, WATER_Y, c.z + n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(0, t);

    // Right edge
    positions.push(c.x - n.x * hw, WATER_Y, c.z - n.z * hw);
    normals.push(0, 1, 0);
    uvs.push(1, t);

    if (i < RIBBON_SAMPLES) {
      const base = i * 2;
      // Two triangles per quad (consistent winding for +Y normals)
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs,       2));
  geo.setIndex(indices);
  return geo;
}

// Baked once at module load — shared across all WaterSurf renders
const _waterGeo = buildWaterRibbonGeo();

// ─── WaterSurf component ──────────────────────────────────────────────────────

/**
 * WaterSurf — drop-in replacement for WaterRibbon in RiverScene.
 *
 * Renders the spline-following water ribbon with the elite surf-game shader.
 *
 * Per-frame cost:
 *   - One uniform write (uTime) via direct property setter
 *   - Zero geometry mutations, zero allocations
 *
 * The nur-frame update pattern:
 *   matRef.current.uTime = state.clock.elapsedTime
 *   (drei shaderMaterial setters write through to uniforms[key].value)
 */
export function WaterSurf() {
  const matRef = useRef<InstanceType<typeof WaterSurfMaterial>>(null);

  useFrame((state) => {
    if (matRef.current) {
      matRef.current.uTime = state.clock.elapsedTime;
    }
  });

  return (
    <mesh
      geometry={_waterGeo}
      frustumCulled={false}
      renderOrder={2}
    >
      <waterSurfMaterial
        ref={matRef}
        side={THREE.DoubleSide}
        fog={true}
        key={WaterSurfMaterial.key}
      />
    </mesh>
  );
}
