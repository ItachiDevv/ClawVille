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
 * Tris: water WIDTH_SEGS×RIBBON_SAMPLES×2 = 48×320×2 ≈ 30,720 ; rails ~128×4
 *   sides×2 ≈ 1024 → ~31.7k total. Well within the scene's ≤220k tri budget
 *   (Iris Xe, bounded swept ribbon). The denser grid carries the swells +
 *   medium chop; the fragment-shader micro-normal bands carry the FINE detail
 *   with no extra tris (the flatness fix).
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
// PREMIUM REBUILD (2026-06-23): the v6 WIDE SURF ROAD made the channel 2287–
// 3219wu wide (numerically verified — the old "1476–2077" comment was stale).
// At the prior 28 cols the widest channel was 115wu/col, so the MEDIUM chop
// (L=360–520wu, ~3–4 samples) was Nyquist-marginal and the river read as flat
// low-poly mounds. We raise the mesh density so the swells + medium chop carry
// on real geometry, and the FRAGMENT shader adds derivative-attenuated micro-
// normal detail (scale-immune, zero extra tris) for the fine surface texture
// between crests — the single biggest flatness fix.
//
// Longitudinal rows: 320 over the ~88k-wu loop → ~275wu/row. Waves ≥ ~600wu
// sample cleanly lengthwise; the shorter octaves are carried by the micro-normal
// bands in the fragment shader, not the mesh.
const RIBBON_SAMPLES = 320;
// Lateral interior columns across the channel (left→right). 48 columns over the
// widest ~3219wu channel → ~67wu/col, so the medium chop (L≈360–520wu) now gets
// 5–8 samples across the width and reads as genuine 3D crest form, not a smooth
// interpolated sheet. WIDTH_SEGS columns ⇒ WIDTH_SEGS+1 vertices per row.
const WIDTH_SEGS = 48;

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
  // 7 octaves. Wavelengths chosen so 320 longitudinal rows (~275wu spacing) and
  // 48 lateral columns (~67wu spacing) both sample the swells + medium chop well.
  // The shortest mesh-carried octave is L≈300wu (~4.5 samples/col) — the FINER
  // surface texture below that lives in the fragment-shader micro-normal bands,
  // which are scale-immune and cost no mesh resolution.
  //
  // PREMIUM tuning vs the old flat bank:
  //   - higher steepness on the LONG swells (Q→0.92) → genuinely SHARP pinched
  //     crests + broad troughs (the trochoidal silhouette that reads as surf),
  //     not gentle rolling mounds. Q is normalized below so it never self-loops.
  //   - a 7th broad-swell octave (L=2300) adds the slow heaving groundswell.
  //   - wider directional spread (headings fan ±, plus two near-cross headings)
  //     so the surface is a CHURNING interference field, not one rolling sheet.
  //   - bigger amplitudes on the swells (A up to 26wu) for real readable heave on
  //     the 2287–3219wu channel.
  //
  // PERF: the wave parameters are COMPILE-TIME CONSTANTS, so they live in const
  // arrays baked into the shader — NOT non-const arrays repopulated on every
  // vertex invocation. The directions are HAND-NORMALIZED to unit length and
  // written as literals because GLSL does not guarantee normalize() is
  // a const-expression usable in a const initializer. Source headings (pre-norm):
  // (0.25,1.00) (1.00,0.40) (-0.70,0.78) (0.90,-0.50) (0.15,1.00) (-0.95,0.32)
  // (0.60,0.62).
  //
  // We accumulate displacement (dispX/Y/Z) AND the analytic Jacobian partials
  // (∂P/∂x, ∂P/∂z) so the fragment shader gets an exact normal + crest foam.
  #define NWAVES 7.0
  const vec2 WDIR[7] = vec2[7](
    vec2( 0.242536,  0.970143),  // (0.25, 1.00) normalized — primary swell
    vec2( 0.928477,  0.371391),  // (1.00, 0.40) normalized — cross swell
    vec2(-0.668965,  0.743276),  // (-0.70, 0.78) normalized — opposing sweep
    vec2( 0.873704, -0.486502),  // (0.90, -0.50) normalized — chop
    vec2( 0.148556,  0.988899),  // (0.15, 1.00) normalized — down-river chop
    vec2(-0.947696,  0.319234),  // (-0.95, 0.32) normalized — fine ripple
    vec2( 0.695468,  0.718558)   // (0.60, 0.62) normalized — diagonal ripple
  );
  const float WLEN[7]   = float[7](2300.0, 1500.0, 980.0, 640.0, 460.0, 340.0, 300.0);
  const float WSTEEP[7] = float[7](  0.92,   0.90,  0.86,  0.80,  0.66,  0.52,  0.42);
  // Amplitudes bumped on the swells so the peak-to-trough heave reads as REAL
  // surf (~185wu p2p, numerically verified) — the founder's "NOT flat" demand.
  // Q is normalized as STEEP/(w·A·N) so raising A keeps Q·k·A bounded (no cusp).
  // Round 2: amplitudes raised on the swells for TALLER rideable rolling waves
  // (~245wu p2p, up from ~185) — the founder's "bigger waves you'd carve". Q is
  // re-normalized per-octave below (STEEP/(w·A·N)) so raising A keeps the pinch
  // bounded (no cusps). Edges still pin to the datum (taper), so the canyon seam
  // is unaffected by the bigger heave.
  const float WAMP[7]   = float[7](  50.0,   33.0,  19.0,  10.0,   5.0,   2.6,   1.6);
  const float WSPD[7]   = float[7]( 150.0,  126.0, 108.0,  94.0,  82.0,  70.0,  62.0);

  void main() {
    vUv = uv;

    // Static banked datum point (position attribute holds the lifted+banked grid
    // vertex with NO wave). Edge taper mask: 1 across the open channel, → 0
    // within uEdgeTaper of either bank. smoothstep gives a gentle pin (no crease).
    float edgeDist = min(uv.x, 1.0 - uv.x);          // 0 at banks, 0.5 at center
    float mask     = smoothstep(0.0, uEdgeTaper, edgeDist);
    vDepthMask = mask;

    vec3 base = position;          // lifted + banked datum vertex (un-waved)

    // Round 2 — TRAVELING SET ENVELOPE: the two longest swells grow & fade in
    // slow groups (~8400wu wavelength) that roll DOWN-TRACK, so distinct "sets"
    // of bigger waves move through the channel instead of a uniform field. This
    // is a low-freq, large-scale HEAVE modulation (not a thin color stripe), and
    // because Q is re-normalized by the modulated A the horizontal pinch stays
    // constant — only the vertical heave swells & recedes. Applied to k<2 below.
    float setEnv = 0.72 + 0.28 * sin(dot(WDIR[0], base.xz) * 0.00075 - uTime * 0.6);

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

    // 7 octaves over the baked const arrays. D is pre-normalized so normalize()
    // is gone. Constant trip count + constant array indices ⇒ fully unrollable on
    // every GLSL driver incl. Iris Xe.
    for (int k = 0; k < 7; k++) {
      vec2  D  = WDIR[k];
      float A  = WAMP[k] * (k < 2 ? setEnv : 1.0);   // sets modulate the long swells
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

// FRAGMENT — premium analytic water optics (threejs-water-optics technique).
// The mesh + vertex Gerstner carry the SWELLS + medium chop. The fragment shader
// adds the FINE surface detail + the wet/reflective look that the old flat pass
// lacked:
//   A. DERIVATIVE-ATTENUATED MICRO-NORMAL BANDS — three high-frequency analytic
//      ripple gradients in world XZ, each attenuated by the on-screen texel
//      footprint (fwidth) so they add crisp sparkle up close and FADE before they
//      alias to grey at distance/altitude. This is scale-immune (no mesh cost,
//      no texture taps) and is THE flatness fix — the surface now reads as water
//      texture between the big crests instead of a smooth sheet.
//   B. ANALYTIC SKY REFLECTION — a dusk sky gradient + sun disc + sun halo
//      sampled along the reflected view ray, blended through side-aware Fresnel.
//      Makes the water look genuinely reflective/wet, not a flat tinted plane.
//   C. SIDE-AWARE FRESNEL + reflected-sun disc/halo glints riding the live
//      micro-detailed normal → sharp moving sparkles on the crests.
//   D. DEPTH TRANSLUCENCY — Beer-Lambert fallback absorption over an edge-derived
//      path length, so the deep channel reads richer/darker than the shallows.
//   E. ORGANIC WHITECAPS — Jacobian crest-compression × multi-octave hash FBM
//      turbulence field (world-XZ, animated, 3 octaves, NO periodic functions in
//      the foam path). Zero sine/cos in the foam or bank-spray path — every
//      modulation comes from hash-based value noise so the foam breaks into
//      IRREGULAR PATCHES, never lines of any orientation.
//   F. (round 2) CREST SPRAY — the sharpest breaking tips (high vFoam × dense
//      turbulence) throw spray brighter than foam, allowed to spike past the
//      bloom threshold so it catches light. + DRIFTING MIST: a faint veil over
//      the churned zones reusing the coarse foam hash (drifts with the surf).
//   G. (round 2) CAUSTICS — a ridged cosine product forming a cellular refracted-
//      light web, made APERIODIC by a hash-field DOMAIN WARP + incommensurate
//      per-layer frequencies (so it never reads as a regular grid) and pre-rotated
//      ~22° (no axis bias); footprint-AA'd, gated to the open channel.
// Round 2 also retunes the palette to a TROPICAL sunlit turquoise→deep-blue grade
// and raises the Gerstner swell amplitudes (+ a traveling "set" envelope) for
// taller rideable waves. The mesh/vertex Gerstner still carries the macro swell.
// All water-body colours stay BELOW the bloom threshold (0.80) so only the neon
// rails bloom; the sun-glint highlights are intentionally allowed to spike bright
// for sparkle but are tiny in area.
const _waterFrag = /* glsl */`
  uniform float uTime;
  uniform vec3  uColorDeep;
  uniform vec3  uColorShallow;
  uniform vec3  uColorFoam;
  uniform vec3  uSkyHorizon;
  uniform vec3  uSkyZenith;
  uniform vec3  uSunColor;
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

  // ── Analytic dusk sky sampled along a reflected ray (technique B) ──────────
  // A vertical gradient (horizon→zenith) + a tight sun disc + a broad sun halo,
  // exactly the cheap analytic-sky reflection the water-optics skill prescribes.
  // dir.y in [-1,1]; we only ever sample upward-ish reflected rays.
  vec3 skyColor(vec3 dir) {
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
    // Smooth horizon→zenith dusk ramp (gamma 1.4 keeps the horizon band wide).
    vec3 grad = mix(uSkyHorizon, uSkyZenith, pow(h, 1.4));
    float sunDot = clamp(dot(dir, uSunDir), 0.0, 1.0);
    // Tight disc (specular sun) + soft warm halo around it.
    grad += uSunColor * pow(sunDot, 900.0) * 6.0;   // crisp sun disc
    grad += uSunColor * pow(sunDot, 18.0)  * 0.35;  // warm halo
    return grad;
  }
  // ──────────────────────────────────────────────────────────────────────────

  void main() {
    float edgeDist = min(vUv.x, 1.0 - vUv.x);          // 0 at banks, 0.5 at center

    // ─── A. DERIVATIVE-ATTENUATED MICRO-NORMAL DETAIL (the flatness fix) ────
    // Three analytic high-frequency ripple bands in WORLD XZ, each a directional
    // cosine gradient. The on-screen texel footprint (fwidth of world XZ) gates
    // each band: when a band's wavelength is finer than the footprint can resolve
    // it is faded out BEFORE it aliases to grey sparkle. Up close all three fire
    // and the surface sparkles with fine chop; far away only the coarse band
    // survives. Scale-immune, zero mesh cost. The micro-detail is also tapered to
    // 0 at the banks (vDepthMask) so the pinned watertight seam stays flat.
    float footprint = max(length(fwidth(vWorldPos.xz)), 1e-3);
    // Band wavenumbers (2π/λ): λ ≈ 150, 78, 42 wu — the fine texture below the
    // mesh-carried octaves. Hand-normalized directions (no normalize() needed).
    const float MK1 = 0.041888;   // 2π/150
    const float MK2 = 0.080552;   // 2π/78
    const float MK3 = 0.149600;   // 2π/42
    const vec2  MD1 = vec2( 0.316228,  0.948683);  // (0.1,0.3) norm
    const vec2  MD2 = vec2( 0.857493, -0.514496);  // (0.5,-0.3) norm
    const vec2  MD3 = vec2(-0.554700,  0.832050);  // (-0.2,0.3) norm
    // Footprint AA weights — 1 when the band resolves, →0 when finer than a texel.
    float aa1 = 1.0 - smoothstep(0.0, 2.0, footprint * MK1);
    float aa2 = 1.0 - smoothstep(0.0, 1.6, footprint * MK2);
    float aa3 = 1.0 - smoothstep(0.0, 1.2, footprint * MK3);
    float p1 = dot(vWorldPos.xz, MD1) * MK1 + uTime * 1.30;
    float p2 = dot(vWorldPos.xz, MD2) * MK2 - uTime * 1.70;
    float p3 = dot(vWorldPos.xz, MD3) * MK3 + uTime * 2.20;
    // Gradient of the ripple heightfield → a horizontal slope perturbation.
    vec2 microGrad = vec2(0.0);
    microGrad += MD1 * (5.2 * MK1 * cos(p1) * aa1);
    microGrad += MD2 * (3.0 * MK2 * cos(p2) * aa2);
    microGrad += MD3 * (1.6 * MK3 * cos(p3) * aa3);
    microGrad *= vDepthMask;   // relax to flat at the pinned banks
    // Perturb the macro Gerstner normal by the micro slope (small tilt, no full
    // renormalize blow-up — clamp keeps it well-conditioned).
    vec3 N = normalize(vec3(
      vWaveNormal.x - microGrad.x,
      vWaveNormal.y,
      vWaveNormal.z - microGrad.y
    ));

    // ─── D. Depth translucency — deep channel darker, shallows brighter ────
    float depth   = smoothstep(0.0, 0.30, edgeDist);
    float wiggle  = sin(uTime * 0.5 + vWorldPos.z * 0.002) * 0.04;
    float depthW  = clamp(depth + wiggle, 0.0, 1.0);
    // Beer-Lambert fallback: more "water" between eye and bed in the deep channel.
    float pathLen = mix(0.4, 2.4, depthW);
    vec3  absorb  = exp(-vec3(0.32, 0.14, 0.07) * pathLen);
    vec3  body    = mix(uColorShallow, uColorDeep, depthW) * absorb;

    // ─── B+C. Side-aware Fresnel + analytic sky reflection + sun glints ────
    vec3  viewDir  = normalize(cameraPosition - vWorldPos);
    float NdotV    = max(dot(N, viewDir), 1e-4);
    float F0       = 0.02;
    float fresnel  = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
    vec3  reflDir  = reflect(-viewDir, N);
    if (reflDir.y < 0.0) reflDir.y = -reflDir.y;       // keep the reflection skyward
    vec3  reflection = skyColor(reflDir);
    // Reflected-sun disc + halo riding the live (micro-detailed) crest normal —
    // this is the moving sparkle that makes the surface read as wet & alive.
    // exponent 1400→380 widens the disc so it covers more crest normals and
    // reads as an actual visible sparkle (was a sub-pixel point at race altitude).
    float reflSun  = clamp(dot(reflDir, uSunDir), 0.0, 1.0);
    reflection += uSunColor * pow(reflSun, 380.0) * 14.0    // crisp glint — wider + brighter
                + uSunColor * pow(reflSun, 12.0)  * 1.1;    // soft warm halo around it
    // Energy-controlled blend: reflection grows with Fresnel, body fades with it.
    vec3 base = mix(body, reflection, fresnel * 0.85);

    // Direct Blinn specular on the crests — riding the MICRO-DETAILED normal so
    // it sparks on each ripple facet, not just the macro Gerstner shape.
    // exponent 200→70: wider cone = more fragments hit spec per crest = VISIBLE.
    // Removed the * depth suppression: depth kills spec at the banks exactly where
    // the micro-normal tilt is largest — we want those sparks.
    vec3  halfV = normalize(viewDir + uSunDir);
    float spec  = pow(max(dot(N, halfV), 0.0), 70.0);
    base += uSunColor * spec * 1.2;

    // ─── E. ORGANIC WHITECAPS ─────────────────────────────────────────────────
    // DESIGN: foam = where waves BREAK × turbulent noise.
    // Source 1 — crest compression: Jacobian det<1 means surface is folding.
    // Source 2 — multi-octave hash FBM turbulence (world-XZ, NO periodic functions).
    //
    // ZERO sine/cos in the foam path. Every modulation is a hash-based value noise
    // (fract-sin), so patches are genuinely aperiodic at ALL orientations/altitudes.
    //
    // Hash value-noise helper — smooth bilinear hash on a world-XZ grid.
    // latticeHash(p) returns [0,1] smoothly varying at GLSL compile-time constant cost.
    // Using 4 hash taps (lattice corners) + smoothstep-smoothed bilinear blend (Hermite).
    // This is cheap-hash value noise — NOT snoise (keeping snoise budget = 2 calls only).
    //   ≈ 28 ALU total for 3 octaves (vs 75 ALU for 3 snoise calls) — well within budget.
    //
    // hashVal: fract(sin(dot(cell,k))*N) — the standard fract-sin hash.
    // Each octave uses a different (k,N) pair so octaves are decorrelated.

    // Animated world-XZ position (drift speed per-octave so patches slowly evolve).
    vec2 wXZ0 = vWorldPos.xz + vec2(uTime * 2.1,  uTime * 1.3);   // slow drift oct 0
    vec2 wXZ1 = vWorldPos.xz + vec2(uTime * 3.7, -uTime * 2.2);   // mid-speed oct 1
    vec2 wXZ2 = vWorldPos.xz + vec2(-uTime * 1.5, uTime * 4.1);   // faster oct 2

    // Octave 0 — broad foam LANES (~720wu cells): ~4-5 soft blobs across the
    // 3219wu channel that read as "foam zones", not an 8-cell blocky patchwork.
    // 3da-adversary review flagged the prior 380wu (8.5 cells) as the founder's
    // "blockiness" at top-down/side-on far view. FIX: cell 380→720 (fewer/larger
    // soft blobs) AND a ~37° lattice ROTATION so the square value-noise grid yields
    // rhombus patches with NO horizontal/vertical bias (kills any residual axis-
    // aligned read from altitude). cos37≈0.7986, sin37≈0.6018 — hand-baked rotation
    // (no runtime trig). Only octave 0 is rotated; the finer octaves are already
    // small enough to read as texture, not grid.
    mat2  ROT0 = mat2(0.7986, -0.6018, 0.6018, 0.7986);
    vec2  p0 = (ROT0 * wXZ0) / 720.0;
    vec2  c0 = floor(p0);
    vec2  f0 = fract(p0);
    vec2  u0 = f0 * f0 * (3.0 - 2.0 * f0);  // Hermite smooth
    float h00 = fract(sin(dot(c0,              vec2(127.1, 311.7))) * 43758.5453);
    float h01 = fract(sin(dot(c0 + vec2(1,0), vec2(127.1, 311.7))) * 43758.5453);
    float h02 = fract(sin(dot(c0 + vec2(0,1), vec2(127.1, 311.7))) * 43758.5453);
    float h03 = fract(sin(dot(c0 + vec2(1,1), vec2(127.1, 311.7))) * 43758.5453);
    float v0  = mix(mix(h00, h01, u0.x), mix(h02, h03, u0.x), u0.y);

    // Octave 1 — medium patches (~160wu cells): irregular sub-blobs within the coarse.
    vec2  c1 = floor(wXZ1 / 160.0);
    vec2  f1 = fract(wXZ1 / 160.0);
    vec2  u1 = f1 * f1 * (3.0 - 2.0 * f1);
    float h10 = fract(sin(dot(c1,              vec2(269.5, 183.3))) * 53471.7921);
    float h11 = fract(sin(dot(c1 + vec2(1,0), vec2(269.5, 183.3))) * 53471.7921);
    float h12 = fract(sin(dot(c1 + vec2(0,1), vec2(269.5, 183.3))) * 53471.7921);
    float h13 = fract(sin(dot(c1 + vec2(1,1), vec2(269.5, 183.3))) * 53471.7921);
    float v1  = mix(mix(h10, h11, u1.x), mix(h12, h13, u1.x), u1.y);

    // Octave 2 — fine detail (~70wu cells): foam froth texture within each patch.
    vec2  c2 = floor(wXZ2 / 70.0);
    vec2  f2 = fract(wXZ2 / 70.0);
    vec2  u2 = f2 * f2 * (3.0 - 2.0 * f2);
    float h20 = fract(sin(dot(c2,              vec2(419.2,  371.9))) * 27383.6147);
    float h21 = fract(sin(dot(c2 + vec2(1,0), vec2(419.2,  371.9))) * 27383.6147);
    float h22 = fract(sin(dot(c2 + vec2(0,1), vec2(419.2,  371.9))) * 27383.6147);
    float h23 = fract(sin(dot(c2 + vec2(1,1), vec2(419.2,  371.9))) * 27383.6147);
    float v2  = mix(mix(h20, h21, u2.x), mix(h22, h23, u2.x), u2.y);

    // FBM composite — octaves summed with decreasing weight.
    // Result is [0,1] with organic irregular distribution (no periodic structure).
    float turbulence = v0 * 0.54 + v1 * 0.31 + v2 * 0.15;   // sums to 1.0 weights

    // Snoise 2-call whitecap field (same as before — these are the load-bearing
    // snoise budget; foam turbulence above is hash-only, costs no snoise budget).
    vec2 s1 = vUv + vec2(0.0, -uTime * 0.055);
    vec2 s2 = vUv + vec2(0.0, -uTime * 0.095) + vec2(17.3, 4.1);
    float n1 = snoise(s1 * 12.0) * 0.5 + 0.5;
    float n2 = snoise(s2 *  8.0) * 0.5 + 0.5;
    float snoiseField = n1 * 0.6 + n2 * 0.4;   // [0,1], UV-space, no UV-frequency stripe

    // Jacobian crest-compression signal: vFoam=(1-J) ranges from 0 (open trough)
    // → ~1 (near-breaking pinch). Gate foam at two thresholds:
    //   TIGHT: sharp crest-tip foam — requires HIGH Jacobian compression AND turbulence.
    //   MODERATE: scattered sea-foam patches — moderate compression + high turbulence.
    float crestTight   = smoothstep(0.58, 0.92, vFoam);             // sharp crest TIPS
    float crestModerate = smoothstep(0.30, 0.65, vFoam);            // broader compression zone
    float turbHigh      = smoothstep(0.55, 0.90, turbulence);       // only dense turbulence spots

    // Advected trailing foam: snoise field helps foam linger BEHIND a breaking crest
    // (looks like foam advected downstream by the wave). Soft, narrow coverage.
    float advectedFoam = smoothstep(0.64, 0.85, snoiseField) * crestModerate * 0.25;

    // Combined: crest tips × turbulence (the primary breaking foam)
    //           + scattered patches at moderate compression zones × dense turbulence
    //           + soft advected trailing foam
    // NOTE: the old (normalCrest * turbMedium) term was removed — normalCrest was derived
    // from N.y, which includes the cosine micro-normal bands; that leaked a periodic cosine
    // signal into the foam path, biasing whitecaps toward faint regular stripes. The foam
    // is now driven STRICTLY by Jacobian crest-compression × hash turbulence (zero periodic
    // sin/cos in the foam path). The micro-normal bands stay in the N/lighting path only.
    float whiteCap    = clamp(
        crestTight    * turbHigh   * 0.72    // primary: sharp crest + turbulent patch
      + crestModerate * turbHigh   * 0.30    // secondary: broader breaking zone × dense turb
      + advectedFoam,                        // trailing foam behind crests
      0.0, 1.0
    );
    whiteCap *= vDepthMask;                  // none at the pinned bank edges

    base = mix(base, uColorFoam, whiteCap);

    // ─── Round 2 · CREST SPRAY — luminous spray off the sharpest breaking tips ─
    // Only the highest crest-compression tips (vFoam → near-breaking) coinciding
    // with dense turbulence throw spray. Spray is brighter than foam and is
    // intentionally allowed to spike PAST the bloom threshold (like the sun
    // glints) so it CATCHES LIGHT — the surf signature. Steep smoothstep keeps the
    // area tiny, so it sparkles on the breaking peaks without washing the surface.
    float sprayMask = smoothstep(0.80, 0.97, vFoam) * turbHigh * vDepthMask;
    base = mix(base, uColorFoam * 1.4 + vec3(0.05), clamp(sprayMask, 0.0, 1.0));

    // ─── Round 2 · CAUSTICS — shimmering refracted-light web ──────────────────
    // Three RIDGED cosine layers form a web of bright nodes where the ridges
    // coincide (the classic caustic look). NAIVE hex ridges (even rotated) form a
    // REGULAR repeating lattice that can read as a grid from altitude — the
    // founder's cardinal sin (Codex review caught this). Two fixes make it
    // APERIODIC: (1) DOMAIN WARP — the sample point is displaced by the existing
    // smooth hash fields (v0,v1), which themselves drift in time, so the ridges
    // BEND organically and the web breathes/morphs; (2) INCOMMENSURATE per-layer
    // frequencies (×1.00 / ×1.17 / ×0.91) so the three lattices never align into a
    // clean repeat. Domain pre-rotated ~22° (no axis bias) + footprint-AA'd +
    // gated to the open channel, faded under foam. Reuses v0/v1 → zero new noise
    // taps; x*x*x instead of pow() (cheaper on the Iris Xe floor).
    {
      vec2  cp = mat2(0.927, 0.375, -0.375, 0.927) * vWorldPos.xz * 0.0125; // ~500wu cos period (~250wu visible ridge), 22° rot
      cp += (vec2(v0, v1) - 0.5) * 3.0;                                     // organic domain warp (≈±120wu)
      float cr0 = 1.0 - abs(cos((cp.x)                      * 1.00 + uTime * 0.9));
      float cr1 = 1.0 - abs(cos((cp.x * 0.5 + cp.y * 0.8660254) * 1.17 - uTime * 1.1));
      float cr2 = 1.0 - abs(cos((-cp.x * 0.5 + cp.y * 0.8660254) * 0.91 + uTime * 0.7));
      float prod = cr0 * cr1 * cr2;
      float caustic   = prod * prod * prod * (0.6 + 0.4 * v1);   // x^3 (multiply form, cheaper than pow)
      float causticAA = 1.0 - smoothstep(0.0, 2.0, footprint * 0.0125);
      caustic *= causticAA * (0.35 + 0.65 * depthW) * vDepthMask * (1.0 - whiteCap);
      base += vec3(0.42, 0.86, 0.95) * caustic * 0.20;   // cyan-white shimmer
    }

    // ─── Round 2 · DRIFTING MIST — faint haze pooling over the churned water ──
    // A soft white veil over the broken/churning zones, REUSING the coarse foam
    // hash v0 (which drifts with the swell) so the sea-spray haze appears to HANG
    // over the surf and move WITH it. Gated by the broad crest-compression zone +
    // pinned-bank mask, kept well below the bloom threshold (subtle atmosphere).
    // Reuses v0 → zero new noise taps.
    float mistVeil = v0 * crestModerate * 0.12 * vDepthMask;
    base = mix(base, uColorFoam, mistVeil);

    // ─── Bank spray — hash-based, NO periodic trig ────────────────────────────
    // Old: sin(uTime * 1.8 + vWorldPos.z * 0.009) → ~697wu period bands along bank.
    // Fix: hash the bank position in world XZ with a slow time-advanced cell so
    // the spray intensity varies organically along the waterline, not as sine bands.
    float bankFactor  = 1.0 - smoothstep(0.0, 0.05, edgeDist);
    // 3da-adversary review: the raw single-tap bank hash had NO bilinear blend,
    // so it JUMPED up to 0.78 at every cell boundary (~220wu) along the waterline
    // — a visible C0 sawtooth in the spray strip. FIX: full Hermite bilinear blend
    // (4 corner taps + f*f*(3-2f)) on BOTH bank octaves, identical to the main FBM
    // octaves above, so spray varies smoothly along the bank. +6 ALU, no jumps.
    vec2  bPos   = vWorldPos.xz + vec2(uTime * 1.6, uTime * 0.9);
    vec2  bc0    = floor(bPos / 220.0);
    vec2  bf0    = fract(bPos / 220.0);
    vec2  bu0    = bf0 * bf0 * (3.0 - 2.0 * bf0);
    float bh00 = fract(sin(dot(bc0,              vec2(347.3, 193.7))) * 38291.4753);
    float bh10 = fract(sin(dot(bc0 + vec2(1,0), vec2(347.3, 193.7))) * 38291.4753);
    float bh01 = fract(sin(dot(bc0 + vec2(0,1), vec2(347.3, 193.7))) * 38291.4753);
    float bh11 = fract(sin(dot(bc0 + vec2(1,1), vec2(347.3, 193.7))) * 38291.4753);
    float bankHash = mix(mix(bh00, bh10, bu0.x), mix(bh01, bh11, bu0.x), bu0.y);
    // One octave finer for spray froth texture (also bilinear-smoothed).
    vec2  bPosF  = vWorldPos.xz + vec2(uTime * 2.9, -uTime * 1.5);
    vec2  bc1    = floor(bPosF / 80.0);
    vec2  bf1    = fract(bPosF / 80.0);
    vec2  bu1    = bf1 * bf1 * (3.0 - 2.0 * bf1);
    float bf00 = fract(sin(dot(bc1,              vec2(211.5, 509.1))) * 61738.2934);
    float bf10 = fract(sin(dot(bc1 + vec2(1,0), vec2(211.5, 509.1))) * 61738.2934);
    float bf01 = fract(sin(dot(bc1 + vec2(0,1), vec2(211.5, 509.1))) * 61738.2934);
    float bf11 = fract(sin(dot(bc1 + vec2(1,1), vec2(211.5, 509.1))) * 61738.2934);
    float bankHashFine = mix(mix(bf00, bf10, bu1.x), mix(bf01, bf11, bu1.x), bu1.y);
    float bankSpray   = bankHash * 0.65 + bankHashFine * 0.35;    // [0,1] irregular
    float bankIntensity = 0.38 + bankSpray * 0.24;                // [0.38, 0.62] range
    base = mix(base, uColorFoam, bankFactor * bankIntensity * 0.34);

    // ─── NO CURRENT STREAK TERM ───────────────────────────────────────────────
    // The old sin(vWorldPos.x * 0.02244) streak was removed entirely.
    // It produced ~11 evenly-spaced lateral lines across the 3219wu channel
    // (period ~280wu × 11.5 = channel width) — exactly the lateral stripe problem.
    // Any periodic streak function (horizontal OR lateral) will produce regular lines
    // at some camera altitude. The turbulence-based foam above already adds the
    // appearance of flow variation without any periodic function.

    gl_FragColor = vec4(base, 1.0);
  }
`;

export const SurfWaterMaterial = shaderMaterial(
  {
    uTime:        0,
    uEdgeTaper:   WATER_EDGE_TAPER,
    // ── Surf water palette — richly WET + reflective, not luminous ──────────
    // The reflection (analytic dusk sky + sun) is what reads as wet now, so the
    // body colours can stay deep + saturated. Deep channel reads dark through the
    // Beer-Lambert absorption; shallows read teal. All body values stay BELOW the
    // bloom threshold (0.80) so only the neon rails (#98f0ff ≈ 0.93) bloom — the
    // sun-glint spikes are tiny in area and intentionally allowed to sparkle.
    // Round 2 — TROPICAL color grade: vivid sunlit turquoise→deep-blue gradient
    // (was a cold navy→teal dusk palette). All body values still resolve BELOW the
    // bloom threshold (0.80) after Beer-Lambert absorption + the Fresnel/reflection
    // blend, so only the neon rails, sun glints, and crest-tip spray bloom.
    uColorDeep:    new THREE.Color('#0a4f97'),  // vivid tropical deep blue (was navy)
    uColorShallow: new THREE.Color('#1ec4b2'),  // bright tropical turquoise (was teal)
    uColorFoam:    new THREE.Color('#dcf0f5'),  // brighter sunlit whitecap/spray
    // Sky reflection endpoints + sun — warmed toward sunlit-tropical (was dusk):
    uSkyHorizon:   new THREE.Color('#4d7fb0'),  // brighter tropical sky-blue horizon band
    uSkyZenith:    new THREE.Color('#16386b'),  // brighter blue overhead (was deep indigo)
    uSunColor:     new THREE.Color('#ffe0b0'),  // brighter warm sun (disc + halo + glint)
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
      uSkyHorizon?: THREE.Color;
      uSkyZenith?: THREE.Color;
      uSunColor?: THREE.Color;
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
