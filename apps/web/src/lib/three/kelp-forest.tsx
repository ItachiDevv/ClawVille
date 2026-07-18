'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { attribute, cos, float, positionLocal, sin, time, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const KELP_FOREST_CENTER = Object.freeze({ x: 7808, z: -9900 });
export const KELP_FOREST_SIZE_WU = 48 * 32;
export const KELP_FOREST_BLADE_COUNT = 5400;

const BLADES_PER_VARIANT = KELP_FOREST_BLADE_COUNT / 3;
const GRID_COLUMNS = 75;
const GRID_ROWS = 72;
const HEIGHT_SEGMENTS = 8;
const MAX_WIND_DISPLACEMENT_WU = 24;

interface KelpVariant {
  heightMin: number;
  heightMax: number;
  widthMin: number;
  widthMax: number;
  bendMin: number;
  bendMax: number;
  rootColor: THREE.Color;
  tipColor: THREE.Color;
  windAmplitude: number;
  windRate: number;
}

interface KelpBladePlacement {
  x: number;
  z: number;
  rotationY: number;
  height: number;
  width: number;
  bend: number;
  phase: number;
  colorScale: number;
}

const KELP_VARIANTS: readonly KelpVariant[] = [
  {
    heightMin: 135,
    heightMax: 148,
    widthMin: 11,
    widthMax: 16,
    bendMin: 7,
    bendMax: 12,
    rootColor: new THREE.Color(0x063b38),
    tipColor: new THREE.Color(0x168c78),
    windAmplitude: 13,
    windRate: 0.24,
  },
  {
    heightMin: 150,
    heightMax: 164,
    widthMin: 13,
    widthMax: 18,
    bendMin: 9,
    bendMax: 15,
    rootColor: new THREE.Color(0x073f32),
    tipColor: new THREE.Color(0x23996f),
    windAmplitude: 15,
    windRate: 0.2,
  },
  {
    heightMin: 166,
    heightMax: 180,
    widthMin: 15,
    widthMax: 20,
    bendMin: 11,
    bendMax: 18,
    rootColor: new THREE.Color(0x052f35),
    tipColor: new THREE.Color(0x147f83),
    windAmplitude: 17,
    windRate: 0.16,
  },
] as const;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function createPlacement(
  variant: KelpVariant,
  rng: () => number,
  x: number,
  z: number,
): KelpBladePlacement {
  return {
    x,
    z,
    rotationY: rng() * Math.PI * 2,
    height: variant.heightMin + rng() * (variant.heightMax - variant.heightMin),
    width: variant.widthMin + rng() * (variant.widthMax - variant.widthMin),
    bend: variant.bendMin + rng() * (variant.bendMax - variant.bendMin),
    phase: rng() * Math.PI * 2,
    colorScale: 0.84 + rng() * 0.24,
  };
}

function generatePlacements(): KelpBladePlacement[][] {
  const rng = seededRandom(0x4b454c50);
  const cellWidth = KELP_FOREST_SIZE_WU / GRID_COLUMNS;
  const cellDepth = KELP_FOREST_SIZE_WU / GRID_ROWS;
  const cells = Array.from({ length: KELP_FOREST_BLADE_COUNT }, (_, index) => index);

  // Shuffle the fixed lattice before splitting it into thirds. This preserves
  // exactly 1,800 blades per variant without producing visible variant bands.
  for (let index = cells.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [cells[index], cells[swapIndex]] = [cells[swapIndex], cells[index]];
  }

  return KELP_VARIANTS.map((variant, variantIndex) => {
    const placements: KelpBladePlacement[] = [];
    const start = variantIndex * BLADES_PER_VARIANT;

    for (let offset = 0; offset < BLADES_PER_VARIANT; offset++) {
      const cellIndex = cells[start + offset];
      const column = cellIndex % GRID_COLUMNS;
      const row = Math.floor(cellIndex / GRID_COLUMNS);
      const x = -KELP_FOREST_SIZE_WU / 2 + (column + 0.5) * cellWidth
        + (rng() - 0.5) * cellWidth * 0.76;
      const z = -KELP_FOREST_SIZE_WU / 2 + (row + 0.5) * cellDepth
        + (rng() - 0.5) * cellDepth * 0.76;

      placements.push(createPlacement(variant, rng, x, z));
    }

    return placements;
  });
}

function createBladeGeometry(
  blade: KelpBladePlacement,
  variant: KelpVariant,
): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(
    blade.width,
    blade.height,
    1,
    HEIGHT_SEGMENTS,
  );
  geometry.translate(0, blade.height / 2, 0);

  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  const phases = new Float32Array(positions.count);
  const heights = new Float32Array(positions.count);
  const color = new THREE.Color();

  for (let index = 0; index < positions.count; index++) {
    // Clamp: after translate(0, height/2, 0) the root row's float32 y lands a
    // few ULP below zero for ~half of all heights, and Math.pow(negative,
    // 1.45) is NaN — which poisoned both root verts (bottom segment dropped,
    // bounding box/sphere NaN, frustum culling broken) on ~50% of blades.
    const normalizedHeight = Math.min(1, Math.max(0, positions.getY(index) / blade.height));
    const taper = 1 - Math.pow(normalizedHeight, 1.45) * 0.82;
    const curve = Math.sin(normalizedHeight * Math.PI * 0.72) * blade.bend;

    positions.setX(index, positions.getX(index) * taper);
    positions.setZ(index, curve);
    phases[index] = blade.phase;
    heights[index] = normalizedHeight;

    color.lerpColors(variant.rootColor, variant.tipColor, normalizedHeight);
    colors[index * 3] = Math.min(1, color.r * blade.colorScale);
    colors[index * 3 + 1] = Math.min(1, color.g * blade.colorScale);
    colors[index * 3 + 2] = Math.min(1, color.b * blade.colorScale);
  }

  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.rotateY(blade.rotationY);
  geometry.translate(blade.x, 0, blade.z);
  return geometry;
}

function createVariantGeometry(
  placements: readonly KelpBladePlacement[],
  variant: KelpVariant,
): THREE.BufferGeometry {
  const sourceGeometries: THREE.BufferGeometry[] = [];
  let merged: THREE.BufferGeometry | null = null;

  try {
    for (const blade of placements) {
      sourceGeometries.push(createBladeGeometry(blade, variant));
    }
    merged = mergeGeometries(sourceGeometries, false);
    if (!merged) throw new Error('Kelp Forest blade geometries could not be merged');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    if (merged.boundingBox) {
      merged.boundingBox.min.x -= MAX_WIND_DISPLACEMENT_WU;
      merged.boundingBox.min.z -= MAX_WIND_DISPLACEMENT_WU;
      merged.boundingBox.max.x += MAX_WIND_DISPLACEMENT_WU;
      merged.boundingBox.max.z += MAX_WIND_DISPLACEMENT_WU;
    }
    if (merged.boundingSphere) merged.boundingSphere.radius += MAX_WIND_DISPLACEMENT_WU;
    return merged;
  } catch (error) {
    merged?.dispose();
    throw error;
  } finally {
    // Source planes are CPU-only merge inputs. Dispose on success, throw, or
    // null return so a failed remount cannot accumulate geometry allocations.
    for (const geometry of sourceGeometries) geometry.dispose();
  }
}

function createVariantMaterial(variant: KelpVariant): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.88,
    metalness: 0,
  });
  try {
    const phase = attribute<'float'>('aPhase', 'float');
    const height = attribute<'float'>('aHeight', 'float');

    // Tall forest kelp moves as a heavy water-loaded ribbon: both waves are
    // deliberately slower than the ambient seaweed and strongest at the tip.
    const primaryX = sin(time.mul(float(variant.windRate)).add(phase))
      .mul(height.mul(height))
      .mul(float(variant.windAmplitude));
    const primaryZ = cos(time.mul(float(variant.windRate * 0.72)).add(phase.mul(float(1.31))))
      .mul(height.mul(height))
      .mul(float(variant.windAmplitude * 0.48));
    const currentX = cos(time.mul(float(0.055)).add(phase.mul(float(0.37))))
      .mul(height)
      .mul(float(variant.windAmplitude * 0.22));
    const currentZ = sin(time.mul(float(0.043)).add(phase.mul(float(0.51))))
      .mul(height)
      .mul(float(variant.windAmplitude * 0.16));

    material.positionNode = positionLocal.add(
      vec3(primaryX.add(currentX), float(0), primaryZ.add(currentZ)),
    );
    return material;
  } catch (error) {
    material.dispose();
    throw error;
  }
}

interface KelpVariantResource {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardNodeMaterial;
}

function createVariantResources(
  placements: readonly KelpBladePlacement[][],
): KelpVariantResource[] {
  const created: KelpVariantResource[] = [];

  try {
    for (let index = 0; index < KELP_VARIANTS.length; index++) {
      const variant = KELP_VARIANTS[index]!;
      const geometry = createVariantGeometry(placements[index]!, variant);
      try {
        const material = createVariantMaterial(variant);
        created.push({ geometry, material });
      } catch (error) {
        geometry.dispose();
        throw error;
      }
    }
    return created;
  } catch (error) {
    for (const resource of created) {
      resource.geometry.dispose();
      resource.material.dispose();
    }
    throw error;
  }
}

function useDisposableVariantResources(
  placementsFactory: () => KelpBladePlacement[][],
): KelpVariantResource[] {
  const resources = useMemo(() => {
    return createVariantResources(placementsFactory());
  }, [placementsFactory]);

  useEffect(() => {
    return () => {
      for (const resource of resources) {
        resource.geometry.dispose();
        resource.material.dispose();
      }
    };
  }, [resources]);

  return resources;
}

export function KelpForestAmbient() {
  const resources = useDisposableVariantResources(generatePlacements);

  return (
    <group position={[KELP_FOREST_CENTER.x, -2, KELP_FOREST_CENTER.z]}>
      {resources.map((resource, index) => (
        <mesh
          key={index}
          geometry={resource.geometry}
          material={resource.material}
          matrixAutoUpdate={false}
        />
      ))}
    </group>
  );
}
