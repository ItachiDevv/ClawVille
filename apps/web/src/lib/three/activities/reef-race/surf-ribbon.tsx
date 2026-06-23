'use client';

/**
 * surf-ribbon.tsx — the SURF ROAD: a glowing FLOATING WATER RIBBON (Rainbow-Road
 * style) winding through the cosmic void. THE WORLD. There is no land beneath it.
 *
 * This is the centerpiece. It replaces the old flat WaterSurf ribbon + the
 * grass/sand ground ribbons + the bank walls. Three merged layers, all swept
 * along the SAME shared `clientSpline` and LIFTED + TILTED by the render-only
 * `reefTrackElevationAt(t)` + `reefTrackBankAngleAt(t)` (via reef-race-elevation):
 *
 *   1. WATER SURFACE — stylized deep-cosmos water on a plain Mesh with a custom
 *      ShaderMaterial (Iris-Xe safe: plain Mesh, NOT InstancedMesh+Shader).
 *      Deep teal→cyan depth gradient, glowing animated crests, fake sun/star
 *      glint, downstream flow. The vertices are pre-lifted/tilted on the CPU so
 *      the surface rides the elevation profile; the shader adds the heave + look.
 *   2. NEON RAILS — two bright glowing tube-ish bands along each banked edge so
 *      the ribbon reads as a floating track in space (the Rainbow-Road rails).
 *      MeshBasicMaterial emissive-bright (bloom target) — merged to 1 draw call.
 *   3. CREST CAPS — a thin bright glowing strip just inside each rail (waterline
 *      glow) merged into the rails draw for a premium neon edge.
 *
 * THE PARITY CONTRACT: the ribbon Y is `reefTrackElevationAt(t)` at every t —
 * the SAME function the rider + camera read (reef-race-elevation.ts). Never a
 * flat plane, never a parallel hand-authored curve.
 *
 * Iris Xe invariants:
 *   - ShaderMaterial ONLY on the plain water Mesh — rails use MeshBasicMaterial.
 *   - NO InstancedMesh + ShaderMaterial. NO drei <Text>/<Billboard>.
 *   - Custom ShaderMaterial MUST be fog:false (scene.fog + a shader lacking fog
 *     uniforms throws every frame — documented Iris-Xe gotcha). The void is the
 *     backdrop, not fog, so fog:false is correct anyway.
 *   - import from 'three' (NOT 'three/webgpu').
 *   - All geo/mat module-scope, baked once; frustumCulled=false (vertex shader
 *     heave + large swept bounds make the bind-pose bounding sphere stale).
 *   - One uniform write/frame (uTime). Zero per-frame allocation.
 *   - Noise scale kept LOW (12/8) — high scale aliases to grey from altitude
 *     (documented). The crest band uses UV.y so it stays crisp at any distance.
 *
 * Draw calls: 1 water + 1 rails(merged L+R+crests) = 2.
 * Tris: water 128×2≈256 ; rails ~128×4 sides×2≈1024 → ~1300 total.
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
const RIBBON_SAMPLES = 128; // longitudinal samples (smoothness vs cost — 256 tris)
const RAIL_HEIGHT    = 26;   // neon rail height above the water surface (wu)
const RAIL_THICKNESS = 18;   // rail width outward from the ribbon edge (wu)
const CREST_WIDTH    = 34;   // inner glowing waterline band width (wu)

// ─── Local-frame helper: lifted + tilted left/right edge points at sample t ──
//
// In the local frame {tangent (forward), normal n̂ (left/lateral), up ŷ}, a roll
// by `bank` about the tangent maps the lateral axis:
//   n̂  →  cos(bank)·n̂ + sin(bank)·ŷ
// so the LEFT edge offset (along +n̂ by hw) tilts up/down into the turn, and the
// RIGHT edge (−n̂) tilts the opposite way. This banks the whole cross-section
// like a Rainbow-Road turn. Y comes from the shared elevation profile.
interface EdgeFrame {
  cx: number; cz: number; cy: number;     // centerline (lifted)
  lx: number; ly: number; lz: number;     // left edge (lifted + banked)
  rx: number; ry: number; rz: number;     // right edge
  /** Lateral unit (banked) — outward = +n̂ rolled, used to push the rails out. */
  unx: number; uny: number; unz: number;
}

function frameAt(t: number): EdgeFrame {
  const c = clientSpline.centerlineAt(t);
  const n = clientSpline.normalAt(t);  // 90° CCW of tangent = left of travel
  const hw = clientSpline.widthAt(t);
  const y = elevationAtT(t);
  const bank = bankAngleAtT(t);
  const cb = Math.cos(bank);
  const sb = Math.sin(bank);

  // Banked lateral unit vector (n̂ rolled about the forward/tangent axis):
  //   lateral = cos(bank)·(n.x,0,n.z) + sin(bank)·(0,1,0)
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

// ─── Water surface shader ──────────────────────────────────────────────────────
//
// The vertices already carry the lifted+banked world position (built on CPU).
// The vertex shader adds a small heaving displacement along world-up only (so it
// never breaks the banked cross-section), and forwards UV + world pos.
const _waterVert = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    // gentle heave along world-up only — small (±6wu), keeps the banked profile
    float heave = sin(position.x * 0.004 + uTime * 0.8) * 3.0
                + sin(position.z * 0.003 + uTime * 1.1) * 2.0
                + sin((position.x + position.z) * 0.0018 - uTime * 0.6) * 1.0;
    vec3 displaced = position;
    displaced.y += heave;
    vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const _waterFrag = /* glsl */`
  uniform float uTime;
  uniform vec3  uColorDeep;
  uniform vec3  uColorShallow;
  uniform vec3  uColorCrest;
  uniform vec3  uSunDir;
  varying vec2  vUv;
  varying vec3  vWorldPos;

  // 2D simplex noise (Ashima Arts)
  vec3 _m3(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec2 _m2(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
  vec3 _p(vec3 x){return _m3(((x*34.0)+1.0)*x);}
  float snoise(vec2 v){
    const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
    vec2 i=floor(v+dot(v,C.yy));
    vec2 x0=v-i+dot(i,C.xx);
    vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
    vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1;
    i=_m2(i);
    vec3 p=_p(_p(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
    vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
    m=m*m; m=m*m;
    vec3 x=2.0*fract(p*C.www)-1.0;
    vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
    m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
    vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
    return 130.0*dot(m,g);
  }

  void main() {
    // depth: 0 at banks → 0.5 at centre
    float edgeDist = min(vUv.x, 1.0 - vUv.x);
    float depth    = smoothstep(0.0, 0.30, edgeDist);
    vec3  base     = mix(uColorShallow, uColorDeep, depth);

    // two scrolling noise layers — LOW scale (12/8) so it never aliases to grey
    // from a high chase/orbit camera (documented surf-water gotcha).
    vec2 s1 = vUv + vec2(0.0, -uTime * 0.04);
    vec2 s2 = vUv + vec2(0.0, -uTime * 0.07) + vec2(13.1, 5.7);
    float n1 = snoise(s1 * 12.0) * 0.5 + 0.5;
    float n2 = snoise(s2 *  8.0) * 0.5 + 0.5;
    float flow = n1 * 0.6 + n2 * 0.4;

    // glowing animated crests — soft organic clusters, painted as a bright cyan
    // additive accent (bloom picks this up). Cluster-modulated so it's organic.
    float crestField = smoothstep(0.55, 0.85, flow);
    float cluster    = mix(0.55, 1.0, snoise(vUv * 24.0 + vec2(0.0, uTime * 0.02)) * 0.5 + 0.5);
    float crest      = crestField * cluster;
    base = mix(base, uColorCrest, crest * 0.85);

    // fake sun/star glint — flat ribbon normal is world-up; rises in the centre.
    vec3 normal  = vec3(0.0, 1.0, 0.0);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 refl    = reflect(-uSunDir, normal);
    float spec   = pow(max(dot(refl, viewDir), 0.0), 40.0);
    base += vec3(0.45, 0.7, 0.9) * spec * depth;

    // cosmic sheen: a faint violet rim near the banks (waterline shimmer)
    float rim = (1.0 - depth);
    base += vec3(0.10, 0.06, 0.20) * rim * (0.4 + 0.6 * n1);

    gl_FragColor = vec4(base, 1.0);
  }
`;

export const SurfWaterMaterial = shaderMaterial(
  {
    uTime:         0,
    uColorDeep:    new THREE.Color('#0a3a55'),   // deep cosmos teal
    uColorShallow: new THREE.Color('#1fa8c8'),   // glowing cyan banks
    uColorCrest:   new THREE.Color('#a9f3ff'),   // bright cyan-white crest glow
    uSunDir:       new THREE.Vector3(0.34, 0.86, -0.38), // toward the chase cam
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
      uColorCrest?: THREE.Color;
      uSunDir?: THREE.Vector3;
    };
  }
}

// ─── Geometry builders ─────────────────────────────────────────────────────────

/** Water surface ribbon — lifted + banked, UV.x lateral, UV.y arclength. */
function buildWaterGeo(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[]   = [];
  const uvs: number[]       = [];
  const indices: number[]   = [];

  // CLOSED-LOOP: emit `samples` vertex pairs (t=0..(samples-1)/samples). The
  // closing quad wraps the last pair back to verts 0/1 — no seam at the line.
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
 * Build a glowing rail running along one edge (side=+1 left, -1 right).
 * The rail is a thin vertical-ish band: a quad strip from the edge surface up
 * to RAIL_HEIGHT, pushed RAIL_THICKNESS outward along the banked lateral.
 * Returned as a single merged BufferGeometry (DoubleSide-lit by MeshBasic).
 */
function buildRailGeo(side: 1 | -1): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[]   = [];

  for (let i = 0; i < RIBBON_SAMPLES; i++) {
    const t = i / RIBBON_SAMPLES;
    const f = frameAt(t);
    // edge base point on this side
    const ex = side === 1 ? f.lx : f.rx;
    const ey = side === 1 ? f.ly : f.ry;
    const ez = side === 1 ? f.lz : f.rz;
    // outward push along banked lateral (away from centre on this side)
    const ox = f.unx * RAIL_THICKNESS * side;
    const oy = f.uny * RAIL_THICKNESS * side;
    const oz = f.unz * RAIL_THICKNESS * side;

    // 4 verts: inner-bottom, inner-top, outer-bottom, outer-top (top = +up)
    // bottom row sits at the edge; top row is RAIL_HEIGHT up (world-up).
    positions.push(ex,            ey,                ez);             // inner-bottom
    positions.push(ex,            ey + RAIL_HEIGHT,  ez);             // inner-top
    positions.push(ex + ox,       ey + oy,           ez + oz);        // outer-bottom
    positions.push(ex + ox,       ey + oy + RAIL_HEIGHT, ez + oz);    // outer-top

    const base = i * 4;
    const next = (i + 1 < RIBBON_SAMPLES) ? base + 4 : 0;
    // inner wall (inner-bottom, inner-top, next-inner-bottom, next-inner-top)
    indices.push(base + 0, base + 1, next + 0);
    indices.push(base + 1, next + 1, next + 0);
    // top cap (inner-top, outer-top, next)
    indices.push(base + 1, base + 3, next + 1);
    indices.push(base + 3, next + 3, next + 1);
    // outer wall
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
 * Build a thin glowing crest band just inside each rail — a flat strip on the
 * water surface from the edge inward by CREST_WIDTH. The bright waterline glow.
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
    // inward along banked lateral toward centre (opposite of outward)
    const ix = -f.unx * CREST_WIDTH * side;
    const iy = -f.uny * CREST_WIDTH * side;
    const iz = -f.unz * CREST_WIDTH * side;
    // slight +Y lift so it sits just above the water surface (no z-fight)
    const lift = 1.5;

    positions.push(ex,      ey + lift,      ez);        // edge
    positions.push(ex + ix, ey + iy + lift, ez + iz);   // inner

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

// Merge both rails + both crests into ONE geometry (1 draw call). All four use
// the same emissive neon material so a single merge is valid.
const _railLeft   = buildRailGeo(1);
const _railRight  = buildRailGeo(-1);
const _crestLeft  = buildCrestGeo(1);
const _crestRight = buildCrestGeo(-1);
const _railsGeo = mergeGeometries([_railLeft, _railRight, _crestLeft, _crestRight], false)!;
_railLeft.dispose(); _railRight.dispose(); _crestLeft.dispose(); _crestRight.dispose();

// Neon rail material — bright emissive cyan-white (the bloom target). NOT a
// ShaderMaterial — MeshBasicMaterial keeps it Iris-Xe safe + bloom-friendly.
const _railMat = new THREE.MeshBasicMaterial({
  color: '#7af6ff',
  side: THREE.DoubleSide,
  fog: false,
  toneMapped: false, // keep it bright (>1 perceptually) so bloom catches it
});

// ─── SurfRibbon component ─────────────────────────────────────────────────────

/**
 * SurfRibbon — the floating water ribbon + neon rails + crest glow. Mount inside
 * the scene's track group. The geometry is in ABSOLUTE world XZ + the shared
 * elevation Y, so it needs NO position offset (the parent track group should be
 * at Y=0 — the elevation function is the datum, not a flat plane).
 */
export function SurfRibbon() {
  const matRef = useRef<InstanceType<typeof SurfWaterMaterial>>(null);

  useFrame((state) => {
    if (matRef.current) matRef.current.uTime = state.clock.elapsedTime;
  });

  return (
    <group>
      {/* Glowing cosmic water surface (rides elevation + bank) */}
      <mesh geometry={_waterGeo} frustumCulled={false} renderOrder={1}>
        <surfWaterMaterial
          ref={matRef}
          side={THREE.DoubleSide}
          fog={false}
          key={SurfWaterMaterial.key}
        />
      </mesh>

      {/* Neon banked rails + crest glow (merged, bloom target) */}
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
