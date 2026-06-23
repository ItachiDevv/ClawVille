'use client';

/**
 * surf-ribbon.tsx — THE WATER SURFACE: a premium surfable river ribbon winding
 * through the canyon-river gorge.
 *
 * This is the HERO ASSET. The geometry is swept along the shared `clientSpline`,
 * LIFTED + BANKED by `elevationAtT` + `bankAngleAtT` (the parity contract with
 * the rider, camera, karts, etc.). The shader makes it read as REAL surf water.
 *
 * Three merged layers:
 *   1. WATER SURFACE — analytic multi-wave water (ShaderMaterial on a plain Mesh,
 *      Iris-Xe safe). Deep teal→bright turquoise depth gradient, 4-wave analytic
 *      swell with gradient normals so specular glints ride crests, Fresnel sky
 *      sheen, organic crest foam, bank spray, downstream current streaks.
 *   2. NEON RAILS — thin edge-definition bands along each banked edge. Kept
 *      SUBTLE (small dimensions, dimmer color) so the WATER is the star.
 *      MeshBasicMaterial toneMapped:false (bloom target for definition glow only).
 *   3. CREST CAPS — thin bright inner waterline strip merged with rails.
 *
 * PARITY CONTRACT: ribbon Y = reefTrackElevationAt(t) at every t. Same function
 * as rider + camera. Never a flat plane.
 *
 * Iris Xe invariants:
 *   - ShaderMaterial ONLY on the plain water Mesh (not InstancedMesh).
 *   - fog:false on ShaderMaterial (scene.fog uniforms not merged → throw every frame).
 *   - import from 'three' (NOT 'three/webgpu').
 *   - NO drei <Text>/<Billboard>.
 *   - Module-scope geo/mat built ONCE. ONE uniform write per frame. ZERO per-frame allocs.
 *   - frustumCulled=false (vertex heave + large swept bounds make bind-pose bbox stale).
 *   - Noise/wave scale capped: simplex noise scale ≤24 (higher aliases to grey from
 *     altitude — documented gotcha). Analytic sin/cos waves are scale-immune.
 *
 * Draw calls: 1 water + 1 rails (merged L+R+crests) = 2.
 * Tris: water 128×2≈256 ; rails ~128×4 sides×2≈1024 → ~1300 total.
 *
 * Water design — what makes it read as surf:
 *   - 4 summed directional sin-waves (UV-space) + analytic gradient normals
 *   - Fresnel sheen: grazing → sky-color reflection; overhead → deep body color
 *   - Specular glint from analytic normal (RIDES the crest profile, not flat)
 *   - Depth: deep blue-teal at center channel → bright turquoise at shallow banks
 *   - Crest foam: from wave peaks + organic cluster modulation (soft, not PS2 stripes)
 *   - Bank spray: pulsing white foam at the waterline edges
 *   - Current streaks: very subtle downstream flow-line texture
 *   - UV scroll: downstream direction (UV.y decreases with time = flow toward viewer)
 *   - Dusk sun warm glint (matches the gorge atmosphere palette)
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { shaderMaterial } from '@react-three/drei';
import { extend } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { clientSpline } from './reef-race-spline-instance';
import { elevationAtT, bankAngleAtT } from './reef-race-elevation';

// ─── Geometry constants ───────────────────────────────────────────────────────
const RIBBON_SAMPLES  = 128; // longitudinal samples (256 tris on water surface)
// Rails kept SMALL so they read as edge-definition, not dominant neon bands.
// The WATER is the hero — rails just define the boundary.
const RAIL_HEIGHT     = 10;   // neon rail height (was 26 — reduced to be subtle)
const RAIL_THICKNESS  = 7;    // rail width outward from edge (was 18)
const CREST_WIDTH     = 18;   // inner glowing waterline strip width (was 34)

// ─── Local-frame helper: lifted + banked left/right edge points at t ─────────
interface EdgeFrame {
  cx: number; cz: number; cy: number;
  lx: number; ly: number; lz: number;
  rx: number; ry: number; rz: number;
  unx: number; uny: number; unz: number;
}

function frameAt(t: number): EdgeFrame {
  const c  = clientSpline.centerlineAt(t);
  const n  = clientSpline.normalAt(t);
  const hw = clientSpline.widthAt(t);
  const y  = elevationAtT(t);
  const bank = bankAngleAtT(t);
  const cb = Math.cos(bank);
  const sb = Math.sin(bank);

  // Banked lateral unit vector (n̂ rolled about the tangent axis)
  const unx = n.x * cb;
  const uny = sb;
  const unz = n.z * cb;

  return {
    cx: c.x, cz: c.z, cy: y,
    lx: c.x + unx * hw, ly: y + uny * hw, lz: c.z + unz * hw,
    rx: c.x - unx * hw, ry: y - uny * hw, rz: c.z - unz * hw,
    unx, uny, unz,
  };
}

// ─── Water surface shader ─────────────────────────────────────────────────────
//
// VERTEX: 4 analytic sin-wave displacement (UV-space). Small amplitude (≤4wu)
// keeps the banked cross-section intact and avoids canyon wall clipping.
// Analytic gradient (dWave/dUVx, dWave/dUVy) is computed alongside displacement
// so the normal is derived from the SAME math — specular glints ride the crests.
//
// FRAGMENT: depth gradient + multi-wave texture + analytic Fresnel + specular
// + crest foam + bank spray + current streaks. All in UV-space noise (scale ≤24)
// so it never aliases to grey from any camera altitude.
const _waterVert = /* glsl */`
  uniform float uTime;
  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vWaveNormal; // analytic surface normal from wave sum

  // 4 directional waves (UV space).
  // dir = direction in UV space (normalized), amp = amplitude (wu),
  // freq = spatial frequency (cycles across UV 0..1), speed = radians/sec.
  // NOTE: these must be IDENTICAL between vertex and fragment so the normal
  // and the displacement agree.

  // Wave params — kept in UV-space so scale doesn't vary with world curvature.
  //   W1: primary downstream swell (large slow roll)
  //   W2: cross-channel chop
  //   W3: secondary diagonal swell
  //   W4: fine surface chop (low amplitude, high freq)
  #define W1_DIR  vec2( 0.15, 1.00)   // mostly downstream with slight lateral
  #define W1_AMP  3.8                  // wu
  #define W1_FREQ 1.4                  // cycles across ribbon length
  #define W1_SPD  1.3

  #define W2_DIR  vec2( 1.00, 0.30)   // lateral cross-chop
  #define W2_AMP  2.2
  #define W2_FREQ 2.8
  #define W2_SPD  1.9

  #define W3_DIR  vec2(-0.60, 0.80)   // counter-diagonal
  #define W3_AMP  1.4
  #define W3_FREQ 3.5
  #define W3_SPD  1.6

  #define W4_DIR  vec2( 0.80, 0.60)   // fine diagonal chop
  #define W4_AMP  0.8
  #define W4_FREQ 5.5
  #define W4_SPD  2.6

  // Evaluate one wave: returns vec3(displacement_Y, dY/dUVx, dY/dUVy).
  // phase = freq * dot(dir_norm, uv) - speed * time
  // Y = amp * sin(phase)
  // dY/dUVx = amp * cos(phase) * freq * dir_norm.x
  // dY/dUVy = amp * cos(phase) * freq * dir_norm.y
  vec3 evalWave(vec2 dir, float amp, float freq, float speed, vec2 uv) {
    vec2  d    = normalize(dir);
    float ph   = freq * dot(d, uv) - speed * uTime;
    float s    = sin(ph);
    float c    = cos(ph);
    float dX   = amp * c * freq * d.x;
    float dY   = amp * c * freq * d.y;
    return vec3(amp * s, dX, dY);
  }

  void main() {
    vUv = uv;

    // Sum 4 waves
    vec3 r1 = evalWave(W1_DIR, W1_AMP, W1_FREQ, W1_SPD, uv);
    vec3 r2 = evalWave(W2_DIR, W2_AMP, W2_FREQ, W2_SPD, uv);
    vec3 r3 = evalWave(W3_DIR, W3_AMP, W3_FREQ, W3_SPD, uv);
    vec3 r4 = evalWave(W4_DIR, W4_AMP, W4_FREQ, W4_SPD, uv);

    float dispY = r1.x + r2.x + r3.x + r4.x;
    float dX    = r1.y + r2.y + r3.y + r4.y;
    float dZ    = r1.z + r2.z + r3.z + r4.z;

    // Analytic surface normal (world-up frame): N = normalize(-dX, 1, -dZ)
    // Scale gradient down to keep normal in sane range for a gentle swell.
    vWaveNormal = normalize(vec3(-dX * 0.18, 1.0, -dZ * 0.18));

    vec3 displaced = position;
    displaced.y += dispY;
    vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const _waterFrag = /* glsl */`
  uniform float uTime;
  uniform vec3  uColorDeep;
  uniform vec3  uColorShallow;
  uniform vec3  uColorFoam;
  uniform vec3  uColorSkyRefl;
  uniform vec3  uSunDir;
  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vWaveNormal;

  // ── 2D simplex noise (Ashima Arts / open-domain) ──────────────────────────
  vec3 _m3(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec2 _m2(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec3 _pm(vec3 x){return _m3(((x*34.0)+1.0)*x);}
  float snoise(vec2 v){
    const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
    vec2 i=floor(v+dot(v,C.yy));
    vec2 x0=v-i+dot(i,C.xx);
    vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
    vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
    i=_m2(i);
    vec3 p=_pm(_pm(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
    vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
    m=m*m; m=m*m;
    vec3 x=2.0*fract(p*C.www)-1.0;
    vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
    m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
    vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
    return 130.0*dot(m,g);
  }
  // ──────────────────────────────────────────────────────────────────────────

  void main() {
    // ─── 1. Depth gradient — deep blue channel → bright turquoise banks ────
    // min(uv.x, 1-uv.x): 0 at both banks, 0.5 at channel center.
    float edgeDist   = min(vUv.x, 1.0 - vUv.x);
    float depth      = smoothstep(0.0, 0.28, edgeDist);
    // Slight refraction wiggle — makes it feel like looking through water.
    float wiggle     = sin(uTime * 0.5 + vWorldPos.z * 0.002) * 0.04;
    float depthW     = clamp(depth + wiggle, 0.0, 1.0);
    vec3  base       = mix(uColorShallow, uColorDeep, depthW);

    // ─── 2. Flow noise — two UV-scrolled layers (scale 12/8 — safe from altitude)
    // UV.y scrolls in -direction = downstream flow (track runs in +UV.y direction
    // so negative scroll = water flows toward viewer / downstream the track).
    vec2 s1 = vUv + vec2(0.0, -uTime * 0.055);
    vec2 s2 = vUv + vec2(0.0, -uTime * 0.095) + vec2(17.3, 4.1);
    float n1 = snoise(s1 * 12.0) * 0.5 + 0.5;
    float n2 = snoise(s2 *  8.0) * 0.5 + 0.5;
    float flow = n1 * 0.6 + n2 * 0.4;

    // ─── 3. Crest foam — from wave noise peaks + organic cluster modulation ─
    // softField × clusterMod pattern (documented organic-foam-cluster technique):
    // wide smoothstep (no harsh PS2 stripes) × fine-scale modulator.
    float softField  = smoothstep(0.42, 0.80, flow);
    // clusterMod at scale 24: proven safe from altitude, adds organic patches.
    float clusterMod = mix(0.5, 1.0, snoise(vUv * 24.0 + vec2(0.0, uTime * 0.014)) * 0.5 + 0.5);
    // Normal-derived crest: where wave crests tip (1 - N.y is highest at peaks).
    float normalCrest = clamp(1.0 - vWaveNormal.y, 0.0, 1.0);
    // Combine: noise-driven foam + normal-derived crest peak emphasis.
    float whiteCap   = softField * clusterMod * 0.72 + normalCrest * 0.28;
    base = mix(base, uColorFoam, clamp(whiteCap, 0.0, 1.0));

    // ─── 4. Fresnel sky reflection ─────────────────────────────────────────
    // F = F0 + (1-F0)*(1-NdotV)^5. Uses analytic wave normal (from vertex).
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float NdotV  = max(dot(vWaveNormal, viewDir), 0.0);
    float F0     = 0.02;
    float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
    // Sky reflection: blend in the sky color at grazing angles.
    // Weight kept tasteful (0.35 max) — it's a surf channel, not a mirror.
    base = mix(base, uColorSkyRefl, fresnel * 0.35 * depth);

    // ─── 5. Specular glint — dusk warm sun, riding analytic wave crests ────
    // sunDir pointed toward/above the chase camera (-Z side, above horizon).
    // Analytic normal means glint moves across crest profiles, not flat.
    vec3 reflected = reflect(-uSunDir, vWaveNormal);
    float spec     = pow(max(dot(reflected, viewDir), 0.0), 90.0);
    // Warm dusk tint, strongest at channel center (depth).
    base += vec3(1.0, 0.88, 0.62) * spec * 0.55 * depth;

    // ─── 6. Bank spray — pulsing white foam at the waterline edges ─────────
    // (replaces the cosmic violet rim — reads as actual water meeting a bank)
    float bankFactor = 1.0 - smoothstep(0.0, 0.065, edgeDist);
    // Pulse varies along the track length (sin on vWorldPos.z) + with time.
    float bankPulse  = 0.65 + 0.35 * sin(uTime * 1.8 + vWorldPos.z * 0.009);
    float bankFoam   = bankFactor * bankPulse;
    base = mix(base, uColorFoam, bankFoam * 0.78);

    // ─── 7. Current streaks — very subtle downstream flow lines ───────────
    // Low scales in both axes (x=5, y=1.8) for broad readable streaks, even
    // from altitude (scale 5 = 5 cycles across width — well within safe range).
    float streak = snoise(vec2(vUv.x * 5.0, vUv.y * 1.8 - uTime * 0.13)) * 0.5 + 0.5;
    float streakLine = smoothstep(0.72, 0.76, streak) * 0.14;
    base += vec3(0.8, 0.95, 1.0) * streakLine * (1.0 - bankFactor * 0.6);

    gl_FragColor = vec4(base, 1.0);
  }
`;

export const SurfWaterMaterial = shaderMaterial(
  {
    uTime:        0,
    // Real surf water palette — dusk gorge canyon river:
    // Deep channel: rich blue-teal (looks deep & cold in the center)
    uColorDeep:   new THREE.Color('#0a5c8f'),
    // Shallow banks: bright turquoise (sunlit, energy, carveable feel)
    uColorShallow: new THREE.Color('#3ac8d8'),
    // Foam: near-white with very faint blue tint (salt water foam)
    uColorFoam:   new THREE.Color('#e2f7ff'),
    // Sky reflection: warm dusk amber-purple (matches the CosmicVoid gorge palette)
    uColorSkyRefl: new THREE.Color('#7a5a8a'),
    // Sun direction: from upper-left toward chase cam (-Z direction, above horizon).
    // Normalized: slightly left, high, facing the camera.
    uSunDir:      new THREE.Vector3(-0.28, 0.87, -0.41),
  },
  _waterVert,
  _waterFrag,
);
extend({ SurfWaterMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements {
    surfWaterMaterial: ThreeElements['shaderMaterial'] & {
      uTime?: number;
      uColorDeep?: THREE.Color;
      uColorShallow?: THREE.Color;
      uColorFoam?: THREE.Color;
      uColorSkyRefl?: THREE.Color;
      uSunDir?: THREE.Vector3;
    };
  }
}

// ─── Geometry builders ─────────────────────────────────────────────────────────

/** Water surface ribbon — lifted + banked, UV.x lateral (0=left,1=right), UV.y arclength. */
function buildWaterGeo(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[]   = [];
  const uvs: number[]       = [];
  const indices: number[]   = [];

  for (let i = 0; i < RIBBON_SAMPLES; i++) {
    const t = i / RIBBON_SAMPLES;
    const f = frameAt(t);
    positions.push(f.lx, f.ly, f.lz);
    normals.push(0, 1, 0);
    uvs.push(0, t);
    positions.push(f.rx, f.ry, f.rz);
    normals.push(0, 1, 0);
    uvs.push(1, t);

    const base  = i * 2;
    const nextL = (i + 1 < RIBBON_SAMPLES) ? base + 2 : 0;
    const nextR = (i + 1 < RIBBON_SAMPLES) ? base + 3 : 1;
    indices.push(base, base + 1, nextL);
    indices.push(base + 1, nextR, nextL);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build the subtle edge rail along one side (side=+1 left, -1 right).
 * Deliberately small dimensions so it reads as a waterline definition band,
 * NOT a dominant glowing tube. Height 10wu, thickness 7wu.
 */
function buildRailGeo(side: 1 | -1): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[]   = [];

  for (let i = 0; i < RIBBON_SAMPLES; i++) {
    const t = i / RIBBON_SAMPLES;
    const f = frameAt(t);
    const ex = side === 1 ? f.lx : f.rx;
    const ey = side === 1 ? f.ly : f.ry;
    const ez = side === 1 ? f.lz : f.rz;
    const ox = f.unx * RAIL_THICKNESS * side;
    const oy = f.uny * RAIL_THICKNESS * side;
    const oz = f.unz * RAIL_THICKNESS * side;

    positions.push(ex,       ey,                ez);
    positions.push(ex,       ey + RAIL_HEIGHT,  ez);
    positions.push(ex + ox,  ey + oy,           ez + oz);
    positions.push(ex + ox,  ey + oy + RAIL_HEIGHT, ez + oz);

    const base = i * 4;
    const next = (i + 1 < RIBBON_SAMPLES) ? base + 4 : 0;
    indices.push(base + 0, base + 1, next + 0);
    indices.push(base + 1, next + 1, next + 0);
    indices.push(base + 1, base + 3, next + 1);
    indices.push(base + 3, next + 3, next + 1);
    indices.push(base + 2, next + 2, base + 3);
    indices.push(base + 3, next + 2, next + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build a thin glowing crest strip just inside each rail — the waterline glow.
 * Width 18wu (was 34), sits above the water surface to avoid z-fighting.
 */
function buildCrestGeo(side: 1 | -1): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[]   = [];

  for (let i = 0; i < RIBBON_SAMPLES; i++) {
    const t = i / RIBBON_SAMPLES;
    const f = frameAt(t);
    const ex = side === 1 ? f.lx : f.rx;
    const ey = side === 1 ? f.ly : f.ry;
    const ez = side === 1 ? f.lz : f.rz;
    const ix = -f.unx * CREST_WIDTH * side;
    const iy = -f.uny * CREST_WIDTH * side;
    const iz = -f.unz * CREST_WIDTH * side;
    const lift = 1.2;

    positions.push(ex,       ey + lift,       ez);
    positions.push(ex + ix,  ey + iy + lift,  ez + iz);

    const base = i * 2;
    const next = (i + 1 < RIBBON_SAMPLES) ? base + 2 : 0;
    indices.push(base, base + 1, next);
    indices.push(base + 1, next + 1, next);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ─── Module-scope baked geometry ──────────────────────────────────────────────
const _waterGeo = buildWaterGeo();

const _railLeft   = buildRailGeo(1);
const _railRight  = buildRailGeo(-1);
const _crestLeft  = buildCrestGeo(1);
const _crestRight = buildCrestGeo(-1);
const _railsGeo = mergeGeometries([_railLeft, _railRight, _crestLeft, _crestRight], false)!;
_railLeft.dispose(); _railRight.dispose(); _crestLeft.dispose(); _crestRight.dispose();

// Rail material — softer warm-white glow (was cyan #7af6ff at full brightness).
// Dims down from the previous dominant neon so the water surface reads first.
// Still toneMapped:false so the bloom catches the edge definition for crispness.
const _railMat = new THREE.MeshBasicMaterial({
  color: '#98f0ff',    // slightly warmer, less aggressively cyan than #7af6ff
  side:  THREE.DoubleSide,
  fog:   false,
  toneMapped: false,   // bloom target — keeps the edge crisp in the dusk gorge
});

// ─── SurfRibbon component ─────────────────────────────────────────────────────

/**
 * SurfRibbon — the surf water ribbon + subtle neon edge rails + waterline glow.
 * The WATER is the hero. Rails are edge definition only.
 * Mount inside the scene's track group. Geometry is in absolute world XZ + the
 * shared elevation Y — parent track group must be at Y=0 (elevation is the datum).
 */
export function SurfRibbon() {
  const matRef = useRef<InstanceType<typeof SurfWaterMaterial>>(null);

  useFrame((state) => {
    if (matRef.current) matRef.current.uTime = state.clock.elapsedTime;
  });

  return (
    <group>
      {/* Premium surf water surface — the hero. Rides elevation + bank. */}
      <mesh geometry={_waterGeo} frustumCulled={false} renderOrder={1}>
        <surfWaterMaterial
          ref={matRef}
          side={THREE.DoubleSide}
          fog={false}
          key={SurfWaterMaterial.key}
        />
      </mesh>

      {/* Subtle neon edge rails + waterline glow strip (merged, bloom target).
          Kept small so they define the track edge without dominating the water. */}
      <mesh
        geometry={_railsGeo}
        material={_railMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        renderOrder={2}
      />
    </group>
  );
}
