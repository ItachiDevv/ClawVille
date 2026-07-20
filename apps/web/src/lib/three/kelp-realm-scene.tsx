'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { attribute, cos, float, fract, positionLocal, sin, time, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  KELP_REALM_BEACON_GRAPH,
  KELP_REALM_CELL_WU,
  KELP_REALM_CENTER,
  KELP_REALM_DEAD_END_DISCOVERIES,
  KELP_REALM_DISCOVERY_TYPES,
  KELP_REALM_FOOTPRINT_WU,
  KELP_REALM_MAX_AUTHORED_BEND_WU,
  KELP_REALM_MAX_BLADE_HALF_WIDTH_WU,
  KELP_REALM_MAX_SWAY_WU,
  KELP_REALM_ONE_SIDED_SWAY_WU,
  KELP_REALM_SPORE_BEACON_IDS,
  KELP_REALM_WALL_ROOT_SETBACK_WU,
  KELP_REALM_WALL_AABBS,
  KELP_REALM_WALL_HEIGHT_WU,
  isKelpRealmCorridorCell,
  type KelpRealmDiscoveryType,
} from '@clawville/shared';
import KelpRealmPlayer from './kelp-realm-player';
import { subscribeKelpRealmBeaconVisits } from './kelp-realm-visit-state';

const BLADE_COUNT = 15_000;
const BLADES_PER_VARIANT = BLADE_COUNT / 3;
const BLADE_ROWS = 8;
const FOG_COLOR = new THREE.Color(0x031b20);
const REALM_WIND = Object.freeze({
  primaryZRateScale: 0.71,
  primaryZPhaseScale: 1.27,
  primaryZAmplitudeScale: 0.42,
  currentXRate: 0.041,
  currentXPhaseScale: 0.43,
  currentXAmplitudeScale: 0.16,
  currentZRate: 0.037,
  currentZPhaseScale: 0.59,
  currentZAmplitudeScale: 0.12,
});
const MAX_PRIMARY_AMPLITUDE_WU =
  KELP_REALM_ONE_SIDED_SWAY_WU / (1 + REALM_WIND.currentXAmplitudeScale);

interface RealmKelpVariant {
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly root: THREE.Color;
  readonly tip: THREE.Color;
  readonly amplitude: number;
  readonly rate: number;
}

const VARIANTS: readonly RealmKelpVariant[] = Object.freeze([
  { minHeight: 650, maxHeight: 780, minWidth: 22, maxWidth: 34, root: new THREE.Color(0x052d27), tip: new THREE.Color(0x16886d), amplitude: MAX_PRIMARY_AMPLITUDE_WU * 0.78, rate: Math.PI * 2 / 5.8 },
  { minHeight: 600, maxHeight: 750, minWidth: 25, maxWidth: KELP_REALM_MAX_BLADE_HALF_WIDTH_WU * 2, root: new THREE.Color(0x07372d), tip: new THREE.Color(0x24a16e), amplitude: MAX_PRIMARY_AMPLITUDE_WU * 0.86, rate: Math.PI * 2 / 5.2 },
  { minHeight: 680, maxHeight: 800, minWidth: 19, maxWidth: 31, root: new THREE.Color(0x042d34), tip: new THREE.Color(0x138b83), amplitude: MAX_PRIMARY_AMPLITUDE_WU, rate: Math.PI * 2 / 4.6 },
]);

interface WindUniform { value: number }
interface KelpResource {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly windUniform: WindUniform | null;
}

interface DiscoveryResource {
  readonly type: KelpRealmDiscoveryType;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly timeUniform: WindUniform | null;
}

const DISCOVERY_ANIMATION = Object.freeze({
  jellyfish: Object.freeze({
    bobRate: 0.55,
    bobAmplitude: 18,
    driftXRate: 0.35,
    driftXAmplitude: 12,
    driftZRate: 0.29,
    driftZAmplitude: 9,
    ribbonRate: 0.7,
    ribbonAmplitude: 3,
  }),
  anemone: Object.freeze({
    swayXRate: 0.8,
    swayXAmplitude: 10,
    swayZRate: 0.63,
    swayZAmplitude: 7,
    pulseRate: 1.1,
    pulseAmplitude: 4,
  }),
  clam: Object.freeze({
    riseRate: 0.08,
    riseSpan: 220,
    driftRate: 0.4,
    driftAmplitude: 7,
  }),
});

const DISCOVERY_STYLE = Object.freeze({
  jellyfish: Object.freeze({ color: 0x8acbff, opacity: 0.52 }),
  anemone: Object.freeze({ color: 0xff78cf, opacity: 0.62 }),
  clam: Object.freeze({ color: 0x9fffe7, opacity: 0.58 }),
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function applyRealmWind(
  material: { positionNode: THREE.Node | null },
  variant: RealmKelpVariant,
): void {
  const phase = attribute<'float'>('aPhase', 'float');
  const height = attribute<'float'>('aHeight', 'float');
  const primaryX = sin(time.mul(float(variant.rate)).add(phase))
    .mul(height.mul(height)).mul(float(variant.amplitude));
  const primaryZ = cos(time.mul(float(variant.rate * REALM_WIND.primaryZRateScale)).add(phase.mul(float(REALM_WIND.primaryZPhaseScale))))
    .mul(height.mul(height)).mul(float(variant.amplitude * REALM_WIND.primaryZAmplitudeScale));
  const currentX = cos(time.mul(float(REALM_WIND.currentXRate)).add(phase.mul(float(REALM_WIND.currentXPhaseScale))))
    .mul(height).mul(float(variant.amplitude * REALM_WIND.currentXAmplitudeScale));
  const currentZ = sin(time.mul(float(REALM_WIND.currentZRate)).add(phase.mul(float(REALM_WIND.currentZPhaseScale))))
    .mul(height).mul(float(variant.amplitude * REALM_WIND.currentZAmplitudeScale));
  material.positionNode = positionLocal.add(
    vec3(primaryX.add(currentX), float(0), primaryZ.add(currentZ)),
  );
}

function createRealmKelpGeometry(variantIndex: number): THREE.BufferGeometry {
  const variant = VARIANTS[variantIndex]!;
  const rng = seededRandom(0x4b465200 + variantIndex * 911);
  const verticesPerBlade = BLADE_ROWS * 2;
  const trianglesPerBlade = (BLADE_ROWS - 1) * 2;
  const positions = new Float32Array(BLADES_PER_VARIANT * verticesPerBlade * 3);
  const colors = new Float32Array(positions.length);
  const phases = new Float32Array(BLADES_PER_VARIANT * verticesPerBlade);
  const heights = new Float32Array(BLADES_PER_VARIANT * verticesPerBlade);
  const indices = new Uint32Array(BLADES_PER_VARIANT * trianglesPerBlade * 3);
  const color = new THREE.Color();

  for (let blade = 0; blade < BLADES_PER_VARIANT; blade++) {
    const wall = KELP_REALM_WALL_AABBS[(blade * 37 + variantIndex * 17) % KELP_REALM_WALL_AABBS.length]!;
    // Keep roots 60 wu back from every corridor-facing cell edge. The shared
    // sway + authored-radius budget leaves 66.9 wu between opposing tips.
    const corridorRootLimit = KELP_REALM_CELL_WU / 2 - KELP_REALM_WALL_ROOT_SETBACK_WU;
    const minX = isKelpRealmCorridorCell(wall.row, wall.col - 1) ? -corridorRootLimit : -96;
    const maxX = isKelpRealmCorridorCell(wall.row, wall.col + 1) ? corridorRootLimit : 96;
    const minZ = isKelpRealmCorridorCell(wall.row - 1, wall.col) ? -corridorRootLimit : -96;
    const maxZ = isKelpRealmCorridorCell(wall.row + 1, wall.col) ? corridorRootLimit : 96;
    const x = wall.centerX + minX + rng() * (maxX - minX);
    const z = wall.centerZ + minZ + rng() * (maxZ - minZ);
    const bladeHeight = variant.minHeight + rng() * (variant.maxHeight - variant.minHeight);
    const width = variant.minWidth + rng() * (variant.maxWidth - variant.minWidth);
    const bend = 10 + rng() * (KELP_REALM_MAX_AUTHORED_BEND_WU - 10);
    const rotation = rng() * Math.PI * 2;
    const phase = rng() * Math.PI * 2;
    const cosRotation = Math.cos(rotation);
    const sinRotation = Math.sin(rotation);

    for (let row = 0; row < BLADE_ROWS; row++) {
      const normalizedHeight = Math.min(1, Math.max(0, row / (BLADE_ROWS - 1)));
      const taper = 1 - Math.pow(normalizedHeight, 1.45) * 0.86;
      const curve = Math.sin(normalizedHeight * Math.PI * 0.72) * bend;
      color.lerpColors(variant.root, variant.tip, normalizedHeight);
      for (let side = 0; side < 2; side++) {
        const vertex = blade * verticesPerBlade + row * 2 + side;
        const localX = (side === 0 ? -0.5 : 0.5) * width * taper;
        const localZ = curve;
        positions[vertex * 3] = x + localX * cosRotation + localZ * sinRotation;
        positions[vertex * 3 + 1] = normalizedHeight * bladeHeight;
        positions[vertex * 3 + 2] = z - localX * sinRotation + localZ * cosRotation;
        colors[vertex * 3] = color.r;
        colors[vertex * 3 + 1] = color.g;
        colors[vertex * 3 + 2] = color.b;
        phases[vertex] = phase;
        heights[vertex] = normalizedHeight;
      }
    }

    for (let row = 0; row < BLADE_ROWS - 1; row++) {
      const vertex = blade * verticesPerBlade + row * 2;
      const index = (blade * trianglesPerBlade + row * 2) * 3;
      indices[index] = vertex;
      indices[index + 1] = vertex + 1;
      indices[index + 2] = vertex + 2;
      indices[index + 3] = vertex + 1;
      indices[index + 4] = vertex + 3;
      indices[index + 5] = vertex + 2;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  if (geometry.boundingBox) {
    geometry.boundingBox.min.x -= KELP_REALM_MAX_SWAY_WU;
    geometry.boundingBox.min.z -= KELP_REALM_MAX_SWAY_WU;
    geometry.boundingBox.max.x += KELP_REALM_MAX_SWAY_WU;
    geometry.boundingBox.max.z += KELP_REALM_MAX_SWAY_WU;
  }
  if (geometry.boundingSphere) geometry.boundingSphere.radius += KELP_REALM_MAX_SWAY_WU;
  return geometry;
}

function createKelpMaterial(variant: RealmKelpVariant, forceWebGL: boolean): Pick<KelpResource, 'material' | 'windUniform'> {
  if (!forceWebGL) {
    const material = new THREE.MeshStandardNodeMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
    });
    applyRealmWind(material, variant);
    return { material, windUniform: null };
  }

  const windUniform: WindUniform = { value: 0 };
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uKelpTime = windUniform;
    shader.vertexShader = `uniform float uKelpTime;\nattribute float aPhase;\nattribute float aHeight;\n${shader.vertexShader}`;
    const anchor = '#include <begin_vertex>';
    if (!shader.vertexShader.includes(anchor)) throw new Error('Kelp realm WebGL wind anchor missing');
    shader.vertexShader = shader.vertexShader.replace(anchor, `${anchor}
float h2 = aHeight * aHeight;
transformed.x += sin(uKelpTime * ${variant.rate.toFixed(6)} + aPhase) * h2 * ${variant.amplitude.toFixed(6)};
transformed.z += cos(uKelpTime * ${(variant.rate * REALM_WIND.primaryZRateScale).toFixed(6)} + aPhase * ${REALM_WIND.primaryZPhaseScale.toFixed(6)}) * h2 * ${(variant.amplitude * REALM_WIND.primaryZAmplitudeScale).toFixed(6)};
transformed.x += cos(uKelpTime * ${REALM_WIND.currentXRate.toFixed(6)} + aPhase * ${REALM_WIND.currentXPhaseScale.toFixed(6)}) * aHeight * ${(variant.amplitude * REALM_WIND.currentXAmplitudeScale).toFixed(6)};
transformed.z += sin(uKelpTime * ${REALM_WIND.currentZRate.toFixed(6)} + aPhase * ${REALM_WIND.currentZPhaseScale.toFixed(6)}) * aHeight * ${(variant.amplitude * REALM_WIND.currentZAmplitudeScale).toFixed(6)};`);
  };
  material.customProgramCacheKey = () => `kelp-realm-wind-v1-${variantIndexKey(variant)}`;
  // WebGPURenderer(forceWebGL) converts this standard material to a node
  // material before GLSLNodeBuilder runs, so retain the classic GLSL hook and
  // carry the exact node displacement for the live fallback backend as well.
  applyRealmWind(material as THREE.MeshStandardMaterial & { positionNode: THREE.Node | null }, variant);
  return { material, windUniform };
}

function variantIndexKey(variant: RealmKelpVariant): string {
  return `${variant.amplitude}-${variant.rate}`;
}

function useKelpResources(forceWebGL: boolean): readonly KelpResource[] {
  const resources = useMemo(() => VARIANTS.map((variant, index) => {
    const geometry = createRealmKelpGeometry(index);
    try {
      return { geometry, ...createKelpMaterial(variant, forceWebGL) };
    } catch (error) {
      geometry.dispose();
      throw error;
    }
  }), [forceWebGL]);

  useEffect(() => () => {
    for (const resource of resources) {
      resource.geometry.dispose();
      resource.material.dispose();
    }
  }, [resources]);
  return resources;
}

function createFloorGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(KELP_REALM_FOOTPRINT_WU * 1.25, KELP_REALM_FOOTPRINT_WU * 1.25, 48, 48);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -4, 0);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index);
    const z = position.getZ(index);
    const hash = Math.sin(x * 0.017 + z * 0.011) * 0.5 + Math.sin(x * 0.006 - z * 0.019) * 0.5;
    const shade = 0.72 + hash * 0.08;
    colors[index * 3] = 0.08 * shade;
    colors[index * 3 + 1] = 0.20 * shade;
    colors[index * 3 + 2] = 0.18 * shade;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function createRayGeometry(): THREE.BufferGeometry {
  const sources: THREE.BufferGeometry[] = [];
  try {
    for (let index = 0; index < 5; index++) {
      const geometry = new THREE.ConeGeometry(85 + index * 13, 1450, 5, 1, true);
      geometry.rotateZ((index - 2) * 0.055);
      geometry.translate((index - 2) * 390, 620, -180 + (index % 2) * 330);
      sources.push(geometry);
    }
    const merged = mergeGeometries(sources, false);
    if (!merged) throw new Error('Kelp realm rays could not be merged');
    return merged;
  } finally {
    for (const geometry of sources) geometry.dispose();
  }
}

export function createKelpRealmRayMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0x7effd8,
    transparent: true,
    opacity: 0.045,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.forceSinglePass = true;
  return material;
}

type DiscoveryWeightMode = 'none' | 'tip' | 'tail';

function setDiscoveryAttributes(
  geometry: THREE.BufferGeometry,
  phase: number,
  weightMode: DiscoveryWeightMode = 'none',
  bubble = 0,
  progress = 0,
): void {
  geometry.computeBoundingBox();
  const position = geometry.getAttribute('position');
  const minY = geometry.boundingBox?.min.y ?? 0;
  const maxY = geometry.boundingBox?.max.y ?? minY;
  const spanY = Math.max(1, maxY - minY);
  const phases = new Float32Array(position.count);
  const weights = new Float32Array(position.count);
  const bubbles = new Float32Array(position.count);
  const progresses = new Float32Array(position.count);
  for (let index = 0; index < position.count; index++) {
    phases[index] = phase;
    const normalizedY = Math.min(1, Math.max(0, (position.getY(index) - minY) / spanY));
    weights[index] = weightMode === 'tip' ? normalizedY : weightMode === 'tail' ? 1 - normalizedY : 0;
    bubbles[index] = bubble;
    progresses[index] = progress;
  }
  geometry.setAttribute('aDiscoveryPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aDiscoveryWeight', new THREE.BufferAttribute(weights, 1));
  geometry.setAttribute('aDiscoveryBubble', new THREE.BufferAttribute(bubbles, 1));
  geometry.setAttribute('aDiscoveryProgress', new THREE.BufferAttribute(progresses, 1));
}

function mergeDiscoverySources(
  sources: THREE.BufferGeometry[],
  type: KelpRealmDiscoveryType,
): THREE.BufferGeometry {
  try {
    const merged = mergeGeometries(sources, false);
    if (!merged) throw new Error(`Kelp realm ${type} discovery geometry could not be merged`);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const expansion = type === 'jellyfish'
      ? { x: 15, y: 18, z: 12 }
      : type === 'anemone'
        ? { x: 10, y: 4, z: 7 }
        : { x: 7, y: 220, z: 7 };
    if (merged.boundingBox) {
      merged.boundingBox.min.x -= expansion.x;
      merged.boundingBox.min.y -= expansion.y;
      merged.boundingBox.min.z -= expansion.z;
      merged.boundingBox.max.x += expansion.x;
      merged.boundingBox.max.y += expansion.y;
      merged.boundingBox.max.z += expansion.z;
    }
    if (merged.boundingSphere) {
      merged.boundingSphere.radius += Math.max(expansion.x, expansion.y, expansion.z);
    }
    return merged;
  } finally {
    for (const geometry of sources) geometry.dispose();
  }
}

function createJellyfishDiscoveryGeometry(): THREE.BufferGeometry {
  const sources: THREE.BufferGeometry[] = [];
  const discoveries = KELP_REALM_DEAD_END_DISCOVERIES.filter(
    (discovery) => discovery.type === 'jellyfish',
  );
  for (const discovery of discoveries) {
    const rng = seededRandom(discovery.seed);
    for (let jelly = 0; jelly < 3; jelly++) {
      const x = discovery.x + (rng() - 0.5) * 78;
      const y = 72 + rng() * 48;
      const z = discovery.z + (rng() - 0.5) * 78;
      const radius = 20 + rng() * 8;
      const phase = rng() * Math.PI * 2;
      const dome = new THREE.SphereGeometry(radius, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      dome.scale(1, 0.62, 1);
      setDiscoveryAttributes(dome, phase);
      dome.translate(x, y, z);
      sources.push(dome);
      for (let ribbon = 0; ribbon < 4; ribbon++) {
        const angle = ribbon / 4 * Math.PI * 2 + rng() * 0.25;
        const tentacle = new THREE.PlaneGeometry(4.5, 50 + rng() * 18, 1, 4);
        setDiscoveryAttributes(tentacle, phase, 'tail');
        tentacle.rotateY(angle);
        tentacle.translate(
          x + Math.cos(angle) * radius * 0.42,
          y - 30,
          z + Math.sin(angle) * radius * 0.42,
        );
        sources.push(tentacle);
      }
    }
  }
  return mergeDiscoverySources(sources, 'jellyfish');
}

function createAnemoneDiscoveryGeometry(): THREE.BufferGeometry {
  const sources: THREE.BufferGeometry[] = [];
  const discoveries = KELP_REALM_DEAD_END_DISCOVERIES.filter(
    (discovery) => discovery.type === 'anemone',
  );
  for (const discovery of discoveries) {
    const rng = seededRandom(discovery.seed);
    const bed = new THREE.SphereGeometry(52, 10, 5);
    bed.scale(1.25, 0.16, 1);
    setDiscoveryAttributes(bed, rng() * Math.PI * 2);
    bed.translate(discovery.x, 8, discovery.z);
    sources.push(bed);
    for (let tentacleIndex = 0; tentacleIndex < 11; tentacleIndex++) {
      const angle = rng() * Math.PI * 2;
      const radius = 12 + rng() * 38;
      const height = 48 + rng() * 52;
      const tentacle = new THREE.ConeGeometry(6 + rng() * 3, height, 5, 3);
      setDiscoveryAttributes(tentacle, rng() * Math.PI * 2, 'tip');
      tentacle.translate(
        discovery.x + Math.cos(angle) * radius,
        height / 2 + 8,
        discovery.z + Math.sin(angle) * radius,
      );
      sources.push(tentacle);
    }
  }
  return mergeDiscoverySources(sources, 'anemone');
}

function createClamDiscoveryGeometry(): THREE.BufferGeometry {
  const sources: THREE.BufferGeometry[] = [];
  const discoveries = KELP_REALM_DEAD_END_DISCOVERIES.filter(
    (discovery) => discovery.type === 'clam',
  );
  for (const discovery of discoveries) {
    const rng = seededRandom(discovery.seed);
    const phase = rng() * Math.PI * 2;
    const lowerShell = new THREE.SphereGeometry(58, 10, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    lowerShell.scale(1.35, 0.42, 0.9);
    setDiscoveryAttributes(lowerShell, phase);
    lowerShell.translate(discovery.x, 24, discovery.z);
    sources.push(lowerShell);
    const upperShell = new THREE.SphereGeometry(58, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    upperShell.scale(1.35, 0.42, 0.9);
    upperShell.rotateX(-0.48);
    setDiscoveryAttributes(upperShell, phase);
    upperShell.translate(discovery.x, 43, discovery.z - 12);
    sources.push(upperShell);
    const pearl = new THREE.SphereGeometry(16, 8, 6);
    setDiscoveryAttributes(pearl, phase);
    pearl.translate(discovery.x, 42, discovery.z + 5);
    sources.push(pearl);
    for (let bubbleIndex = 0; bubbleIndex < 10; bubbleIndex++) {
      const progress = bubbleIndex / 10;
      const bubble = new THREE.SphereGeometry(3 + rng() * 4, 6, 4);
      setDiscoveryAttributes(bubble, phase + bubbleIndex * 0.61, 'none', 1, progress);
      bubble.translate(
        discovery.x + (rng() - 0.5) * 24,
        34 + progress * DISCOVERY_ANIMATION.clam.riseSpan,
        discovery.z + (rng() - 0.5) * 24,
      );
      sources.push(bubble);
    }
  }
  return mergeDiscoverySources(sources, 'clam');
}

export function createKelpRealmDiscoveryGeometry(type: KelpRealmDiscoveryType): THREE.BufferGeometry {
  if (type === 'jellyfish') return createJellyfishDiscoveryGeometry();
  if (type === 'anemone') return createAnemoneDiscoveryGeometry();
  return createClamDiscoveryGeometry();
}

function applyDiscoveryAnimation(
  material: { positionNode: THREE.Node | null },
  type: KelpRealmDiscoveryType,
): void {
  const phase = attribute<'float'>('aDiscoveryPhase', 'float');
  const weight = attribute<'float'>('aDiscoveryWeight', 'float');
  if (type === 'jellyfish') {
    const animation = DISCOVERY_ANIMATION.jellyfish;
    const driftX = sin(time.mul(float(animation.driftXRate)).add(phase))
      .mul(float(animation.driftXAmplitude));
    const ribbon = sin(time.mul(float(animation.ribbonRate)).add(phase))
      .mul(weight).mul(float(animation.ribbonAmplitude));
    const bob = sin(time.mul(float(animation.bobRate)).add(phase))
      .mul(float(animation.bobAmplitude));
    const driftZ = cos(time.mul(float(animation.driftZRate)).add(phase))
      .mul(float(animation.driftZAmplitude));
    material.positionNode = positionLocal.add(vec3(driftX.add(ribbon), bob, driftZ));
    return;
  }
  if (type === 'anemone') {
    const animation = DISCOVERY_ANIMATION.anemone;
    const swayX = sin(time.mul(float(animation.swayXRate)).add(phase))
      .mul(weight).mul(float(animation.swayXAmplitude));
    const pulse = sin(time.mul(float(animation.pulseRate)).add(phase))
      .mul(weight).mul(float(animation.pulseAmplitude));
    const swayZ = cos(time.mul(float(animation.swayZRate)).add(phase))
      .mul(weight).mul(float(animation.swayZAmplitude));
    material.positionNode = positionLocal.add(vec3(swayX, pulse, swayZ));
    return;
  }
  const animation = DISCOVERY_ANIMATION.clam;
  const bubble = attribute<'float'>('aDiscoveryBubble', 'float');
  const progress = attribute<'float'>('aDiscoveryProgress', 'float');
  const rise = fract(time.mul(float(animation.riseRate)).add(progress))
    .mul(float(animation.riseSpan))
    .sub(progress.mul(float(animation.riseSpan)))
    .mul(bubble);
  const drift = sin(time.mul(float(animation.driftRate)).add(phase))
    .mul(float(animation.driftAmplitude)).mul(bubble);
  material.positionNode = positionLocal.add(vec3(drift, rise, float(0)));
}

function discoveryGlsl(type: KelpRealmDiscoveryType): string {
  if (type === 'jellyfish') {
    const animation = DISCOVERY_ANIMATION.jellyfish;
    return `
transformed.x += sin(uDiscoveryTime * ${animation.driftXRate.toFixed(6)} + aDiscoveryPhase) * ${animation.driftXAmplitude.toFixed(6)};
transformed.x += sin(uDiscoveryTime * ${animation.ribbonRate.toFixed(6)} + aDiscoveryPhase) * aDiscoveryWeight * ${animation.ribbonAmplitude.toFixed(6)};
transformed.y += sin(uDiscoveryTime * ${animation.bobRate.toFixed(6)} + aDiscoveryPhase) * ${animation.bobAmplitude.toFixed(6)};
transformed.z += cos(uDiscoveryTime * ${animation.driftZRate.toFixed(6)} + aDiscoveryPhase) * ${animation.driftZAmplitude.toFixed(6)};`;
  }
  if (type === 'anemone') {
    const animation = DISCOVERY_ANIMATION.anemone;
    return `
transformed.x += sin(uDiscoveryTime * ${animation.swayXRate.toFixed(6)} + aDiscoveryPhase) * aDiscoveryWeight * ${animation.swayXAmplitude.toFixed(6)};
transformed.y += sin(uDiscoveryTime * ${animation.pulseRate.toFixed(6)} + aDiscoveryPhase) * aDiscoveryWeight * ${animation.pulseAmplitude.toFixed(6)};
transformed.z += cos(uDiscoveryTime * ${animation.swayZRate.toFixed(6)} + aDiscoveryPhase) * aDiscoveryWeight * ${animation.swayZAmplitude.toFixed(6)};`;
  }
  const animation = DISCOVERY_ANIMATION.clam;
  return `
float discoveryRise = (fract(uDiscoveryTime * ${animation.riseRate.toFixed(6)} + aDiscoveryProgress) * ${animation.riseSpan.toFixed(6)} - aDiscoveryProgress * ${animation.riseSpan.toFixed(6)}) * aDiscoveryBubble;
transformed.x += sin(uDiscoveryTime * ${animation.driftRate.toFixed(6)} + aDiscoveryPhase) * ${animation.driftAmplitude.toFixed(6)} * aDiscoveryBubble;
transformed.y += discoveryRise;`;
}

export function createKelpRealmDiscoveryMaterial(
  type: KelpRealmDiscoveryType,
  forceWebGL: boolean,
): Pick<DiscoveryResource, 'material' | 'timeUniform'> {
  const style = DISCOVERY_STYLE[type];
  if (!forceWebGL) {
    const material = new THREE.MeshBasicNodeMaterial({
      color: style.color,
      transparent: true,
      opacity: style.opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    material.forceSinglePass = true;
    applyDiscoveryAnimation(material, type);
    return { material, timeUniform: null };
  }
  const timeUniform: WindUniform = { value: 0 };
  const material = new THREE.MeshBasicMaterial({
    color: style.color,
    transparent: true,
    opacity: style.opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  material.forceSinglePass = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDiscoveryTime = timeUniform;
    shader.vertexShader = `uniform float uDiscoveryTime;\nattribute float aDiscoveryPhase;\nattribute float aDiscoveryWeight;\nattribute float aDiscoveryBubble;\nattribute float aDiscoveryProgress;\n${shader.vertexShader}`;
    const anchor = '#include <begin_vertex>';
    if (!shader.vertexShader.includes(anchor)) throw new Error(`Kelp realm ${type} animation anchor missing`);
    shader.vertexShader = shader.vertexShader.replace(anchor, `${anchor}${discoveryGlsl(type)}`);
  };
  material.customProgramCacheKey = () => `kelp-realm-discovery-v1-${type}`;
  applyDiscoveryAnimation(material as THREE.MeshBasicMaterial & { positionNode: THREE.Node | null }, type);
  return { material, timeUniform };
}

function useDiscoveryResources(forceWebGL: boolean): readonly DiscoveryResource[] {
  const resources = useMemo(() => KELP_REALM_DISCOVERY_TYPES.map((type) => {
    const geometry = createKelpRealmDiscoveryGeometry(type);
    try {
      return { type, geometry, ...createKelpRealmDiscoveryMaterial(type, forceWebGL) };
    } catch (error) {
      geometry.dispose();
      throw error;
    }
  }), [forceWebGL]);
  useEffect(() => () => {
    for (const resource of resources) {
      resource.geometry.dispose();
      resource.material.dispose();
    }
  }, [resources]);
  return resources;
}

function createPointGeometry(count: number, radius: number, height: number, seed: number): THREE.BufferGeometry {
  const rng = seededRandom(seed);
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    positions[index * 3] = (rng() - 0.5) * radius * 2;
    positions[index * 3 + 1] = rng() * height;
    positions[index * 3 + 2] = (rng() - 0.5) * radius * 2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

const beaconVertexRanges = new Map<string, { start: number; count: number }>();
const beaconIdleColor = new THREE.Color(0x72ffe0);
const beaconCenterColor = new THREE.Color(0xb9fff1);
const beaconVisitedColor = new THREE.Color(0xffefb0);
const sporeVertexRanges = new Map<string, { start: number; count: number }>();
const sporeActiveColor = new THREE.Color(0x8fffd7);
const sporeCollectedColor = new THREE.Color(0x183f39);

function createBeaconGeometry(): THREE.BufferGeometry {
  beaconVertexRanges.clear();
  let vertexOffset = 0;
  const sources = KELP_REALM_BEACON_GRAPH.nodes.map((node) => {
    const geometry = new THREE.SphereGeometry(node.kind === 'center' ? 24 : 12, 8, 6);
    geometry.translate(node.x, node.kind === 'center' ? 120 : 70, node.z);
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    const base = node.kind === 'center' ? beaconCenterColor : beaconIdleColor;
    for (let index = 0; index < count; index++) base.toArray(colors, index * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    beaconVertexRanges.set(node.id, { start: vertexOffset, count });
    vertexOffset += count;
    return geometry;
  });
  try {
    const merged = mergeGeometries(sources, false);
    if (!merged) throw new Error('Kelp realm beacons could not be merged');
    return merged;
  } finally {
    for (const geometry of sources) geometry.dispose();
  }
}

function markBeaconGeometryVisited(geometry: THREE.BufferGeometry, beaconId: string): void {
  const range = beaconVertexRanges.get(beaconId);
  const color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!range || !color) return;
  for (let index = range.start; index < range.start + range.count; index++) {
    color.setXYZ(index, beaconVisitedColor.r, beaconVisitedColor.g, beaconVisitedColor.b);
  }
  color.needsUpdate = true;
}

function resetBeaconGeometryColors(geometry: THREE.BufferGeometry): void {
  const color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!color) return;
  for (const node of KELP_REALM_BEACON_GRAPH.nodes) {
    const range = beaconVertexRanges.get(node.id);
    if (!range) continue;
    const base = node.kind === 'center' ? beaconCenterColor : beaconIdleColor;
    for (let index = range.start; index < range.start + range.count; index++) {
      color.setXYZ(index, base.r, base.g, base.b);
    }
  }
  color.needsUpdate = true;
}

export function createKelpRealmSporeGeometry(): THREE.BufferGeometry {
  sporeVertexRanges.clear();
  const sources: THREE.BufferGeometry[] = [];
  let vertexOffset = 0;
  try {
    for (let sporeIndex = 0; sporeIndex < KELP_REALM_SPORE_BEACON_IDS.length; sporeIndex++) {
      const beaconId = KELP_REALM_SPORE_BEACON_IDS[sporeIndex]!;
      const node = KELP_REALM_BEACON_GRAPH.nodes.find((candidate) => candidate.id === beaconId);
      if (!node) throw new Error(`Kelp realm spore beacon ${beaconId} is missing`);
      const rng = seededRandom(0x53504f52 + sporeIndex * 977);
      const rangeStart = vertexOffset;
      for (let bulbIndex = 0; bulbIndex < 7; bulbIndex++) {
        const angle = bulbIndex / 7 * Math.PI * 2 + rng() * 0.35;
        const ringRadius = bulbIndex === 0 ? 0 : 18 + rng() * 18;
        const radius = bulbIndex === 0 ? 14 : 7 + rng() * 5;
        const bulb = new THREE.SphereGeometry(radius, 8, 6);
        const count = bulb.getAttribute('position').count;
        const colors = new Float32Array(count * 3);
        for (let vertex = 0; vertex < count; vertex++) {
          sporeActiveColor.toArray(colors, vertex * 3);
        }
        bulb.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        bulb.translate(
          node.x + Math.cos(angle) * ringRadius,
          26 + radius + (bulbIndex % 3) * 10,
          node.z + Math.sin(angle) * ringRadius,
        );
        sources.push(bulb);
        vertexOffset += count;
      }
      sporeVertexRanges.set(beaconId, {
        start: rangeStart,
        count: vertexOffset - rangeStart,
      });
    }
    const merged = mergeGeometries(sources, false);
    if (!merged) throw new Error('Kelp realm spores could not be merged');
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  } finally {
    for (const geometry of sources) geometry.dispose();
  }
}

export function createKelpRealmSporeMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

function setSporeGeometryColor(
  geometry: THREE.BufferGeometry,
  beaconId: string,
  nextColor: THREE.Color,
): void {
  const range = sporeVertexRanges.get(beaconId);
  const color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!range || !color) return;
  for (let index = range.start; index < range.start + range.count; index++) {
    color.setXYZ(index, nextColor.r, nextColor.g, nextColor.b);
  }
  color.needsUpdate = true;
}

export function markKelpRealmSporeGeometryVisited(
  geometry: THREE.BufferGeometry,
  beaconId: string,
): void {
  setSporeGeometryColor(geometry, beaconId, sporeCollectedColor);
}

function resetSporeGeometryColors(geometry: THREE.BufferGeometry): void {
  for (const beaconId of KELP_REALM_SPORE_BEACON_IDS) {
    setSporeGeometryColor(geometry, beaconId, sporeActiveColor);
  }
}

function RealmEnvironment({ forceWebGL }: { forceWebGL: boolean }) {
  const kelp = useKelpResources(forceWebGL);
  const discoveries = useDiscoveryResources(forceWebGL);
  const motesRef = useRef<THREE.Points>(null);
  const orbitRef = useRef<THREE.Points>(null);
  const resources = useMemo(() => {
    const floorGeometry = createFloorGeometry();
    const floorMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const rayGeometry = createRayGeometry();
    const rayMaterial = createKelpRealmRayMaterial();
    const moteGeometry = createPointGeometry(700, KELP_REALM_FOOTPRINT_WU * 0.7, 760, 0x4d4f5445);
    const moteMaterial = new THREE.PointsMaterial({ color: 0x8fffe3, size: 5, transparent: true, opacity: 0.42, depthWrite: false, sizeAttenuation: true });
    const beaconGeometry = createBeaconGeometry();
    const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.82, fog: false });
    const sporeGeometry = createKelpRealmSporeGeometry();
    const sporeMaterial = createKelpRealmSporeMaterial();
    const shellGeometry = new THREE.SphereGeometry(180, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.58);
    shellGeometry.scale(1.25, 0.55, 0.9);
    shellGeometry.rotateX(Math.PI);
    shellGeometry.translate(KELP_REALM_CENTER.x, 20, KELP_REALM_CENTER.z);
    const shellMaterial = new THREE.MeshStandardMaterial({ color: 0x315f56, roughness: 0.72, metalness: 0.08, side: THREE.DoubleSide });
    const pearlGeometry = new THREE.SphereGeometry(58, 16, 12);
    pearlGeometry.translate(KELP_REALM_CENTER.x, 98, KELP_REALM_CENTER.z);
    const pearlMaterial = new THREE.MeshBasicMaterial({ color: 0xb9fff1, transparent: true, opacity: 0.9, fog: false });
    const orbitGeometry = createPointGeometry(96, 180, 90, 0x50454152);
    const orbitMaterial = new THREE.PointsMaterial({ color: 0xd2fff4, size: 7, transparent: true, opacity: 0.62, depthWrite: false });
    return { floorGeometry, floorMaterial, rayGeometry, rayMaterial, moteGeometry, moteMaterial, beaconGeometry, beaconMaterial, sporeGeometry, sporeMaterial, shellGeometry, shellMaterial, pearlGeometry, pearlMaterial, orbitGeometry, orbitMaterial };
  }, []);

  useEffect(() => () => {
    const disposable = Object.values(resources);
    for (let index = 0; index < disposable.length; index++) disposable[index]!.dispose();
  }, [resources]);

  useEffect(
    () => subscribeKelpRealmBeaconVisits(
      (beaconId) => {
        markBeaconGeometryVisited(resources.beaconGeometry, beaconId);
        markKelpRealmSporeGeometryVisited(resources.sporeGeometry, beaconId);
      },
      () => {
        resetBeaconGeometryColors(resources.beaconGeometry);
        resetSporeGeometryColors(resources.sporeGeometry);
      },
    ),
    [resources.beaconGeometry, resources.sporeGeometry],
  );

  useFrame(({ clock }, delta) => {
    for (let index = 0; index < kelp.length; index++) {
      const uniform = kelp[index]!.windUniform;
      if (uniform) uniform.value = clock.elapsedTime;
    }
    for (let index = 0; index < discoveries.length; index++) {
      const uniform = discoveries[index]!.timeUniform;
      if (uniform) uniform.value = clock.elapsedTime;
    }
    if (motesRef.current) {
      motesRef.current.rotation.y += delta * 0.008;
      motesRef.current.position.y = Math.sin(clock.elapsedTime * 0.12) * 18;
    }
    if (orbitRef.current) orbitRef.current.rotation.y += delta * 0.16;
    resources.pearlMaterial.opacity = 0.78 + Math.sin(clock.elapsedTime * 1.1) * 0.16;
  });

  return (
    <>
      <mesh geometry={resources.floorGeometry} material={resources.floorMaterial} matrixAutoUpdate={false} />
      <mesh geometry={resources.rayGeometry} material={resources.rayMaterial} matrixAutoUpdate={false} renderOrder={-1} />
      <points ref={motesRef} geometry={resources.moteGeometry} material={resources.moteMaterial} />
      {kelp.map((resource, index) => <mesh key={index} geometry={resource.geometry} material={resource.material} matrixAutoUpdate={false} />)}
      {discoveries.map((resource) => <mesh key={resource.type} geometry={resource.geometry} material={resource.material} matrixAutoUpdate={false} />)}
      <mesh geometry={resources.beaconGeometry} material={resources.beaconMaterial} matrixAutoUpdate={false} />
      <mesh geometry={resources.sporeGeometry} material={resources.sporeMaterial} matrixAutoUpdate={false} />
      <mesh geometry={resources.shellGeometry} material={resources.shellMaterial} matrixAutoUpdate={false} />
      <mesh geometry={resources.pearlGeometry} material={resources.pearlMaterial} matrixAutoUpdate={false} />
      <points ref={orbitRef} geometry={resources.orbitGeometry} material={resources.orbitMaterial} position={[KELP_REALM_CENTER.x, 80, KELP_REALM_CENTER.z]} />
    </>
  );
}

export default function KelpRealmScene({ forceWebGL }: { forceWebGL: boolean }) {
  const { scene } = useThree();
  useEffect(() => {
    const previousBackground = scene.background;
    const previousFog = scene.fog;
    scene.background = FOG_COLOR;
    scene.fog = new THREE.Fog(FOG_COLOR, 450, 4200);
    return () => {
      scene.background = previousBackground;
      scene.fog = previousFog;
    };
  }, [scene]);

  return (
    <>
      <ambientLight intensity={0.72} color={0x78c8ae} />
      <directionalLight position={[500, 1300, 300]} intensity={1.2} color={0xb9ffe4} />
      <RealmEnvironment forceWebGL={forceWebGL} />
      <KelpRealmPlayer />
    </>
  );
}

export const KELP_REALM_SCENE_BUDGET = Object.freeze({
  bladeCount: BLADE_COUNT,
  kelpDrawCalls: VARIANTS.length,
  discoveryDrawCalls: KELP_REALM_DISCOVERY_TYPES.length,
  sporeDrawCalls: 1,
  environmentDrawCalls: 14,
  maxAvatarDrawCalls: 14,
  maxTotalDrawCallsIncludingAvatar: 28,
  hardTotalDrawCallCeiling: 32,
  wallHeightWu: KELP_REALM_WALL_HEIGHT_WU,
});
