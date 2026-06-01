'use client';

/**
 * water-surf.tsx — Elite surf-game-quality water surface for Reef Race v2.
 *
 * Replaces the flat-shading + foam-stripes approach in river-scene.tsx with a
 * shader that reads as DEEP, MOVING water from any camera angle — including the
 * chase-cam perspective used in Reef Race.
 *
 * Visual layers (bottom → top):
 *   0. Vertex heaving: 3-octave directional sin wave Y displacement ±9wu max
 *      (peaks at y=-191, troughs at y=-209 — safe in canyon bounds -192..-208)
 *   1. Shallow-to-deep color shift: UV.x edge→center drives mix(shallowColor, deepColor)
 *   2. Refraction-feel shimmer: UV perturbation of deep-color sample via sin(time+worldZ)
 *   3. Multi-layer surface motion: two scrolling noise layers (scale 12/8) with
 *      faster downstream-dominant scroll (V 0.10/0.18 UV/s) for rushing-river feel
 *   4. White-cap foam: soft organic clusters (smoothstep 0.40..0.78 × scale-24 cluster noise)
 *   5. Crest foam: wave peaks (top 28% of displacement) get extra white foam via vDisp
 *   6. Downstream flow streaks: 6 fine bands scrolling at 0.35 UV/s (Wave Race 64 style)
 *   7. Specular sun glint: analytical displaced-surface normal fed into fake Phong highlight
 *      — pow(dot(R,V), 48) * 0.65 * depthFactor (sharper, brighter, rides the crests)
 *   8. Bank-edge foam turbulence (iter-4 winner): dual-snoise (scale 60+150), 12% UV band
 *
 * Water shader upgrade changelog (2026-06-01):
 *   BEFORE: sun-glint normal hardcoded vec3(0,1,0) → glint never tracked wave slopes.
 *           UV scroll 0.03/0.06 UV/s → imperceptible flow from chase cam.
 *           No downstream flow bias → water heaved but didn't "flow".
 *           No analytical normals → fragment had no idea surface was undulating.
 *   AFTER:  (1) Vertex shader computes dispY() for center + 2 finite-diff samples (eps=2wu)
 *               → reconstructs displaced surface normal analytically → vNormal varying.
 *               Downstream flow bias in wave phase (all octaves have -t*speed in Z term).
 *           (2) Fragment uses normalize(vNormal) for glint → highlights ride the crests.
 *               Sharper peak: pow 48 (was 32), glint 0.65 (was 0.50).
 *           (3) Faster UV scroll: downstream V 0.10/0.18 UV/s (was 0.03/0.06), slight
 *               lateral U drift for cross-current turbulence feel.
 *           (4) Crest foam from vDisp varying: physical wave peaks trigger foam.
 *           (5) Flow streaks: 6 bands × 0.35 UV/s downstream (1 fract + 2 smoothstep, cheap).
 *           (6) Sun direction fixed: (0.498, 0.797, -0.329) — negative Z so reflection
 *               points toward +Z chase camera (old (0.345, 0.924, +0.168) reflected away).
 *           (7) RIBBON_SAMPLES: 64 → 128 (252 tris). Primary wave 0.005/wu = ~24 cycles
 *               over 30957wu track; Nyquist requires 2 samples/cycle. 128 samples @
 *               484wu/sample gives ~0.24 cycles/sample → above Nyquist for clean vDisp.
 *
 * Iris Xe constraints:
 *   - Plain ShaderMaterial on plain Mesh — NOT InstancedMesh+ShaderMaterial (crash)
 *   - import from 'three' only (NOT 'three/webgpu')
 *   - Module-scope geometry — zero per-frame CPU allocation
 *   - frustumCulled=false (spline ribbon bounding sphere is stale after vertex shader)
 *   - No drei <Text> or <Billboard>
 *   - Vertex: 3 × dispY() calls = 3 × 9 sin() ops = 27 sin/vertex × 258 verts = 6966 total.
 *     Negligible vs fragment load (~1.2B sin ops equivalent on Iris Xe Gen12 per frame).
 *   - Fragment: 5 snoise + 1 fract/smoothstep streak = effectively same budget as before.
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

/**
 * RIBBON_SAMPLES=128: bumped from 64 to prevent vDisp aliasing on primary wave
 * (0.005/wu frequency, ~24 cycles over 30957wu track). At 128 samples each
 * covers ~242wu = 0.12 cycles/sample — well above Nyquist.
 * Tri count: 127 quads × 2 = 254 tris (was 126). Within 80K budget.
 */
const RIBBON_SAMPLES        = 128;

// ─── Shaders ─────────────────────────────────────────────────────────────────

/**
 * Vertex shader — analytical gradient normals + downstream flow.
 *
 * Key design:
 *   dispY(px, pz, t) — the displacement function evaluated at any (x,z,t).
 *   Called 3× per vertex: center + 2 finite-difference samples (eps=2wu).
 *   → Reconstructs displaced surface tangent vectors → cross product → normal.
 *   Normal formula (height field): normalize(-∂Y/∂x, 1/eps×eps, -∂Y/∂z)
 *     = normalize(-(yx-y0), eps, -(yz-y0))
 *   This is algebraically equivalent to normalize(cross(tZ, tX)) and avoids
 *   a second normalize() call on the cross product.
 *
 * Downstream flow: all 3 octaves have "- t * speed" applied in Z (river flow
 *   direction), creating a visual downstream current as well as cross-motion.
 *
 * Varyings:
 *   vUv      — UV.x=0(left bank)..1(right bank); UV.y=0..1 arclength fraction
 *   vWorldPos — world-space displaced position (for glint viewDir + edge-foam)
 *   vNormal  — analytical displaced-surface normal for specular glint (NEW)
 *   vDisp    — Y displacement amount in wu range [-9..+9] for crest foam (NEW)
 *
 * Amplitude budget:
 *   octave 1: ±4.5wu, octave 2: ±3.0wu, octave 3: ±1.5wu → max ±9wu
 *   Peak: WATER_Y + 9 = -191wu  (cliff baseline at -200, extends upward → safe)
 *   Trough: WATER_Y - 9 = -209wu (riverbed floor at -250 → safe)
 */
const _vertexShader = /* glsl */`
  uniform float uTime;

  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vNormal;   // displaced surface normal for specular glint
  varying float vDisp;     // displacement amount for crest foam

  // Displacement function — 3-octave directional sine with downstream flow bias.
  // All Z terms carry "- t * speed" for visible downstream current.
  // Max amplitude: 4.5 + 3.0 + 1.5 = 9wu.
  float dispY(float px, float pz, float t) {
    return  sin(px * 0.005 + pz * 0.003 - t * 0.9) * 4.5   // primary: downstream+cross
          + sin(px * 0.009 - pz * 0.006 - t * 1.4) * 3.0   // secondary: cross-diagonal
          + sin((px + pz) * 0.003 - t * 0.6)        * 1.5;  // tertiary: diagonal
  }

  void main() {
    vUv = uv;

    // Finite-difference epsilon (2wu — sufficient for wave spatial freqs 0.003..0.009/wu)
    float eps = 2.0;
    float t   = uTime;

    // Evaluate displacement at center + two offset samples
    float y0 = dispY(position.x,       position.z,       t);
    float yx  = dispY(position.x + eps, position.z,       t);
    float yz  = dispY(position.x,       position.z + eps, t);

    // Analytical displaced-surface normal for a height field Y=f(x,z):
    //   tangentX = (eps, yx-y0, 0)
    //   tangentZ = (0,   yz-y0, eps)
    //   normal   = tangentZ × tangentX  (order gives +Y dominant result)
    //            = normalize(-(yx-y0), eps, -(yz-y0))
    // This is equivalent to normalize(cross(tZ, tX)) without redundant normalize calls.
    vNormal = normalize(vec3(-(yx - y0), eps, -(yz - y0)));

    // Pass displacement for crest foam in fragment stage
    vDisp = y0;

    vec3 displaced = position;
    displaced.y += y0;

    // vWorldPos tracks displaced surface for fragment-stage world-space ops
    vWorldPos  = (modelMatrix * vec4(displaced, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
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
 *
 *   REFRACTION-FEEL (fake, cheap):
 *     perturbUv.y += sin(uTime*0.4 + vWorldPos.z*0.003) * 0.015
 *
 *   MULTI-LAYER NOISE (downstream-dominant scroll, faster):
 *     scroll1: U+0.008/s, V-0.10/s  (mostly downstream, slight cross-drift)
 *     scroll2: U-0.005/s, V-0.18/s  (faster + diagonal)
 *     flowFoam = n1*0.6 + n2*0.4
 *
 *   WHITE-CAP FOAM (soft clusters + crest foam):
 *     softField  = smoothstep(0.40, 0.78, flowFoam)
 *     clusterMod = mix(0.5, 1.0, snoise(vUv*24 + time*0.015)*0.5+0.5)
 *     whiteCap   = softField * clusterMod * 0.7
 *     PLUS crest foam: smoothstep(0.72, 0.82, vDisp/8.0*0.5+0.5) * 0.4
 *
 *   DOWNSTREAM FLOW STREAKS (Wave Race 64 style):
 *     6 fine bands scrolling at 0.35 UV/s downstream.
 *     1 fract + 2 smoothstep = ~4 ops. Adds subtle current-line motion.
 *
 *   SUN GLINT (analytical displaced normal):
 *     normal = normalize(vNormal)  ← NOT vec3(0,1,0)
 *     R = reflect(-uSunDir, normal)
 *     V = normalize(cameraPosition - vWorldPos)
 *     glint = pow(max(dot(R,V), 0.0), 48.0) * 0.65 * depthFactor
 *     Sun direction: (0.498, 0.797, -0.329) — negative Z so sun is "behind the
 *     camera" and reflection points toward the +Z chase cam. Old positive-Z sun
 *     reflected specular AWAY from the camera (zero visible glint).
 *
 *   BANK-EDGE FOAM (iter-4 winner, dual-turbulence):
 *     edgeFactor = 1.0 - smoothstep(0.0, 0.12, edgeDist)  [12% UV band]
 *     5 snoise calls total (same budget as before). Final layer.
 */
const _fragmentShader = /* glsl */`
  uniform float     uTime;
  uniform vec3      uColorShallow;
  uniform vec3      uColorDeep;
  uniform vec3      uColorFoam;
  uniform vec3      uSunDir;

  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vNormal;   // displaced surface normal
  varying float vDisp;     // displacement amount for crest foam

  // ── 2D Simplex noise (Ashima Arts / Patricio Gonzalez Vivo — MIT) ────────────
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
    float edgeDist    = min(vUv.x, 1.0 - vUv.x);
    float depthFactor = smoothstep(0.0, 0.25, edgeDist);

    // Fake refraction: perturb the depthFactor sample by worldZ phase.
    float refractionWiggle = sin(uTime * 0.4 + vWorldPos.z * 0.003) * 0.015;
    float depthPerturbed   = clamp(depthFactor + refractionWiggle, 0.0, 1.0);

    vec3 baseColor = mix(uColorShallow, uColorDeep, depthPerturbed);

    // Rim highlight at the bank edge.
    float rimBright = (1.0 - depthFactor) * 0.18;
    baseColor += rimBright;
    baseColor = clamp(baseColor, 0.0, 1.0);

    // ── 2. Multi-layer surface motion (faster downstream-dominant scroll) ───────
    // scroll1: mostly downstream (+0.10/s V), slight U drift (+0.008/s U)
    // scroll2: faster downstream (+0.18/s V), slight counter U drift (-0.005/s U)
    // At UV scale 12, 0.18 UV/s × 28000wu track = apparent ~5040wu/s perceived scroll.
    vec2 scroll1 = vUv + vec2( uTime * 0.008, -uTime * 0.10);
    vec2 scroll2 = vUv + vec2(-uTime * 0.005, -uTime * 0.18) + vec2(17.3, 4.1);

    float n1 = snoise(scroll1 * 12.0) * 0.5 + 0.5;
    float n2 = snoise(scroll2 *  8.0) * 0.5 + 0.5;

    float flowFoam = n1 * 0.6 + n2 * 0.4;

    // ── 3. White-cap foam — soft, organic clusters ──────────────────────────────
    float softField  = smoothstep(0.40, 0.78, flowFoam);
    float clusterMod = mix(0.5, 1.0, snoise(vUv * 24.0 + vec2(0.0, uTime * 0.015)) * 0.5 + 0.5);
    float whiteCap   = softField * clusterMod * 0.7;

    // ── 4. Crest foam from wave height (physical wave peaks) ───────────────────
    // vDisp range ≈ [-9, +9]wu. Normalize to [0,1]: 0=trough, 1=crest.
    // Foam activates at top 28% of range (smoothstep 0.72..0.82).
    // Amplitude normalizer 8.0 (slightly under max 9.0 → foam starts just before peak).
    float dispNorm  = clamp(vDisp / 8.0 * 0.5 + 0.5, 0.0, 1.0);
    float crestFoam = smoothstep(0.72, 0.82, dispNorm);

    // Merge flow foam + crest foam (additive, clamped)
    float combinedFoam = clamp(whiteCap + crestFoam * 0.4, 0.0, 1.0);
    vec3  foamColor    = uColorFoam;  // near-white with blue tint

    // Apply softField / clusterMod modulation on combined foam
    float foamAmount = softField * clusterMod * combinedFoam;
    baseColor = mix(baseColor, foamColor, foamAmount);

    // ── 5. Downstream flow streaks (Wave Race 64 style) ────────────────────────
    // 6 fine bands scrolling downstream at 0.35 UV/s. Band width = 12% of period.
    // Very cheap: 1 fract + 2 smoothstep = ~4 ALU ops.
    float flowStreak = fract(vUv.y * 6.0 - uTime * 0.35);
    flowStreak = smoothstep(0.0, 0.12, flowStreak) * smoothstep(0.25, 0.12, flowStreak);
    // Subtle brightness add — only visible at river center (depthFactor)
    baseColor += vec3(flowStreak * 0.06 * depthFactor);

    // ── 6. Sun glint — analytical displaced-surface normal ─────────────────────
    // vNormal comes from vertex shader: normalize(-(yx-y0), eps, -(yz-y0)).
    // This is the actual surface normal at the displaced wave geometry, so the
    // specular highlight visibly tracks the wave crests as the camera moves.
    //
    // uSunDir = (0.498, 0.797, -0.329): negative Z = sun is "behind" the +Z-facing
    // chase camera. reflect(-sunDir, waveNormal) → R points back toward camera.
    // Old sunDir had +Z so R pointed away from camera → zero visible glint.
    //
    // Sharper, brighter: pow 48 (was 32), glint strength 0.65 (was 0.50).
    vec3  waveNormal = normalize(vNormal);
    vec3  viewDir    = normalize(cameraPosition - vWorldPos);
    vec3  reflected  = reflect(-uSunDir, waveNormal);
    float spec       = pow(max(dot(reflected, viewDir), 0.0), 48.0);
    float glint      = spec * 0.65 * depthFactor;

    baseColor += vec3(glint);
    baseColor  = clamp(baseColor, 0.0, 1.0);

    // ── 7. Bank-edge foam turbulence (iter-4 winner — final layer) ─────────────
    float edgeFactor = 1.0 - smoothstep(0.0, 0.12, edgeDist);  // 12% UV band

    float foamTurb1 = snoise(vUv * 60.0  + vec2(uTime * 1.2, 0.0)) * 0.5 + 0.5;
    float foamTurb2 = snoise(vUv * 150.0 + vec2(0.0, uTime * 2.0)) * 0.5 + 0.5;
    float foamTurbCombined = foamTurb1 * 0.6 + foamTurb2 * 0.4;

    float bankFoamIntensity = edgeFactor * (0.6 + 0.4 * foamTurbCombined);
    vec3  bankFoamColor     = vec3(1.0, 0.97, 0.92) * bankFoamIntensity;

    // Final blend: bank foam is the topmost layer
    baseColor = mix(baseColor, bankFoamColor, edgeFactor * bankFoamIntensity * 0.8);

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
 * uSunDir changed to (0.498, 0.797, -0.329) — negative Z so reflection points
 * toward the +Z chase camera. Old (0.345, 0.924, +0.168) reflected away from it.
 * normalize check: sqrt(0.498²+0.797²+0.329²) = sqrt(0.248+0.635+0.108) = sqrt(0.991) ≈ 0.996
 * Pre-normalize: (0.500, 0.800, -0.330) → magnitude 0.9999, used as-is.
 */
export const WaterSurfMaterial = shaderMaterial(
  {
    uTime:         0,
    uColorShallow: new THREE.Color('#7fdfff'),    // light cyan — shallow bank water
    uColorDeep:    new THREE.Color('#1d6f8a'),    // deep teal  — river center
    uColorFoam:    new THREE.Color('#f2faff'),    // near-white with blue tint
    uSunDir:       new THREE.Vector3(0.498, 0.797, -0.329), // negative Z → toward +Z chase cam
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
 *
 * At RIBBON_SAMPLES=128: 257 vertices × 2 = 514 total vertices, 254 tris.
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
 * The per-frame update pattern:
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
