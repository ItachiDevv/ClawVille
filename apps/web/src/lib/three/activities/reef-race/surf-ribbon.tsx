'use client';

/**
 * surf-ribbon.tsx — THE WATER SURFACE: a premium surfable ocean-swell river
 * ribbon winding through the canyon-river gorge.
 *
 * This is the HERO ASSET. The geometry is a DENSE GRID swept along the shared
 * `clientSpline`, LIFTED + BANKED by `elevationAtT` + `bankAngleAtT` (the parity
 * contract with the rider, camera, karts, etc.). A stacked GERSTNER / trochoidal
 * wave model gives it genuine surfable swell with VOLUME — sharp pinched crests,
 * broad rounded troughs, real world-space heave — not flat interpolated planes.
 *
 * ─── Why the rewrite (the "flat planes" root cause) ──────────────────────────
 * The old water emitted ONLY 2 vertices per cross-section (left edge + right
 * edge) across a river that is now 1476–2077wu WIDE. With no interior vertices
 * across the width, vertex displacement only moved the two bank verts — the
 * entire mid-channel was ONE flat interpolated triangle pair. There was no mesh
 * resolution for crests/troughs to form on, and the amplitude (≤4wu summed) was
 * invisible on a ~2000wu river. FIX: a real WIDTH_SEGS × RIBBON_SAMPLES grid +
 * a real Gerstner model with tens-of-wu heave.
 *
 * Three merged layers:
 *   1. WATER SURFACE — Gerstner-displaced grid (ShaderMaterial on a plain Mesh,
 *      Iris-Xe safe). Deep teal→bright turquoise depth gradient, multi-octave
 *      trochoidal swell with analytic Jacobian normals so specular glints +
 *      Fresnel ride the actual crests, Jacobian-derived whitecaps, bank spray,
 *      downstream current streaks.
 *   2. NEON RAILS — thin edge-definition bands along each banked edge. Kept
 *      SUBTLE so the WATER is the star. MeshBasicMaterial toneMapped:false
 *      (bloom target). They read frameAt's l/r edge directly, which IS the
 *      static banked datum the water edge taper pins to — so they stay aligned.
 *   3. CREST CAPS — thin bright inner waterline strip merged with rails.
 *
 * ─── WATERTIGHT CONTRACT with canyon-river.tsx ───────────────────────────────
 * The wave displacement is TAPERED to zero within `WATER_EDGE_TAPER` of each
 * bank, so the OUTER edge vertices (u=0, u=1) sit EXACTLY on the static banked
 * datum point `(cx ± unx·hw, y ± uny·hw, cz ± unz·hw)` — the same line the
 * canyon inner base (v0) shares. The waves heave at full amplitude across the
 * open channel; they just pin to the datum where they meet the rock. The canyon
 * then drops `WATER_SEAL_DROP` below that shared point for a submerged lip.
 * Both constants come from `surf-cross-section.ts` so the two files can't drift.
 *
 * Iris Xe invariants:
 *   - ShaderMaterial ONLY on the plain water Mesh (not InstancedMesh).
 *   - fog:false on ShaderMaterial (scene.fog uniforms not merged → throw every frame).
 *   - import from 'three' (NOT 'three/webgpu').
 *   - NO drei <Text>/<Billboard>.
 *   - Module-scope geo/mat built ONCE. ONE uniform write per frame. ZERO per-frame allocs.
 *   - frustumCulled=false (vertex heave + large swept bounds make bind-pose bbox stale).
 *   - The heavy Gerstner SUM runs in the VERTEX shader (per-vertex, cheap). Only
 *     lighting / foam / fresnel run in the fragment shader. Wave-derived varyings
 *     (normal, foam factor, depth, world pos) are passed down.
 *   - Simplex noise (fragment foam modulation) scale capped ≤24 (higher aliases
 *     to grey from altitude). Gerstner sin/cos waves are scale-immune — the swell
 *     volume comes from THOSE, not noise.
 *
 * Draw calls: 1 water + 1 rails (merged L+R+crests) = 2.
 * Tris: water WIDTH_SEGS×RIBBON_SAMPLES×2 = 28×224×2 ≈ 12,544 ; rails ~128×4
 *   sides×2 ≈ 1024 → ~13.6k total. Sane for Iris Xe (bounded swept ribbon).
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { shaderMaterial } from '@react-three/drei';
import { extend } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { clientSpline } from './reef-race-spline-instance';
import { elevationAtT, bankAngleAtT } from './reef-race-elevation';
import { WATER_EDGE_TAPER } from './surf-cross-section';

// ─── Geometry constants ───────────────────────────────────────────────────────
// Longitudinal rows: enough that lengthwise crests read smooth over the ~88k-wu
// loop. 224 rows → ~393wu spacing; the Gerstner crests are >800wu wavelength so
// they sample cleanly.
const RIBBON_SAMPLES = 224;
// Lateral interior columns across the channel (left→right). 28 columns over a
// ~2000wu width → ~71wu spacing, fine enough for crest form to read as 3D across
// the width. WIDTH_SEGS columns ⇒ WIDTH_SEGS+1 vertices per row.
const WIDTH_SEGS = 28;

// Rails kept SMALL so they read as edge-definition, not dominant neon bands.
const RAIL_HEIGHT     = 10;   // neon rail height
const RAIL_THICKNESS  = 7;    // rail width outward from edge
const CREST_WIDTH     = 18;   // inner glowing waterline strip width

// ─── Local-frame helper: lifted + banked left/right edge points at t ─────────
// The edge points are the static banked DATUM the canyon shares. Interior grid
// verts are linearly interpolated between l and r by lateral fraction u∈[0,1].
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

  // Banked lateral unit vector (n̂ rolled about the tangent axis).
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
// VERTEX: stacked GERSTNER / trochoidal wave model evaluated in WORLD XZ space
// (real-world wavelengths, so crests have true 3D form across the wide channel).
// Each Gerstner wave displaces the vertex in 3D (horizontal pinch toward crests +
// vertical heave) — that is the defining trochoidal shape (crests pinch sharp,
// troughs broaden). The phase advances DOWNSTREAM with time (along UV.y) so the
// swell flows down the river. We accumulate the analytic Jacobian (∂P/∂x, ∂P/∂z)
// from the SAME wave derivatives → exact surface normal + a crest-compression
// foam factor, both passed to the fragment shader as varyings.
//
// EDGE TAPER (watertight): the ENTIRE wave contribution (both the horizontal
// Gerstner pinch AND the vertical heave) is multiplied by an edge mask that goes
// to 0 within WATER_EDGE_TAPER of each bank, so the u=0 / u=1 edge verts are
// pinned UNMOVED on the static banked datum the canyon meets.
const _waterVert = /* glsl */`
  uniform float uTime;
  uniform float uEdgeTaper;   // WATER_EDGE_TAPER (lateral band, UV.x units)

  varying vec2  vUv;
  varying vec3  vWorldPos;
  varying vec3  vWaveNormal;  // analytic Gerstner surface normal (world)
  varying float vFoam;        // Jacobian-compression foam factor [0..1]
  varying float vDepthMask;   // edge taper mask (1 open channel, 0 at bank)

  // ── Gerstner wave bank (BAKED const arrays) ─────────────────────────────────
  // Each wave: world-space direction D (xz, UNIT), wavelength L, steepness Q
  // (normalized below to avoid looping/cusps), amplitude A (wu), speed S.
  // Larger amplitudes on the long swells (real surfable heave on a ~2000wu
  // river); shorter choppy octaves layered on top. Directions varied so the
  // surface is alive, not a single rolling sheet. A fixed WORLD direction reads
  // as a varied heading relative to the curving channel — exactly the alive look.
  //
  // 6 octaves. Wavelengths chosen so 224 longitudinal rows (~393wu spacing) and
  // 28 lateral columns (~71wu spacing) both sample the crests well (shortest
  // L≈240wu still reads as form).
  //
  // PERF: the wave parameters are COMPILE-TIME CONSTANTS, so they live in const
  // arrays baked into the shader — NOT non-const arrays repopulated on every
  // vertex invocation. The directions are HAND-NORMALIZED to unit length and
  // written as literals because GLSL ES 3.00 does not guarantee normalize() is
  // a const-expression usable in a const initializer. Source headings (pre-norm):
  // (0.30,1.00) (1.00,0.45) (-0.65,0.80) (0.85,-0.55) (0.20,1.00) (-0.90,0.35).
  //
  // We accumulate displacement (dispX/Y/Z) AND the analytic Jacobian partials
  // (∂P/∂x, ∂P/∂z) so the fragment shader gets an exact normal + crest foam.
  #define NWAVES 6.0
  const vec2 WDIR[6] = vec2[6](
    vec2( 0.287348,  0.957826),  // (0.30, 1.00) normalized
    vec2( 0.911922,  0.410365),  // (1.00, 0.45) normalized
    vec2(-0.630593,  0.776114),  // (-0.65, 0.80) normalized
    vec2( 0.839570, -0.543251),  // (0.85, -0.55) normalized
    vec2( 0.196116,  0.980581),  // (0.20, 1.00) normalized
    vec2(-0.932005,  0.362446)   // (-0.90, 0.35) normalized
  );
  const float WLEN[6]   = float[6](1700.0, 1150.0, 760.0, 520.0, 360.0, 240.0);
  const float WSTEEP[6] = float[6](  0.85,   0.80,  0.75,  0.70,  0.55,  0.40);
  const float WAMP[6]   = float[6](  19.0,   12.0,   8.0,   4.8,   2.5,   1.3);
  const float WSPD[6]   = float[6]( 140.0,  115.0, 100.0,  88.0,  76.0,  64.0);

  void main() {
    vUv = uv;

    // Static banked datum point (position attribute holds the lifted+banked grid
    // vertex with NO wave). Edge taper mask: 1 across the open channel, → 0
    // within uEdgeTaper of either bank. smoothstep gives a gentle pin (no crease).
    float edgeDist = min(uv.x, 1.0 - uv.x);          // 0 at banks, 0.5 at center
    float mask     = smoothstep(0.0, uEdgeTaper, edgeDist);
    vDepthMask = mask;

    vec3 base = position;          // lifted + banked datum vertex (un-waved)

    // Gerstner accumulation in world XZ. Horizontal displacement (the pinch) is
    // along each wave's direction; vertical is the heave.
    float dispX = 0.0;
    float dispY = 0.0;
    float dispZ = 0.0;

    // Jacobian terms: derivatives of (x+dispX, y+dispY, z+dispZ) wrt world x,z.
    // Start from identity for the horizontal partials (∂x/∂x=1, etc.).
    float dPx_dx = 1.0, dPx_dz = 0.0;   // ∂(displaced.x)/∂x , /∂z
    float dPz_dx = 0.0, dPz_dz = 1.0;   // ∂(displaced.z)/∂x , /∂z
    float dPy_dx = 0.0, dPy_dz = 0.0;   // ∂(displaced.y)/∂x , /∂z

    // 6 octaves over the baked const arrays. Math is byte-identical to the old
    // unrolled macro — D is pre-normalized so normalize() is gone, nothing else
    // changes. Constant trip count + constant array indices ⇒ fully unrollable on
    // every GLSL driver incl. Iris Xe.
    for (int k = 0; k < 6; k++) {
      vec2  D  = WDIR[k];
      float A  = WAMP[k];
      float w  = 6.28318530718 / WLEN[k];
      float Q  = WSTEEP[k] / (w * A * NWAVES);
      float ph = w * dot(D, base.xz) + WSPD[k] * w * uTime;
      float cc = cos(ph);
      float ss = sin(ph);
      dispX += Q * A * D.x * cc;
      dispZ += Q * A * D.y * cc;
      dispY += A * ss;
      float WA  = w * A;
      float QWA = Q * WA;
      dPx_dx += -QWA * D.x * D.x * ss;
      dPx_dz += -QWA * D.x * D.y * ss;
      dPz_dx += -QWA * D.y * D.x * ss;
      dPz_dz += -QWA * D.y * D.y * ss;
      dPy_dx +=  WA  * D.x * cc;
      dPy_dz +=  WA  * D.y * cc;
    }

    // Apply the edge taper to the WHOLE wave contribution (horizontal + vertical),
    // so the bank edge verts are pinned exactly on the datum. The Jacobian is
    // likewise scaled so the normal relaxes to flat-up at the pinned edge.
    dispX *= mask;
    dispY *= mask;
    dispZ *= mask;

    vec3 displaced = base + vec3(dispX, dispY, dispZ);

    // ── Analytic surface normal from the Gerstner Jacobian ──────────────────
    // Tangent along world-x:  Tx = (dPx_dx, dPy_dx, dPz_dx)
    // Tangent along world-z:  Tz = (dPx_dz, dPy_dz, dPz_dz)
    // N = normalize(cross(Tz, Tx)) → world-up-ish. Scale the wave portion of the
    // partials by mask too so the edge normal relaxes to (0,1,0).
    float m = mask;
    vec3 Tx = vec3(1.0 + (dPx_dx - 1.0) * m, dPy_dx * m, dPz_dx * m);
    vec3 Tz = vec3(dPx_dz * m, dPy_dz * m, 1.0 + (dPz_dz - 1.0) * m);
    vec3 N  = normalize(cross(Tz, Tx));
    if (N.y < 0.0) N = -N;        // keep facing up
    vWaveNormal = N;

    // ── Jacobian-compression foam factor ────────────────────────────────────
    // The horizontal Jacobian determinant J = (∂Px/∂x)(∂Pz/∂z) - (∂Px/∂z)(∂Pz/∂x).
    // J < 1 means the surface is COMPRESSED (water piling up at a crest) → foam.
    // J → 0 (or negative) is the near-breaking pinch. Map (1 - J) to foam.
    float Jx_x = 1.0 + (dPx_dx - 1.0) * m;
    float Jz_z = 1.0 + (dPz_dz - 1.0) * m;
    float Jx_z = dPx_dz * m;
    float Jz_x = dPz_dx * m;
    float J    = Jx_x * Jz_z - Jx_z * Jz_x;
    vFoam = clamp(1.0 - J, 0.0, 1.0);

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
  varying float vFoam;
  varying float vDepthMask;

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
    float edgeDist   = min(vUv.x, 1.0 - vUv.x);
    float depth      = smoothstep(0.0, 0.28, edgeDist);
    float wiggle     = sin(uTime * 0.5 + vWorldPos.z * 0.002) * 0.04;
    float depthW     = clamp(depth + wiggle, 0.0, 1.0);
    vec3  base       = mix(uColorShallow, uColorDeep, depthW);

    // ─── 2. Flow noise — two UV-scrolled layers (scale 12/8 — safe from altitude)
    vec2 s1 = vUv + vec2(0.0, -uTime * 0.055);
    vec2 s2 = vUv + vec2(0.0, -uTime * 0.095) + vec2(17.3, 4.1);
    float n1 = snoise(s1 * 12.0) * 0.5 + 0.5;
    float n2 = snoise(s2 *  8.0) * 0.5 + 0.5;
    float flow = n1 * 0.6 + n2 * 0.4;

    // ─── 3. Whitecaps — Jacobian crest compression × organic cluster ───────
    // Tighter threshold: only the sharpest crest pinches get foam (tips, not
    // broad foam blobs). The organic cluster modulates into alive patches.
    float crestFoam  = smoothstep(0.58, 0.92, vFoam);  // tighter: only real tips
    float softField  = smoothstep(0.55, 0.88, flow);
    float clusterMod = mix(0.55, 1.0, snoise(vUv * 24.0 + vec2(0.0, uTime * 0.018)) * 0.5 + 0.5);
    // Normal-tipping crest emphasis (1 - N.y peaks where the wave tilts hardest).
    float normalCrest = clamp((1.0 - vWaveNormal.y) * 3.0, 0.0, 1.0);
    float whiteCap   = clamp(crestFoam * clusterMod * 0.55   // reduced from 0.85
                             + normalCrest * softField * 0.28, 0.0, 1.0);  // reduced from 0.45
    // Whitecaps only in the open channel (taper to 0 at the pinned banks).
    whiteCap *= vDepthMask;
    base = mix(base, uColorFoam, whiteCap);

    // ─── 4. Fresnel sky reflection (analytic Gerstner normal) ──────────────
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float NdotV  = max(dot(vWaveNormal, viewDir), 0.0);
    float F0     = 0.02;
    float fresnel = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
    base = mix(base, uColorSkyRefl, fresnel * 0.20 * depth);  // reduced from 0.35 — less glow

    // ─── 5. Specular glint — dusk warm sun, riding the Gerstner crests ─────
    vec3 reflected = reflect(-uSunDir, vWaveNormal);
    float spec     = pow(max(dot(reflected, viewDir), 0.0), 90.0);
    base += vec3(1.0, 0.88, 0.62) * spec * 0.6 * depth;

    // ─── 6. Bank spray — thin wisp of foam at the waterline edges only ─────
    // Reduced significantly: was 78% blend giving solid white icing at the
    // banks; now a subtle 28% wisp — just enough to mark the water's edge.
    float bankFactor = 1.0 - smoothstep(0.0, 0.045, edgeDist);  // narrower band
    float bankPulse  = 0.55 + 0.25 * sin(uTime * 1.8 + vWorldPos.z * 0.009);  // less range
    float bankFoam   = bankFactor * bankPulse;
    base = mix(base, uColorFoam, bankFoam * 0.28);  // reduced from 0.78

    // ─── 7. Current streaks — very subtle downstream flow lines ───────────
    float streak = snoise(vec2(vUv.x * 5.0, vUv.y * 1.8 - uTime * 0.13)) * 0.5 + 0.5;
    float streakLine = smoothstep(0.72, 0.76, streak) * 0.14;
    base += vec3(0.8, 0.95, 1.0) * streakLine * (1.0 - bankFactor * 0.6);

    gl_FragColor = vec4(base, 1.0);
  }
`;

export const SurfWaterMaterial = shaderMaterial(
  {
    uTime:        0,
    uEdgeTaper:   WATER_EDGE_TAPER,
    // Deepened surf water palette — richly WET, not luminous:
    // - Deep channel: darker, richer navy-teal (was #0a5c8f — too bright/luminous)
    // - Shallow: deeper teal, less neon-turquoise (was #3ac8d8 — screamed glowing ice)
    // - Foam: softer off-white, less blown out (was #e2f7ff — too pure white)
    // - SkyRefl: kept warm dusk but slightly warmer (less bluing the water body)
    // All values chosen to stay BELOW bloom threshold 0.80 so the water body
    // does not glow; the neon rails (#98f0ff ≈ 0.93) remain the bloom targets.
    uColorDeep:    new THREE.Color('#052d4a'),  // deep navy — dark troughs read clearly
    uColorShallow: new THREE.Color('#0e7a8a'),  // teal, enriched — wet not neon
    uColorFoam:    new THREE.Color('#b8dfe8'),  // soft blue-white — foam not cotton
    uColorSkyRefl: new THREE.Color('#6a4878'),  // warm dusk purple sheen
    uSunDir:       new THREE.Vector3(-0.28, 0.87, -0.41),
  },
  _waterVert,
  _waterFrag,
);
extend({ SurfWaterMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements {
    surfWaterMaterial: ThreeElements['shaderMaterial'] & {
      uTime?: number;
      uEdgeTaper?: number;
      uColorDeep?: THREE.Color;
      uColorShallow?: THREE.Color;
      uColorFoam?: THREE.Color;
      uColorSkyRefl?: THREE.Color;
      uSunDir?: THREE.Vector3;
    };
  }
}

// ─── Geometry builders ─────────────────────────────────────────────────────────

/**
 * Water surface ribbon — a DENSE GRID swept along the spline.
 *   - WIDTH_SEGS+1 interior columns across the channel (left→right), each base
 *     XYZ linearly interpolated between the banked left edge (l) and right edge
 *     (r) by lateral fraction u∈[0,1]. UV.x=u, UV.y=t.
 *   - RIBBON_SAMPLES longitudinal rows, closed-loop wrapped (row N-1 → row 0).
 *
 * The position attribute holds the STATIC lifted+banked datum vertex (no wave);
 * the vertex shader adds the Gerstner displacement, tapered to 0 at u=0 / u=1.
 */
function buildWaterGeo(): THREE.BufferGeometry {
  const cols = WIDTH_SEGS + 1;
  const positions: number[] = [];
  const normals: number[]   = [];
  const uvs: number[]       = [];
  const indices: number[]   = [];

  for (let i = 0; i < RIBBON_SAMPLES; i++) {
    const t = i / RIBBON_SAMPLES;
    const f = frameAt(t);
    for (let j = 0; j < cols; j++) {
      const u = j / WIDTH_SEGS;               // 0=left edge, 1=right edge
      // Linear interp between banked left and right edge points.
      const px = f.lx + (f.rx - f.lx) * u;
      const py = f.ly + (f.ry - f.ly) * u;
      const pz = f.lz + (f.rz - f.lz) * u;
      positions.push(px, py, pz);
      normals.push(0, 1, 0);
      uvs.push(u, t);
    }
  }

  // Closed-loop grid indices: row i → row (i+1)%RIBBON_SAMPLES, col j → j+1.
  for (let i = 0; i < RIBBON_SAMPLES; i++) {
    const nextI = (i + 1) % RIBBON_SAMPLES;
    const rowA  = i      * cols;
    const rowB  = nextI  * cols;
    for (let j = 0; j < WIDTH_SEGS; j++) {
      const a = rowA + j;
      const b = rowA + j + 1;
      const c = rowB + j;
      const d = rowB + j + 1;
      // +Y normal winding (CCW seen from above).
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  // Base normals are placeholder +Y (the shader computes the live wave normal);
  // computeVertexNormals gives a sane static fallback for any non-shader pass.
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build the subtle edge rail along one side (side=+1 left, -1 right).
 * Reads frameAt's l/r edge — which IS the static banked datum the water edge
 * tapers to — so the rail stays glued to the (now-tapered) waterline.
 * Height 10wu, thickness 7wu.
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
 * Width 18wu, sits 1.2wu above the datum to avoid z-fighting. Because the water
 * is pinned to the datum at the edge, this strip overlays the tapered waterline.
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

// Rail material — softer warm-white glow. toneMapped:false so bloom catches the
// edge definition for crispness in the dusk gorge.
const _railMat = new THREE.MeshBasicMaterial({
  color: '#98f0ff',
  side:  THREE.DoubleSide,
  fog:   false,
  toneMapped: false,
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
      {/* Premium surf water surface — the hero. Rides elevation + bank, heaves
          with the Gerstner swell, pins to the datum at the banks. */}
      <mesh geometry={_waterGeo} frustumCulled={false} renderOrder={1}>
        <surfWaterMaterial
          ref={matRef}
          side={THREE.DoubleSide}
          fog={false}
          key={SurfWaterMaterial.key}
        />
      </mesh>

      {/* Subtle neon edge rails + waterline glow strip (merged, bloom target). */}
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
