'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { attribute, cos, float, positionLocal, sin, time, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  KELP_MAZE_BOUNDS,
  KELP_MAZE_ENTRY,
  KELP_MAZE_LANDMARK,
  KELP_MAZE_PATH_WIDTH_WU,
  KELP_MAZE_WALLS,
} from '@clawville/shared';

export const KELP_FOREST_CENTER = Object.freeze({ x: 7808, z: -9900 });
export const KELP_FOREST_SIZE_WU = 48 * 32;
export const KELP_FOREST_BLADE_COUNT = 5400;

const BLADES_PER_VARIANT = KELP_FOREST_BLADE_COUNT / 3;
const GRID_COLUMNS = 75;
const GRID_ROWS = 72;
const HEIGHT_SEGMENTS = 8;
const MAX_WIND_DISPLACEMENT_WU = 24;
const WALL_ROW_OFFSETS = [-8, 0, 8] as const;
const WALL_BLADE_SPACING_WU = 10;

function wallBladeCount(halfX: number, halfZ: number): number {
  const length = Math.max(halfX, halfZ) * 2;
  return (Math.ceil(length / WALL_BLADE_SPACING_WU) + 1) * WALL_ROW_OFFSETS.length;
}

export const KELP_MAZE_WALL_BLADE_COUNT = KELP_MAZE_WALLS.reduce(
  (total, wall) => total + wallBladeCount(wall.halfX, wall.halfZ),
  0,
);
export const KELP_FOREST_TOTAL_BLADE_COUNT =
  KELP_FOREST_BLADE_COUNT + KELP_MAZE_WALL_BLADE_COUNT;

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

function isAmbientCarved(localX: number, localZ: number): boolean {
  const worldX = localX + KELP_FOREST_CENTER.x;
  const worldZ = localZ + KELP_FOREST_CENTER.z;
  const insideMaze = worldX >= KELP_MAZE_BOUNDS.minX
    && worldX <= KELP_MAZE_BOUNDS.maxX
    && worldZ >= KELP_MAZE_BOUNDS.minZ
    && worldZ <= KELP_MAZE_BOUNDS.maxZ;
  const insideEntryApproach = Math.abs(worldX - KELP_MAZE_ENTRY.centerX)
      <= KELP_MAZE_PATH_WIDTH_WU / 2 + MAX_WIND_DISPLACEMENT_WU
    && worldZ >= KELP_MAZE_BOUNDS.maxZ
    && worldZ <= KELP_FOREST_CENTER.z + KELP_FOREST_SIZE_WU / 2;
  return insideMaze || insideEntryApproach;
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
      let x = -KELP_FOREST_SIZE_WU / 2 + (column + 0.5) * cellWidth
        + (rng() - 0.5) * cellWidth * 0.76;
      let z = -KELP_FOREST_SIZE_WU / 2 + (row + 0.5) * cellDepth
        + (rng() - 0.5) * cellDepth * 0.76;

      // Preserve exactly 5,400 ambient blades while opening the whole maze
      // footprint, clearing, and south approach. Rejected lattice blades are
      // deterministically relocated elsewhere in the forest footprint.
      while (isAmbientCarved(x, z)) {
        x = (rng() - 0.5) * KELP_FOREST_SIZE_WU;
        z = (rng() - 0.5) * KELP_FOREST_SIZE_WU;
      }

      placements.push(createPlacement(variant, rng, x, z));
    }

    return placements;
  });
}

function generateWallPlacements(): KelpBladePlacement[][] {
  const rng = seededRandom(0x4d415a45);
  const placements = KELP_VARIANTS.map(() => [] as KelpBladePlacement[]);
  let bladeIndex = 0;

  for (const wall of KELP_MAZE_WALLS) {
    const horizontal = wall.halfX >= wall.halfZ;
    const halfLength = horizontal ? wall.halfX : wall.halfZ;
    const steps = Math.ceil((halfLength * 2) / WALL_BLADE_SPACING_WU);
    // Inset visual endpoints without changing collider geometry or blade count.
    // This adds 16 wu to every visible gap so 24-wu wind sway cannot visually
    // seal a physically open 75-wu passage at its narrowest moment.
    const visualHalfLength = Math.max(0, halfLength - 8);

    for (const rowOffset of WALL_ROW_OFFSETS) {
      for (let step = 0; step <= steps; step++) {
        const variantIndex = bladeIndex % KELP_VARIANTS.length;
        const variant = KELP_VARIANTS[variantIndex]!;
        const along = -visualHalfLength + (step / steps) * visualHalfLength * 2
          + (step === 0 || step === steps ? 0 : (rng() - 0.5) * 3);
        const across = rowOffset + (rng() - 0.5) * 1.5;
        const worldX = horizontal ? wall.centerX + along : wall.centerX + across;
        const worldZ = horizontal ? wall.centerZ + across : wall.centerZ + along;

        placements[variantIndex]!.push(createPlacement(
          variant,
          rng,
          worldX - KELP_FOREST_CENTER.x,
          worldZ - KELP_FOREST_CENTER.z,
        ));
        bladeIndex++;
      }
    }
  }

  return placements;
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
    const normalizedHeight = positions.getY(index) / blade.height;
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

function setSolidVertexColor(geometry: THREE.BufferGeometry, hex: number): void {
  const vertexCount = geometry.getAttribute('position').count;
  const value = new THREE.Color(hex);
  const colors = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index++) {
    colors[index * 3] = value.r;
    colors[index * 3 + 1] = value.g;
    colors[index * 3 + 2] = value.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function createLandmarkGeometry(): THREE.BufferGeometry {
  const localX = KELP_MAZE_LANDMARK.worldX - KELP_FOREST_CENTER.x;
  const localZ = KELP_MAZE_LANDMARK.worldZ - KELP_FOREST_CENTER.z;
  const sources: THREE.BufferGeometry[] = [];

  let merged: THREE.BufferGeometry | null = null;
  try {
    const pearl = new THREE.SphereGeometry(64, 24, 16);
    sources.push(pearl);
    pearl.translate(localX, 72, localZ);
    setSolidVertexColor(pearl, 0xb9fff0);

    const shellBowl = new THREE.SphereGeometry(100, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    sources.push(shellBowl);
    shellBowl.scale(1.2, 0.36, 0.86);
    shellBowl.translate(localX, 14, localZ + 8);
    setSolidVertexColor(shellBowl, 0x5f8f7c);

    const shellFan = new THREE.TorusGeometry(108, 17, 10, 32, Math.PI * 1.5);
    sources.push(shellFan);
    shellFan.rotateZ(-Math.PI * 0.75);
    shellFan.translate(localX, 72, localZ + 24);
    setSolidVertexColor(shellFan, 0x3b756c);

    const shellLip = new THREE.TorusGeometry(78, 13, 8, 28, Math.PI * 1.35);
    sources.push(shellLip);
    shellLip.rotateX(Math.PI / 2);
    shellLip.rotateZ(-Math.PI * 0.68);
    shellLip.translate(localX, 28, localZ - 24);
    setSolidVertexColor(shellLip, 0x76aa8f);

    merged = mergeGeometries(sources, false);
    if (!merged) throw new Error('Kelp maze landmark geometry could not be merged');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  } catch (error) {
    merged?.dispose();
    throw error;
  } finally {
    for (const source of sources) source.dispose();
  }
}

function createLandmarkMaterial(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.08,
  });
  try {
    const pulse = float(0.26).add(sin(time.mul(float(0.52))).mul(float(0.07)));
    material.emissiveNode = vec3(float(0.18), float(0.72), float(0.62)).mul(pulse);
    return material;
  } catch (error) {
    material.dispose();
    throw error;
  }
}

function createLandmarkResource(): {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardNodeMaterial;
} {
  const geometry = createLandmarkGeometry();
  try {
    return { geometry, material: createLandmarkMaterial() };
  } catch (error) {
    geometry.dispose();
    throw error;
  }
}

export default function KelpForest() {
  const resources = useMemo(() => {
    const placements = generatePlacements();
    const wallPlacements = generateWallPlacements();
    for (let index = 0; index < placements.length; index++) {
      placements[index]!.push(...wallPlacements[index]!);
    }
    const created: Array<{
      geometry: THREE.BufferGeometry;
      material: THREE.MeshStandardNodeMaterial;
    }> = [];

    try {
      for (let index = 0; index < KELP_VARIANTS.length; index++) {
        const variant = KELP_VARIANTS[index];
        const geometry = createVariantGeometry(placements[index], variant);
        let material: THREE.MeshStandardNodeMaterial;
        try {
          material = createVariantMaterial(variant);
        } catch (error) {
          geometry.dispose();
          throw error;
        }
        created.push({ geometry, material });
      }
      return { variants: created, landmark: createLandmarkResource() };
    } catch (error) {
      for (const resource of created) {
        resource.geometry.dispose();
        resource.material.dispose();
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    return () => {
      for (const resource of resources.variants) {
        resource.geometry.dispose();
        resource.material.dispose();
      }
      resources.landmark.geometry.dispose();
      resources.landmark.material.dispose();
    };
  }, [resources]);

  return (
    <group position={[KELP_FOREST_CENTER.x, -2, KELP_FOREST_CENTER.z]}>
      {resources.variants.map((resource, index) => (
        <mesh
          key={index}
          geometry={resource.geometry}
          material={resource.material}
          matrixAutoUpdate={false}
        />
      ))}
      <mesh
        name="kelp-maze-pearl-shell-landmark"
        geometry={resources.landmark.geometry}
        material={resources.landmark.material}
        matrixAutoUpdate={false}
      />
    </group>
  );
}
