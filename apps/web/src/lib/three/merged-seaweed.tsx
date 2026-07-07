'use client';

import { useMemo, useEffect } from 'react';
import * as THREE from 'three/webgpu';
import { attribute, positionGeometry, float, sin, cos, vec3, time } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
import { LAND_PARCELS } from '@clawville/shared';

// ---------------------------------------------------------------------------
// Merged Seaweed / Kelp Ground Cover
// ~3000 blades (3 shape variants) baked into ONE BufferGeometry = 1 draw call
// Wind animation via TSL positionNode (GPU vertex shader, zero CPU cost)
// NO InstancedMesh — avoids Intel Iris Xe WebGPU crash
// ---------------------------------------------------------------------------

// 2026-06-15 (Phase 0 land): 4500→6500 for the expanded 576x576 world (18432x18432wu).
const BLADE_COUNT = 6500;
const HALF_MW = MAP_WIDTH / 2;
const HALF_MH = MAP_HEIGHT / 2;
const SPREAD_X = MAP_WIDTH * 2.2;
const SPREAD_Z = MAP_HEIGHT * 2.2;

// Blade variant mix ratios (must sum to 1.0)
const RATIO_SHORT_GRASS = 0.40;
const RATIO_TALL_KELP   = 0.35;
// Remaining 0.25 = medium fern

// Building exclusion zones — derived from canonical tilemap-data source of truth
const BUILDING_ZONES = buildingZones.map((z) => ({
  cx: -HALF_MW + (z.x + z.width  / 2) * TILE_SIZE,
  cz: -HALF_MH + (z.y + z.height / 2) * TILE_SIZE,
  radius: Math.max(z.width, z.height) * TILE_SIZE * 2.0,
}));

// Land parcel exclusion zones — blades don't grow where parcels will be placed.
// Radius = half the parcel footprint + a small buffer (0.8 tiles) so seaweed
// doesn't poke through parcel borders at the edge of the cleared circle.
const PARCEL_ZONES = LAND_PARCELS.map((p) => ({
  cx: p.cx,
  cz: p.cz,
  // half-diagonal of the square footprint + buffer (conservative circle over square)
  radius: (p.size / 2) * Math.SQRT2 + 0.8 * TILE_SIZE,
}));

function isNearBuilding(x: number, z: number): boolean {
  for (const b of BUILDING_ZONES) {
    const dx = x - b.cx;
    const dz = z - b.cz;
    if (dx * dx + dz * dz < b.radius * b.radius) return true;
  }
  return false;
}

function isNearParcel(x: number, z: number): boolean {
  for (const p of PARCEL_ZONES) {
    const dx = x - p.cx;
    const dz = z - p.cz;
    if (dx * dx + dz * dz < p.radius * p.radius) return true;
  }
  return false;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// Color palettes per variant
// ---------------------------------------------------------------------------

// Short grass — darker, more muted, ground-level tones
const COLORS_GRASS = [
  new THREE.Color(0x1a4d28), // Very dark forest green
  new THREE.Color(0x1e5c30), // Dark forest green
  new THREE.Color(0x2a5e38), // Deep olive green
  new THREE.Color(0x1a4a3a), // Dark sea green
  new THREE.Color(0x2d5540), // Dark teal-green
  new THREE.Color(0x354a2a), // Muddy olive
];

// Tall kelp — brighter, more vibrant, saturated greens
const COLORS_KELP = [
  new THREE.Color(0x27ae60), // Emerald
  new THREE.Color(0x1abc9c), // Jade / sea green
  new THREE.Color(0x16a085), // Dark teal (vibrant)
  new THREE.Color(0x2ecc71), // Bright emerald
  new THREE.Color(0x148f77), // Deep jade
  new THREE.Color(0x239b56), // Rich green
];

// Medium fern — mid-tones, earthy with blue-green cast
const COLORS_FERN = [
  new THREE.Color(0x1d6b4f), // Sea green
  new THREE.Color(0x2e7d5a), // Mid forest
  new THREE.Color(0x3a7d44), // Olive-emerald
  new THREE.Color(0x1a6b5a), // Teal-green
  new THREE.Color(0x4a7c59), // Muted jade
  new THREE.Color(0x2d6a4f), // Deep fern
];

// ---------------------------------------------------------------------------
// Blade geometry builders — each returns a flat-strip with segs segments
// Vertices: (segs+1)*2 per blade
// ---------------------------------------------------------------------------

/** Short grass blade: low, slight curve, narrow */
function createShortGrassGeo(): THREE.BufferGeometry {
  const segs = 4; // fewer segments = fewer verts
  const height = 10 + Math.random() * 5; // 10-15
  const width = 1.5;
  const curve = 0.8; // gentle bend

  const vertices: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * height;
    const w = width * (1 - t * 0.75);
    const bendX = t * t * curve;
    vertices.push(-w + bendX, y, 0);
    vertices.push( w + bendX, y, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Tall kelp blade: tall, strong curve, medium width */
function createTallKelpGeo(): THREE.BufferGeometry {
  const segs = 6; // more segments for smooth tall curve
  const height = 35 + Math.random() * 10; // 35-45
  const width = 2.5;
  const curve = 4.5; // strong sweep

  const vertices: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * height;
    const w = width * (1 - t * 0.65);
    // S-curve: cubic bend for more natural kelp shape
    const bendX = (t * t * t * 2 - t * t * 0.5) * curve;
    const bendZ = Math.sin(t * Math.PI * 0.6) * curve * 0.3;
    vertices.push(-w + bendX, y, bendZ);
    vertices.push( w + bendX, y, bendZ);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Medium fern blade: mid height, wide spreading, flat arc */
function createMediumFernGeo(): THREE.BufferGeometry {
  const segs = 5;
  const height = 20 + Math.random() * 5; // 20-25
  const width = 4.0; // wider than others
  const curve = 2.0;

  const vertices: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * height;
    // Taper more aggressively for a leaf-like silhouette
    const taper = t < 0.5 ? 1.0 - t * 0.2 : 1.0 - t * 0.9;
    const w = width * taper;
    // Gentle arc with slight lateral lean
    const bendX = t * t * curve;
    const bendZ = Math.sin(t * Math.PI) * curve * 0.4; // bulge in middle
    vertices.push(-w + bendX, y, bendZ);
    vertices.push( w + bendX, y, bendZ);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Blade variant descriptor
// ---------------------------------------------------------------------------

type BladeVariant = 'grass' | 'kelp' | 'fern';

interface BladeData {
  x: number;
  z: number;
  rotY: number;
  scale: number;
  color: THREE.Color;
  variant: BladeVariant;
  amplitude: number; // sway amplitude baked per-blade
  segs: number;      // segment count for attribute generation
}

// ---------------------------------------------------------------------------
// Organic cluster distribution
// Scatter a set of cluster centres, then place blades near them with
// a Gaussian-like falloff. This avoids the uniform look of pure random.
// ---------------------------------------------------------------------------

function generateBlades(): BladeData[] {
  const rng = seededRandom(99991);
  const blades: BladeData[] = [];

  // Generate cluster centres — one centre per ~50 blades
  const clusterCount = Math.ceil(BLADE_COUNT / 50);
  const clusters: Array<{ x: number; z: number; radius: number }> = [];
  for (let i = 0; i < clusterCount; i++) {
    const cx = (rng() - 0.5) * SPREAD_X;
    const cz = (rng() - 0.5) * SPREAD_Z;
    const radius = 40 + rng() * 120; // cluster spread radius
    clusters.push({ x: cx, z: cz, radius });
  }

  // Village center world coords -- 576x576 grid, center tile (288,288) = world origin (0,0).
  const VILLAGE_CX        = 0;
  const VILLAGE_CZ        = 0;
  const SEAWEED_INNER_R   = 280; // Hard town-center exclusion radius (wu); fits inside building ring
  const SEAWEED_SPARSE_R  = 800; // Sparse-density transition band around the town center (wu)
  const SEAWEED_INNER_R_SQ  = SEAWEED_INNER_R  * SEAWEED_INNER_R;
  const SEAWEED_SPARSE_R_SQ = SEAWEED_SPARSE_R * SEAWEED_SPARSE_R;

  let attempts = 0;
  const maxAttempts = BLADE_COUNT * 6;

  while (blades.length < BLADE_COUNT && attempts < maxAttempts) {
    attempts++;

    // Pick a random cluster to spawn near
    const cluster = clusters[Math.floor(rng() * clusters.length)];

    // Sample within cluster using 2D Gaussian approximation (Box-Muller lite)
    const angle = rng() * Math.PI * 2;
    // Use rng() - 0.5 summed twice for a triangular dist, scaled to cluster radius
    const dist = (rng() + rng()) * cluster.radius;
    const x = cluster.x + Math.cos(angle) * dist;
    const z = cluster.z + Math.sin(angle) * dist;

    // Keep within world bounds
    if (Math.abs(x) > SPREAD_X / 2 || Math.abs(z) > SPREAD_Z / 2) continue;

    // Zone-based density control around village center
    const dcx = x - VILLAGE_CX;
    const dcz = z - VILLAGE_CZ;
    const distSq = dcx * dcx + dcz * dcz;

    if (distSq < SEAWEED_INNER_R_SQ) continue;
    if (isNearBuilding(x, z)) continue;
    if (isNearParcel(x, z)) continue;
    // 2026-05-13: sparse-band acceptance bumped 0.25 → 0.5 so the seaweed
    // ring around the town reads as a forest, not a few stray blades. Still
    // sparser than the fully-dense outer area (no rejection past sparse R).
    if (distSq < SEAWEED_SPARSE_R_SQ && rng() > 0.5) continue;

    // Determine variant by ratio thresholds
    const variantRoll = rng();
    let variant: BladeVariant;
    let colors: THREE.Color[];
    let amplitude: number;
    let segs: number;

    if (variantRoll < RATIO_SHORT_GRASS) {
      variant = 'grass';
      colors = COLORS_GRASS;
      amplitude = 2.0 + rng() * 1.0; // 2–3 units sway
      segs = 4;
    } else if (variantRoll < RATIO_SHORT_GRASS + RATIO_TALL_KELP) {
      variant = 'kelp';
      colors = COLORS_KELP;
      amplitude = 6.0 + rng() * 2.0; // 6–8 units sway
      segs = 6;
    } else {
      variant = 'fern';
      colors = COLORS_FERN;
      amplitude = 3.5 + rng() * 1.5; // 3.5–5 units sway
      segs = 5;
    }

    const baseColor = colors[Math.floor(rng() * colors.length)];
    const variation = 0.80 + rng() * 0.35;

    blades.push({
      x, z,
      rotY: rng() * Math.PI * 2,
      scale: 0.9 + rng() * 1.6,
      color: new THREE.Color(
        Math.min(1, baseColor.r * variation),
        Math.min(1, baseColor.g * variation),
        Math.min(1, baseColor.b * variation),
      ),
      variant,
      amplitude,
      segs,
    });
  }

  return blades;
}

// ---------------------------------------------------------------------------
// Merge all blades into a single BufferGeometry
// ---------------------------------------------------------------------------

function createMergedSeaweedGeometry(): THREE.BufferGeometry {
  const blades = generateBlades();
  const geometries: THREE.BufferGeometry[] = [];

  const allPhases: number[] = [];
  const allHeights: number[] = [];
  const allColors: number[] = [];
  const allAmplitudes: number[] = [];

  for (const blade of blades) {
    // Build the appropriate base geometry for this variant
    let baseGeo: THREE.BufferGeometry;
    switch (blade.variant) {
      case 'grass': baseGeo = createShortGrassGeo(); break;
      case 'kelp':  baseGeo = createTallKelpGeo();  break;
      default:      baseGeo = createMediumFernGeo(); break;
    }

    const vertsPerBlade = (blade.segs + 1) * 2;

    // Apply transform
    const matrix = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, blade.rotY, 0));
    // Scale XZ slightly less than Y so blades stay slender when uniformly scaled
    const s = new THREE.Vector3(blade.scale * 0.85, blade.scale, blade.scale * 0.85);
    const p = new THREE.Vector3(blade.x, 0, blade.z);
    matrix.compose(p, q, s);
    baseGeo.applyMatrix4(matrix);

    geometries.push(baseGeo);

    // Bake per-vertex attributes
    for (let v = 0; v < vertsPerBlade; v++) {
      const row = Math.floor(v / 2);
      const heightFactor = row / blade.segs;

      allPhases.push(blade.rotY);          // unique phase per blade
      allHeights.push(heightFactor);       // 0 at root, 1 at tip
      allAmplitudes.push(blade.amplitude); // variant-specific sway

      // Base-to-tip brightness gradient: darker roots, brighter tips
      const brightness = 0.45 + heightFactor * 0.55;
      allColors.push(
        Math.min(1, blade.color.r * brightness),
        Math.min(1, blade.color.g * brightness),
        Math.min(1, blade.color.b * brightness),
      );
    }
  }

  const merged = mergeGeometries(geometries, false);
  // Dispose per-blade source geometries — merged into one buffer, keeping them leaks ~300KB GPU
  for (const g of geometries) g.dispose();
  if (!merged) {
    console.warn('[MergedSeaweed] mergeGeometries returned null');
    return new THREE.BufferGeometry();
  }

  merged.setAttribute('aPhase',     new THREE.Float32BufferAttribute(allPhases,     1));
  merged.setAttribute('aHeight',    new THREE.Float32BufferAttribute(allHeights,    1));
  merged.setAttribute('aAmplitude', new THREE.Float32BufferAttribute(allAmplitudes, 1));
  merged.setAttribute('color',      new THREE.Float32BufferAttribute(allColors,     3));

  return merged;
}

// ---------------------------------------------------------------------------
// TSL Material — GPU wind animation via positionNode
// Two waves: fast sway + slow oceanic current drift
// Amplitude is per-vertex (baked from variant type) — no CPU cost per frame
// ---------------------------------------------------------------------------

function createSeaweedMaterial(): THREE.MeshBasicNodeMaterial {
  // Mobile FPS fix (audit 2026-05-10):
  //   Was: transparent:true + DoubleSide + depthWrite:false. With 4500 blades
  //   that defeats early-Z on tile-based mobile GPUs (every blade fragment
  //   pays full TSL wave shader cost regardless of occlusion). Audit estimate
  //   was -15 to -25 FPS on mobile vs the alphaTest variant.
  //
  //   Now: opaque + alphaTest:0.5 + FrontSide. Fragments pass early-Z and
  //   blades behind blades are skipped at the rasterizer level. Visual diff
  //   on the procedural-color seaweed is minimal (the blades have no fine
  //   silhouette detail that needed soft alpha).
  const mat = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    side: THREE.FrontSide,
    transparent: false,
    alphaTest: 0.5,
  });

  // r185 @types/three widens attribute()'s inferred node type to string unless
  // the generic is explicit — without it every downstream .mul/.add fails to type.
  const phase     = attribute<'float'>('aPhase',     'float');
  const height    = attribute<'float'>('aHeight',    'float');
  const amplitude = attribute<'float'>('aAmplitude', 'float');

  // Wave 1 — primary sway (faster, directional)
  const wave1X = sin(time.mul(float(0.9)).add(phase))
    .mul(height)
    .mul(amplitude);

  const wave1Z = sin(time.mul(float(1.4)).add(phase.mul(float(1.7))))
    .mul(height)
    .mul(amplitude.mul(float(0.5)));

  // Wave 2 — slow oceanic current (much lower frequency, whole-field drift)
  const wave2X = cos(time.mul(float(0.18)).add(phase.mul(float(0.3))))
    .mul(height)
    .mul(amplitude.mul(float(0.4)));

  const wave2Z = sin(time.mul(float(0.12)).add(phase.mul(float(0.5))))
    .mul(height)
    .mul(amplitude.mul(float(0.25)));

  // Combine both waves and displace on GPU.
  // positionGeometry reads the raw per-vertex attribute directly. This mesh has
  // no skinning/morph/instancing, so it's equivalent to positionLocal — but
  // geometry is the precise intent for a vertex-stage-only displacement.
  mat.positionNode = positionGeometry.add(
    vec3(
      wave1X.add(wave2X),
      float(0),
      wave1Z.add(wave2Z),
    )
  );

  return mat;
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export default function MergedSeaweed() {
  const { geometry, material } = useMemo(() => {
    const geo = createMergedSeaweedGeometry();
    const mat = createSeaweedMaterial();
    return { geometry: geo, material: mat };
  }, []);

  // Dispose merged geometry (~3000-blade buffer) and TSL material on unmount
  // to prevent GPU memory leaks when navigating away from the game page.
  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[0, -2, 0]}
      frustumCulled={false}
    />
  );
}
