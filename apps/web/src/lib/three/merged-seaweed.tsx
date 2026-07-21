'use client';

import { useMemo, useEffect } from 'react';
import * as THREE from 'three/webgpu';
import { attribute, positionGeometry, float, sin, cos, vec3, time } from 'three/tsl';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE, buildingZones } from '@/lib/pixi/tilemap-data';
import { LAND_PARCELS } from '@clawville/shared';

// ---------------------------------------------------------------------------
// Merged Seaweed / Kelp Ground Cover
// 18,000 blades (3 shape variants) baked into ONE BufferGeometry = 1 draw call
// Wind animation via TSL positionNode (GPU vertex shader, zero CPU cost)
// NO InstancedMesh — avoids Intel Iris Xe WebGPU crash
// ---------------------------------------------------------------------------

// 2026-07-17 (kelp revival B1): 6,500→18,000 for the 704×704 world (22,528×22,528 wu).
const BLADE_COUNT = 18000;
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
// Blade variant descriptor
// ---------------------------------------------------------------------------

type BladeVariant = 'grass' | 'kelp' | 'fern';

interface BladeData {
  x: number;
  z: number;
  rotY: number;
  scale: number;
  colorR: number;
  colorG: number;
  colorB: number;
  variant: BladeVariant;
  amplitude: number; // sway amplitude baked per-blade
  segs: number;      // segment count for attribute generation
}

interface BladeShape {
  halfWidths: number[];
  bendXs: number[];
  bendZs: number[];
}

function createBladeShape(variant: BladeVariant, segs: number): BladeShape {
  const halfWidths: number[] = [];
  const bendXs: number[] = [];
  const bendZs: number[] = [];

  for (let row = 0; row <= segs; row++) {
    const t = row / segs;
    if (variant === 'grass') {
      halfWidths.push(1.5 * (1 - t * 0.75));
      bendXs.push(t * t * 0.8);
      bendZs.push(0);
    } else if (variant === 'kelp') {
      halfWidths.push(2.5 * (1 - t * 0.65));
      bendXs.push((t ** 3 * 2 - t * t * 0.5) * 4.5);
      bendZs.push(Math.sin(t * Math.PI * 0.6) * 4.5 * 0.3);
    } else {
      const taper = t < 0.5 ? 1 - t * 0.2 : 1 - t * 0.9;
      halfWidths.push(4 * taper);
      bendXs.push(t * t * 2);
      bendZs.push(Math.sin(t * Math.PI) * 2 * 0.4);
    }
  }

  return { halfWidths, bendXs, bendZs };
}

const BLADE_SHAPES: Record<BladeVariant, BladeShape> = {
  grass: createBladeShape('grass', 4),
  kelp: createBladeShape('kelp', 6),
  fern: createBladeShape('fern', 5),
};

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

  // Village center world coords -- the 704×704 grid's center is world origin (0,0).
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
      colorR: Math.min(1, baseColor.r * variation),
      colorG: Math.min(1, baseColor.g * variation),
      colorB: Math.min(1, baseColor.b * variation),
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
  let vertexCount = 0;
  let indexCount = 0;

  for (const blade of blades) {
    vertexCount += (blade.segs + 1) * 2;
    indexCount += blade.segs * 6;
  }

  // Fill the final buffers directly. Creating and merging 18,000 temporary
  // BufferGeometry/Matrix/Quaternion objects caused a visible mount hitch.
  const positions = new Float32Array(vertexCount * 3);
  const phases = new Float32Array(vertexCount);
  const heights = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 3);
  const amplitudes = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  const shapeRng = seededRandom(44117);

  let vertexOffset = 0;
  let indexOffset = 0;

  for (const blade of blades) {
    let height: number;
    switch (blade.variant) {
      case 'grass':
        height = 10 + shapeRng() * 5;
        break;
      case 'kelp':
        height = 35 + shapeRng() * 10;
        break;
      default:
        height = 20 + shapeRng() * 5;
        break;
    }

    const shape = BLADE_SHAPES[blade.variant];
    const cosY = Math.cos(blade.rotY);
    const sinY = Math.sin(blade.rotY);
    const scaleXZ = blade.scale * 0.85;
    const bladeVertexStart = vertexOffset;

    for (let row = 0; row <= blade.segs; row++) {
      const heightFactor = row / blade.segs;
      const localY = heightFactor * height;
      const halfWidth = shape.halfWidths[row];
      const bendX = shape.bendXs[row];
      const bendZ = shape.bendZs[row];

      // Base-to-tip brightness gradient: darker roots, brighter tips
      const brightness = 0.45 + heightFactor * 0.55;
      const colorR = Math.min(1, blade.colorR * brightness);
      const colorG = Math.min(1, blade.colorG * brightness);
      const colorB = Math.min(1, blade.colorB * brightness);

      for (let side = 0; side < 2; side++) {
        const localX = bendX + (side === 0 ? -halfWidth : halfWidth);
        const scaledX = localX * scaleXZ;
        const scaledZ = bendZ * scaleXZ;
        const positionOffset = vertexOffset * 3;

        positions[positionOffset] = blade.x + scaledX * cosY + scaledZ * sinY;
        positions[positionOffset + 1] = localY * blade.scale;
        positions[positionOffset + 2] = blade.z - scaledX * sinY + scaledZ * cosY;
        phases[vertexOffset] = blade.rotY;
        heights[vertexOffset] = heightFactor;
        amplitudes[vertexOffset] = blade.amplitude;
        colors[positionOffset] = colorR;
        colors[positionOffset + 1] = colorG;
        colors[positionOffset + 2] = colorB;
        vertexOffset++;
      }
    }

    for (let segment = 0; segment < blade.segs; segment++) {
      const a = bladeVertexStart + segment * 2;
      indices[indexOffset++] = a;
      indices[indexOffset++] = a + 2;
      indices[indexOffset++] = a + 1;
      indices[indexOffset++] = a + 1;
      indices[indexOffset++] = a + 2;
      indices[indexOffset++] = a + 3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1));
  geometry.setAttribute('aAmplitude', new THREE.BufferAttribute(amplitudes, 1));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
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

  // Dispose merged geometry (18,000-blade buffer) and TSL material on unmount
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
