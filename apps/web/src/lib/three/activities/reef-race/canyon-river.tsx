'use client';

/**
 * canyon-river.tsx — FLOATING CANYON-RIVER cross-section for the SURF ROAD.
 *
 * Founder feedback on v5 (pure cosmic void): "This is cool but VERY fucking
 * drastic — land to space. Need to KEEP LAND IMMEDIATELY around the water
 * path — like a canyon thing plus a small land extension on the sides — but
 * better."
 *
 * Cross-section (both sides mirror-image):
 *
 *   [ abstract atmospheric void beyond ]
 *     └ THIN LAND SHOULDER  (earthy/rocky strip, ~250–480wu wide)
 *         └ CANYON WALL     (rock cliff rising from the waterline — the "canyon")
 *             └ WATER CHANNEL  (existing SurfRibbon — NOT touched here)
 *         └ CANYON WALL
 *     └ THIN LAND SHOULDER
 *
 * THE PARITY CONTRACT: every vertex Y of both the canyon wall AND the shoulder
 * uses the SAME `elevationAtT(t)` + a profile-relative offset (cliff rises
 * upward from the datum; shoulder sits slightly below). The geometry floats and
 * undulates WITH the water ribbon through every climb/dip/bank — it never
 * detaches. The bank tilt from `bankAngleAtT(t)` is applied to the LATERAL
 * direction so the canyon walls lean into turns exactly like the ribbon's rails.
 *
 * Geometry:
 *   - CANYON WALL: a cliff-face ribbon. 6-vertex cross-section per sample —
 *     inner base (waterline), inner step, outer step, upper ledge, cliff top,
 *     cliff-top far — creating a stepped natural rock profile. BOTH banks are
 *     baked into ONE merged BufferGeometry (1 draw call). Winding order differs
 *     between banks (left bank inner faces +X, right bank inner faces -X) —
 *     see note below.
 *   - LAND SHOULDER: a thin, gently contoured strip outside the cliff. Two
 *     rows of verts (inner ≈ cliff-top, outer edge), slight perpendicular
 *     undulation from a mulberry32 hash giving an organic irregular silhouette.
 *     Both banks merged into ONE BufferGeometry (1 draw call).
 *   Total new draw calls: 2 (was 0; now canyon + shoulder).
 *
 * Iris Xe invariants:
 *   - MeshStandardMaterial (NOT ShaderMaterial). Vertex colours bake the rock
 *     striations and soil gradient — no per-fragment noise needed.
 *   - NO InstancedMesh+ShaderMaterial.
 *   - NO drei <Text>/<Billboard>.
 *   - import from 'three' (NOT 'three/webgpu').
 *   - All geo/mat module-scope, baked once; frustumCulled=false (swept ribbon).
 *   - No per-frame allocation (module-scope scratch scalars only).
 *   - fog:true on both materials — the shoulder naturally fades into the void
 *     at distance, which reads well (unlike the ribbon/rails which must stay
 *     crisp and are fog:false). Canyon walls also fog:true for depth.
 *
 * WINDING ORDER NOTE:
 *   Left bank (side=+1): cliff inner face looks toward +X (toward the water).
 *     tri (a,b,c) needs cross(b-a, c-a).x > 0 → CCW looking from +X = (a,c,b).
 *   Right bank (side=-1): inner face looks toward -X.
 *     tri (a,b,c) needs (a,b,c) standard.
 *   The `buildCanyonQuad` helper takes `side` and flips accordingly.
 *   Shoulder is flat-ish (normal ≈ +Y); standard CCW (a,b,c) = +Y from above
 *   after the banked lateral roll, but since both sides are included and the
 *   camera always approaches from above/behind, DoubleSide is used to be safe.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clientSpline } from './reef-race-spline-instance';
import { elevationAtT, bankAngleAtT } from './reef-race-elevation';
import { WATER_SEAL_DROP } from './surf-cross-section';

// ─── Geometry constants ────────────────────────────────────────────────────────

/**
 * Longitudinal samples — MUST EQUAL `RIBBON_SAMPLES` (224) in surf-ribbon.tsx.
 *
 * WATERTIGHT SEAM CONTRACT: the canyon inner-base polyline (v0) and the water
 * edge polyline are both swept from the SAME `clientSpline` at t = i/SAMPLES.
 * If the two sample counts differ, the polylines only coincide at the shared
 * spline-t values; BETWEEN samples they chord differently and a lateral sliver
 * opens on concave turns (at 128 vs 224, the inner-bank sagitta mismatch reached
 * ~74wu — far more than the 40wu WATER_SEAL_DROP vertical lip can cover, since
 * the cliff rises immediately from the base where the base pulls away from the
 * water edge). Matching the count to 224 makes both edge polylines share
 * BIT-IDENTICAL vertices at every sample on BOTH banks → zero chordal mismatch,
 * truly watertight. Cost is trivial (still merges to 1 draw call each;
 * ~3584 canyon verts + ~896 shoulder verts — well within the Iris Xe budget).
 */
const CANYON_SAMPLES = 224;

// Canyon wall cross-section profile (offsets from the corridor half-width edge,
// along the BANKED LATERAL direction outward and the world-UP direction).
// Positive lat = outward (away from water centre). Positive up = upward from datum.
const CLIFF_INNER_LAT  =   0;   // waterline edge (aligns with SurfRibbon edge)
const CLIFF_STEP1_LAT  =  60;   // first step outward
const CLIFF_STEP1_UP   =  80;   // rises 80wu at step 1
const CLIFF_STEP2_LAT  = 130;   // second step
const CLIFF_STEP2_UP   = 200;   // rises to 200wu here
const CLIFF_TOP_LAT    = 180;   // overhang — narrows slightly toward top
const CLIFF_TOP_UP     = 340;   // cliff top

// Shoulder: flat strip from cliff outer edge to shoulder limit.
// Inner lat MUST equal CLIFF_TOP_LAT so the shoulder's inner row sits exactly
// on the cliff-top edge — was 200 (a 20wu lateral gap vs the 180 cliff top that
// the comment wrongly claimed to "match"), which opened a thin ridge seam.
const SHOULDER_INNER_LAT = CLIFF_TOP_LAT; // shoulder starts exactly at cliff top (180)
const SHOULDER_OUTER_LAT = 480; // shoulder limit (~300wu wide)
const SHOULDER_UNDULATION = 22; // max vertical irregularity (hash-driven, org feel)

// Colours — warm earthy rock palette.
const _cBase   = new THREE.Color('#3d2e20'); // dark earthy brown base
const _cMid    = new THREE.Color('#5c4535'); // mid warm rock
const _cLight  = new THREE.Color('#7a6045'); // lighter tan-ochre striations
const _cTop    = new THREE.Color('#4a3a2a'); // darkened cliff top (shadow reading)
const _cSoil   = new THREE.Color('#6a5040'); // soil/earth at shoulder surface
const _cSoilFar = new THREE.Color('#3a2a1a'); // darker outer shoulder edge

// ─── mulberry32 deterministic hash (stable striations) ────────────────────────
let _seed = 0xdeadbeef;
function _rand(): number {
  _seed = (_seed + 0x6d2b79f5) >>> 0;
  let t = _seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ─── Local-frame helper (same banked lateral math as SurfRibbon) ──────────────

/** Per-sample data needed by both builders. */
interface _Frame {
  cx: number; cy: number; cz: number;   // centerline XYZ (cy = elevation datum)
  unx: number; uny: number; unz: number; // banked lateral unit (toward left of travel)
  hw: number;                             // corridor half-width
}

function _frameAt(t: number): _Frame {
  const c  = clientSpline.centerlineAt(t);
  const n  = clientSpline.normalAt(t);        // 90° CCW of tangent = LEFT
  const hw = clientSpline.widthAt(t);
  const y  = elevationAtT(t);
  const bank = bankAngleAtT(t);
  const cb = Math.cos(bank);
  const sb = Math.sin(bank);
  return {
    cx: c.x, cy: y, cz: c.z,
    unx: n.x * cb,
    uny: sb,
    unz: n.z * cb,
    hw,
  };
}

// ─── Canyon wall geometry builder ─────────────────────────────────────────────

/**
 * Emit a cliff ribbon for one bank (side=+1 left, -1 right) and append into
 * the shared positions/normals/colors/indices arrays.
 *
 * Cross-section profile (outer = away from water):
 *   v0: waterline-base (inner = datum Y, at corridor edge ± hw)
 *   v1: step-1 (CLIFF_STEP1_LAT out, CLIFF_STEP1_UP up)
 *   v2: step-2 (CLIFF_STEP2_LAT out, CLIFF_STEP2_UP up)
 *   v3: cliff-top (CLIFF_TOP_LAT out, CLIFF_TOP_UP up — small overhang inward)
 *
 * Three quads: base→step1, step1→step2, step2→top.  Each face between two
 * consecutive cross-sections forms 2 triangles.
 *
 * Winding: we always emit the cliff inner face visible from the water channel.
 *   - side=+1 (left bank): face normal roughly points -X (toward +X water centre).
 *     Correct CCW from inside (from the water): a→c→b for each quad top row.
 *   - side=-1 (right bank): face normal roughly points +X.  a→b→c.
 *
 * Both sides merged → one call to mergeGeometries → 1 draw call.
 */
function _buildCanyonBankGeo(side: 1 | -1): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors:    number[] = [];
  const normals:   number[] = [];
  const indices:   number[] = [];

  // Profile: 4 verts per sample × CANYON_SAMPLES rows.
  // Lateral offsets (positive = outward from water centre, along banked lateral):
  const laterals = [CLIFF_INNER_LAT, CLIFF_STEP1_LAT, CLIFF_STEP2_LAT, CLIFF_TOP_LAT];
  // WATERTIGHT SEAL: inner base (v0) drops WATER_SEAL_DROP wu BELOW the banked
  // datum so the rock forms a submerged lip UNDER the (tapered-to-datum) water
  // edge — even a numerical residual can't open a gap to the void. The lip is
  // hidden under the water surface so it reads as rock continuing into the water.
  const ups      = [-WATER_SEAL_DROP, CLIFF_STEP1_UP,  CLIFF_STEP2_UP,  CLIFF_TOP_UP ];
  const PROFILE  = 4;

  const C = [_cBase, _cMid, _cLight, _cTop]; // colours per profile row

  _seed = 0xc0ffee12; // deterministic seed for cliff striations

  for (let i = 0; i < CANYON_SAMPLES; i++) {
    const t = i / CANYON_SAMPLES;
    const f = _frameAt(t);

    for (let p = 0; p < PROFILE; p++) {
      const lat = laterals[p] * side;   // outward on this side
      const up  = ups[p];

      // base point on the corridor edge of this bank, then push outward+up.
      // Banked-Y MUST match SurfRibbon.frameAt(): left edge ly = cy + uny*hw,
      // right edge ry = cy - uny*hw  →  cy + uny*hw*side. (Was `- uny*hw*side`,
      // a sign flip that diverged from the water edge by 2*uny*hw on every
      // banked turn — a hole exactly where the bank leans. Now pinned to the
      // SAME banked datum point the water's tapered edge sits on.)
      const bx = f.cx + f.unx * f.hw * side;
      const by = f.cy + f.uny * f.hw * side; // banked edge Y (matches water edge)
      const bz = f.cz + f.unz * f.hw * side;

      // displacement along banked lateral (outward) and world-up
      const ox = f.unx * lat;
      const oy = f.uny * lat + up;   // banked lateral + world-up rise
      const oz = f.unz * lat;

      positions.push(bx + ox, by + oy, bz + oz);

      // striation colour: base colour ± small jitter
      const jitter = (_rand() * 2 - 1) * 0.05;
      const cr = THREE.MathUtils.clamp(C[p].r + jitter, 0, 1);
      const cg = THREE.MathUtils.clamp(C[p].g + jitter * 0.8, 0, 1);
      const cb2 = THREE.MathUtils.clamp(C[p].b + jitter * 0.6, 0, 1);
      colors.push(cr, cg, cb2);

      // approximate normals — will be recomputed; placeholder (0,1,0)
      normals.push(0, 1, 0);
    }
  }

  // Build indices: for each longitudinal segment × 3 face strips (PROFILE-1 quads)
  // Each quad = 2 tris. Winding: left bank flip to keep inner face toward water.
  for (let i = 0; i < CANYON_SAMPLES; i++) {
    const nextI = (i + 1) % CANYON_SAMPLES;
    const base  = i      * PROFILE;
    const nextB = nextI  * PROFILE;

    for (let q = 0; q < PROFILE - 1; q++) {
      const a = base  + q;
      const b = base  + q + 1;
      const c = nextB + q;
      const d = nextB + q + 1;

      if (side === 1) {
        // left bank: inner face visible from water = flip winding
        indices.push(a, c, b);
        indices.push(b, c, d);
      } else {
        // right bank: standard winding
        indices.push(a, b, c);
        indices.push(b, d, c);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals(); // overwrite placeholder normals with proper face normals
  return geo;
}

// ─── Land shoulder geometry builder ───────────────────────────────────────────

/**
 * Emit a thin terrain shoulder strip for one bank. Two vertex rows: inner (at
 * SHOULDER_INNER_LAT from corridor edge) and outer (at SHOULDER_OUTER_LAT).
 * The shoulder sits at datum Y + CLIFF_TOP_UP + a small hash-driven undulation
 * for organic feel. Both sides merged to 1 draw call.
 */
function _buildShoulderBankGeo(side: 1 | -1): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors:    number[] = [];
  const normals:   number[] = [];
  const indices:   number[] = [];

  // 2 verts per sample (inner + outer row).
  _seed = 0xbeefd00d;

  for (let i = 0; i < CANYON_SAMPLES; i++) {
    const t = i / CANYON_SAMPLES;
    const f = _frameAt(t);

    // Base: the corridor edge of this bank (lifted + banked).
    // Same banked-Y datum as the canyon builder (cy + uny*hw*side) so the
    // shoulder leans WITH the cliff top through every banked turn.
    const bx = f.cx + f.unx * f.hw * side;
    const by = f.cy + f.uny * f.hw * side;
    const bz = f.cz + f.unz * f.hw * side;

    // Inner vertex (at shoulder start = cliff top lat)
    const iLat = SHOULDER_INNER_LAT * side;
    const iUp  = CLIFF_TOP_UP + 2; // sits just above cliff top edge (+2wu lift to avoid z-fight)
    positions.push(
      bx + f.unx * iLat,
      by + f.uny * iLat + iUp,
      bz + f.unz * iLat,
    );

    // Outer vertex (at shoulder limit) + organic height undulation
    const oLat = SHOULDER_OUTER_LAT * side;
    const undulate = (_rand() * 2 - 1) * SHOULDER_UNDULATION;
    const oUp  = CLIFF_TOP_UP - 15 + undulate; // shoulder tilts slightly downward outward
    positions.push(
      bx + f.unx * oLat,
      by + f.uny * oLat + oUp,
      bz + f.unz * oLat,
    );

    // Soil colour gradient: warm earthy inner → darker outer edge.
    // Manual lerp to avoid per-sample .clone() allocations.
    const blend = _rand() * 0.15;
    const invB = 1 - blend;
    colors.push(
      _cSoil.r * invB + _cMid.r * blend,
      _cSoil.g * invB + _cMid.g * blend,
      _cSoil.b * invB + _cMid.b * blend,
    );
    colors.push(
      _cSoilFar.r * invB + _cBase.r * blend,
      _cSoilFar.g * invB + _cBase.g * blend,
      _cSoilFar.b * invB + _cBase.b * blend,
    );

    normals.push(0, 1, 0, 0, 1, 0); // placeholders, recomputed below
  }

  // 1 quad strip (2 rows × CANYON_SAMPLES columns).
  // Shoulder normal should face UP (outward from surface). DoubleSide is used
  // on the material for safety; we still choose winding that gives +Y normal
  // from above (standard: CCW = +Y looking down).
  for (let i = 0; i < CANYON_SAMPLES; i++) {
    const nextI = (i + 1) % CANYON_SAMPLES;
    const base  = i     * 2;
    const nextB = nextI * 2;

    const a = base  + 0; // inner-i
    const b = base  + 1; // outer-i
    const c = nextB + 0; // inner-next
    const d = nextB + 1; // outer-next

    // Both banks: +Y normal = CCW from above. Left vs right have mirrored lateral
    // directions but the up-normal winding is the same for a roughly flat surface.
    // Verified by cross product: v1=(outer-inner), v2=(inner-next-inner) →
    // for the left shoulder v1.x<0 (outward = -X), v2.z>0 → cross.y >0 ✓
    // for the right shoulder v1.x>0 (outward = +X), v2.z>0 → cross.y <0 ✗ → flip
    if (side === 1) {
      indices.push(a, b, c);
      indices.push(b, d, c);
    } else {
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ─── Module-scope baked geometry + materials ──────────────────────────────────

// Merge both canyon banks → 1 draw call.
const _canyonLeft  = _buildCanyonBankGeo(1);
const _canyonRight = _buildCanyonBankGeo(-1);
const _canyonGeo   = mergeGeometries([_canyonLeft, _canyonRight], false)!;
_canyonLeft.dispose();
_canyonRight.dispose();

// Merge both shoulder banks → 1 draw call.
const _shoulderLeft  = _buildShoulderBankGeo(1);
const _shoulderRight = _buildShoulderBankGeo(-1);
const _shoulderGeo   = mergeGeometries([_shoulderLeft, _shoulderRight], false)!;
_shoulderLeft.dispose();
_shoulderRight.dispose();

// Rock material — MeshStandardMaterial, vertex colours, rough/matte.
const _canyonMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  side: THREE.DoubleSide,
  roughness: 0.92,
  metalness: 0.0,
  fog: true, // fades into void at distance — correct for land
});

// Soil/shoulder material — slightly smoother than rock face.
const _shoulderMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  side: THREE.DoubleSide,
  roughness: 0.88,
  metalness: 0.0,
  fog: true,
});

// ─── CanyonRiver component ─────────────────────────────────────────────────────

/**
 * CanyonRiver — the floating canyon walls + thin land shoulders hugging the
 * SURF ROAD water ribbon.
 *
 * Mount INSIDE the same R3F Canvas as `<SurfRibbon />` and `<CosmicVoid />`.
 * The geometry lives in ABSOLUTE world XZ + the shared elevation Y datum, so
 * no position offset is needed (parent track group must be at Y=0).
 *
 * Draw calls added: 2 (canyon = 1, shoulder = 1).
 * Triangles added: canyon ~128×3 quads×2 sides×2 = ~1536; shoulder ~128×2 sides×2 = ~512. ≈ 2048 tris total.
 */
export function CanyonRiver() {
  return (
    <group>
      {/* Rock canyon walls — both banks, 1 draw call */}
      <mesh
        geometry={_canyonGeo}
        material={_canyonMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        renderOrder={0}
        castShadow={false}
        receiveShadow={false}
      />

      {/* Thin land shoulders — both banks, 1 draw call */}
      <mesh
        geometry={_shoulderGeo}
        material={_shoulderMat}
        frustumCulled={false}
        matrixAutoUpdate={false}
        renderOrder={0}
        castShadow={false}
        receiveShadow={false}
      />
    </group>
  );
}
