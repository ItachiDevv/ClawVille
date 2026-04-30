'use client';

/**
 * terrain-shader.tsx — Stylized cartoon terrain for Reef Race v2.
 *
 * Replaces the stale flat green ground plane with a subdivided, procedurally
 * displaced mesh driven by a custom ShaderMaterial.
 *
 * Design goals (matching the quality of the animated water shader):
 *   - Rolling hills via vertex-displaced simplex noise, masked near the river
 *     so the hillsides don't poke through the riverbed corridor.
 *   - Two-frequency grass blend (light/dark patches), slow-drifting dirt spots.
 *   - Bank shadowing (slightly darker ground near the water edge).
 *   - Hilltop brightening so elevation reads clearly.
 *
 * Iris Xe invariants:
 *   - Plain ShaderMaterial on plain Mesh — NOT InstancedMesh (that combo crashes).
 *   - import from 'three' only (not 'three/webgpu').
 *   - All geometry at module scope — zero per-frame GC.
 *   - frustumCulled=false + matrixAutoUpdate=false on the static mesh.
 *   - No drei Text / Billboard anywhere.
 *   - No external textures — fully procedural.
 *
 * Pattern: drei shaderMaterial() factory (modern R3F idiom).
 *   TerrainMaterial = shaderMaterial({ uTime: 0 }, vert, frag)
 *   extend({ TerrainMaterial })                  — registers JSX element
 *   <terrainMaterial ref={matRef} uTime={t} />   — zero-allocation uniform update
 *
 * Geometry budget:
 *   PlaneGeometry(4000, 24000, 32, 192) = 32×192 quads × 2 tris = 12,288 tris, 1 draw call.
 *   Old GroundPlane was 2 tris, 1 draw call.
 *   Delta: +12,286 tris, 0 extra draw calls.
 *   Still within the ≤220k tris scene budget (well under).
 *
 * Placement:
 *   The Reef Race ellipse track is centered at (0,0) in XZ.
 *   This plane is placed at (0, -1, 0) to sit just below the track surface (y=0).
 *   4000×24000 wu matches the narrow corridor (half-width 1050 wu) with
 *   sufficient visible hillside on both banks.
 */

import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { shaderMaterial } from '@react-three/drei';
import { extend } from '@react-three/fiber';
import * as THREE from 'three';

// ─── Simplex noise GLSL (2D) ─────────────────────────────────────────────────
// Standard 2D simplex noise by Ian McEwan / Ashima Arts.
// Inlined to avoid any external texture dependency.
const _snoiseFunctions = /* glsl */ `
  vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289v2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289v3(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187,
                        0.366025403784439,
                       -0.577350269189626,
                        0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289v2(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
`;

// ─── Vertex shader ────────────────────────────────────────────────────────────
// Computes rolling hill displacement with a smooth mask that fades hills out
// near the river corridor (|x| < 700 wu) so terrain doesn't poke through.
const _vertexShader = /* glsl */ `
  ${_snoiseFunctions}

  uniform float uTime;
  varying vec3 vWorldPos;
  varying float vYDisplacement;

  void main() {
    vec3 pos = position;

    // Distance from river center line (X=0 is the center of the ellipse track).
    // The river corridor spans roughly ±1050 wu in X.
    float distFromRiverCenter = abs(pos.x);

    // Mask: 0 near the river, 1 well outside. Ramps from 1100 to 1900 wu.
    float displacementMask = smoothstep(1100.0, 1900.0, distFromRiverCenter);

    // Large-scale rolling hills — very low frequency
    float largeNoise = snoise(pos.xz * 0.0008);  // range [-1, 1]

    // Smaller octave for surface variation
    float smallNoise = snoise(pos.xz * 0.003);   // range [-1, 1]

    // Convert from [-1,1] to [0,1] for cleaner amplitude
    largeNoise = largeNoise * 0.5 + 0.5;
    smallNoise = smallNoise * 0.5 + 0.5;

    // Final displacement: max ~100 wu at outer edges, 0 near river
    float disp = (largeNoise * 80.0 + smallNoise * 20.0) * displacementMask;

    pos.y += disp;

    // Pass world-space XZ and displacement amount to fragment
    vWorldPos = pos;
    vYDisplacement = disp;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

// ─── Fragment shader ──────────────────────────────────────────────────────────
// Multi-frequency noise blend: patchy grass + slow-drifting dirt patches.
// 2026-04-30: tiled CC0 grass diffuse (Polyhaven aerial_grass_rock) sampled in
// world space and multiplied with the procedural color tint for "texture paint"
// detail. Texture binding is uGrassMap; sampling cost is one texture2D() per
// fragment — Iris Xe safe (still plain Mesh + ShaderMaterial).
const _fragmentShader = /* glsl */ `
  ${_snoiseFunctions}

  uniform float     uTime;
  uniform sampler2D uGrassMap;
  varying vec3      vWorldPos;
  varying float     vYDisplacement;

  void main() {
    // ── Cut a HOLE for the river canyon ──────────────────────────────────────
    if (abs(vWorldPos.x) < 1300.0) discard;

    // ── Tiled grass texture sample (world-space UV, ~1 tile per 240wu) ───────
    vec2 grassUV = vWorldPos.xz * (1.0 / 240.0);
    vec3 grassTex = texture2D(uGrassMap, grassUV).rgb;

    // ── Grass color palette (procedural tint) ────────────────────────────────
    vec3 grassLight = vec3(0.545, 0.784, 0.282);
    vec3 grassDark  = vec3(0.369, 0.620, 0.180);
    vec3 dirtSandy  = vec3(0.773, 0.647, 0.447);

    // ── Medium-frequency noise for grass patch variation ─────────────────────
    float nA = snoise(vWorldPos.xz * 0.002) * 0.5 + 0.5;
    float nB = snoise(vWorldPos.xz * 0.012 + uTime * 0.01) * 0.5 + 0.5;

    vec3 grassMix   = mix(grassLight, grassDark, smoothstep(0.3, 0.7, nA));
    vec3 procColor  = mix(grassMix, dirtSandy, smoothstep(0.65, 0.75, nB) * 0.6);

    // ── Combine: texture detail × procedural tint, with 0.6 strength on the tex ──
    // Pre-multiply texture toward neutral grey so tint stays dominant while detail comes through.
    vec3 grassDetail = mix(vec3(0.5), grassTex, 0.85);
    vec3 finalColor  = procColor * (grassDetail * 1.6); // ×1.6 compensates for 0.5 grey baseline

    // ── Bank shadow — slightly darker near the river edge ────────────────────
    float bankShadow = 1.0 - smoothstep(1050.0, 1800.0, abs(vWorldPos.x));
    finalColor *= mix(1.0, 0.78, bankShadow);

    // ── Height tint — hilltops get a subtle brightness boost ─────────────────
    float heightT = smoothstep(0.0, 80.0, vYDisplacement);
    finalColor = mix(finalColor, finalColor * 1.15, heightT);

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

// ─── Grass texture loader (module scope, reused across both strips) ──────────
const _grassTexLoader = new THREE.TextureLoader();
const _grassTex = _grassTexLoader.load('/textures/reef-race/grass-diff-1k.jpg');
_grassTex.wrapS = THREE.RepeatWrapping;
_grassTex.wrapT = THREE.RepeatWrapping;
_grassTex.colorSpace = THREE.SRGBColorSpace;
_grassTex.anisotropy = 4;

// ─── TerrainMaterial — drei shaderMaterial() factory ─────────────────────────
export const TerrainMaterial = shaderMaterial(
  { uTime: 0, uGrassMap: _grassTex },
  _vertexShader,
  _fragmentShader,
  (mat) => {
    if (!mat) return;
    mat.side = THREE.FrontSide;
    mat.transparent = false;
    mat.fog = true;
  },
);

// ─── Register with R3F so <terrainMaterial /> is a valid JSX element ─────────
extend({ TerrainMaterial });

// ─── TypeScript JSX augmentation ─────────────────────────────────────────────
// Tells tsc that <terrainMaterial> accepts uTime and inherits shaderMaterial props.
// ThreeElements['shaderMaterial'] is the canonical base type in @react-three/fiber.
declare module '@react-three/fiber' {
  interface ThreeElements {
    terrainMaterial: ThreeElements['shaderMaterial'] & {
      uTime?: number;
    };
  }
}

// ─── Module-scope geometry ────────────────────────────────────────────────────
// 2026-04-29 iter-7: terrain split into TWO strips bracketing the canyon
// corridor (corridor max halfWidth=1050, cliff outer-top=1300; strips start at
// x=±1300 outward). Discard-in-shader approach failed because dual chunks were
// loaded by Next.js bundle splitting — the OLD shader's extend() call
// frequently won the race, so the discard never fired. Two-strip-geometry
// is unambiguous: there's literally no terrain mesh inside the corridor.
//
// Each strip: 1200wu × 24000wu (was one 4000×24000 plane).
// Tris per strip: 16×192×2 = 6144. Total: 12 288 (same as before).
const _terrainStripGeo = new THREE.PlaneGeometry(1200, 24000, 16, 192);
// Kept for backwards-compat reference; unused.
const _terrainGeo = _terrainStripGeo;

// ─── TerrainShader component ──────────────────────────────────────────────────

/**
 * TerrainShader — drop-in replacement for the old flat green GroundPlane.
 *
 * Place inside any R3F Canvas that has the Reef Race ellipse scene.
 * The parent scene owns lighting, fog, and the track mesh.
 *
 * Tris: 12,288 (vs 2 for old GroundPlane). Draw calls: 1 (unchanged).
 */
export function TerrainShader() {
  // Ref typed as THREE.ShaderMaterial & { uTime: number } so the property
  // assignment in useFrame is type-safe without casting.
  const matRef = useRef<InstanceType<typeof TerrainMaterial>>(null);
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
  }, []);

  // Update only the time uniform — zero per-frame allocations.
  // Direct property assignment is safe: drei shaderMaterial proxies
  // mat.uTime → mat.uniforms.uTime.value under the hood.
  useFrame(({ clock }) => {
    if (matRef.current) {
      matRef.current.uTime = clock.elapsedTime;
    }
  });

  // Two strips bracketing the canyon — corridor at x∈[-1300, +1300] is bare
  // sky/water/cliff (no terrain ground). Strip centers at x=±1900 (1300 + 1200/2).
  return (
    <>
      <mesh
        ref={meshRef}
        geometry={_terrainStripGeo}
        position={[-1900, -1, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
        matrixAutoUpdate={false}
        receiveShadow
      >
        <terrainMaterial ref={matRef} />
      </mesh>
      <mesh
        geometry={_terrainStripGeo}
        position={[+1900, -1, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
        matrixAutoUpdate={false}
        receiveShadow
      >
        <terrainMaterial />
      </mesh>
    </>
  );
}
