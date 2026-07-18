'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { attribute, cos, float, positionLocal, sin, time, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  KELP_REALM_BEACON_GRAPH,
  KELP_REALM_CELL_WU,
  KELP_REALM_CENTER,
  KELP_REALM_FOOTPRINT_WU,
  KELP_REALM_MAX_SWAY_WU,
  KELP_REALM_ONE_SIDED_SWAY_WU,
  KELP_REALM_WALL_AABBS,
  KELP_REALM_WALL_HEIGHT_WU,
  isKelpRealmCorridorCell,
} from '@clawville/shared';
import KelpRealmPlayer from './kelp-realm-player';

const BLADE_COUNT = 15_000;
const BLADES_PER_VARIANT = BLADE_COUNT / 3;
const BLADE_ROWS = 8;
const FOG_COLOR = new THREE.Color(0x031b20);
const MAX_PRIMARY_AMPLITUDE_WU = KELP_REALM_ONE_SIDED_SWAY_WU / 1.16;

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
  { minHeight: 650, maxHeight: 780, minWidth: 22, maxWidth: 34, root: new THREE.Color(0x052d27), tip: new THREE.Color(0x16886d), amplitude: MAX_PRIMARY_AMPLITUDE_WU * 0.78, rate: 0.17 },
  { minHeight: 600, maxHeight: 750, minWidth: 25, maxWidth: 39, root: new THREE.Color(0x07372d), tip: new THREE.Color(0x24a16e), amplitude: MAX_PRIMARY_AMPLITUDE_WU * 0.86, rate: 0.14 },
  { minHeight: 680, maxHeight: 800, minWidth: 19, maxWidth: 31, root: new THREE.Color(0x042d34), tip: new THREE.Color(0x138b83), amplitude: MAX_PRIMARY_AMPLITUDE_WU, rate: 0.11 },
]);

interface WindUniform { value: number }
interface KelpResource {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly windUniform: WindUniform | null;
}

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
  const primaryZ = cos(time.mul(float(variant.rate * 0.71)).add(phase.mul(float(1.27))))
    .mul(height.mul(height)).mul(float(variant.amplitude * 0.42));
  const currentX = cos(time.mul(float(0.041)).add(phase.mul(float(0.43))))
    .mul(height).mul(float(variant.amplitude * 0.16));
  const currentZ = sin(time.mul(float(0.037)).add(phase.mul(float(0.59))))
    .mul(height).mul(float(variant.amplitude * 0.12));
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
    // Keep roots 60 wu back from every corridor-facing cell edge. With the
    // <=20 wu one-sided animated displacement plus blade width/bend, each
    // opposing wall consumes <=20 wu of corridor space: 200 - 20 - 20 = 160.
    const minX = isKelpRealmCorridorCell(wall.row, wall.col - 1) ? -40 : -96;
    const maxX = isKelpRealmCorridorCell(wall.row, wall.col + 1) ? 40 : 96;
    const minZ = isKelpRealmCorridorCell(wall.row - 1, wall.col) ? -40 : -96;
    const maxZ = isKelpRealmCorridorCell(wall.row + 1, wall.col) ? 40 : 96;
    const x = wall.centerX + minX + rng() * (maxX - minX);
    const z = wall.centerZ + minZ + rng() * (maxZ - minZ);
    const bladeHeight = variant.minHeight + rng() * (variant.maxHeight - variant.minHeight);
    const width = variant.minWidth + rng() * (variant.maxWidth - variant.minWidth);
    const bend = 10 + rng() * 8;
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
transformed.z += cos(uKelpTime * ${(variant.rate * 0.71).toFixed(6)} + aPhase * 1.27) * h2 * ${(variant.amplitude * 0.42).toFixed(6)};
transformed.x += cos(uKelpTime * 0.041 + aPhase * 0.43) * aHeight * ${(variant.amplitude * 0.16).toFixed(6)};
transformed.z += sin(uKelpTime * 0.037 + aPhase * 0.59) * aHeight * ${(variant.amplitude * 0.12).toFixed(6)};`);
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

function createBeaconGeometry(): THREE.BufferGeometry {
  const sources = KELP_REALM_BEACON_GRAPH.nodes.map((node) => {
    const geometry = new THREE.SphereGeometry(node.kind === 'center' ? 24 : 12, 8, 6);
    geometry.translate(node.x, node.kind === 'center' ? 120 : 70, node.z);
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

function RealmEnvironment({ forceWebGL }: { forceWebGL: boolean }) {
  const kelp = useKelpResources(forceWebGL);
  const motesRef = useRef<THREE.Points>(null);
  const orbitRef = useRef<THREE.Points>(null);
  const resources = useMemo(() => {
    const floorGeometry = createFloorGeometry();
    const floorMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const rayGeometry = createRayGeometry();
    const rayMaterial = new THREE.MeshBasicMaterial({ color: 0x7effd8, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const moteGeometry = createPointGeometry(700, KELP_REALM_FOOTPRINT_WU * 0.7, 760, 0x4d4f5445);
    const moteMaterial = new THREE.PointsMaterial({ color: 0x8fffe3, size: 5, transparent: true, opacity: 0.42, depthWrite: false, sizeAttenuation: true });
    const beaconGeometry = createBeaconGeometry();
    const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0x72ffe0, transparent: true, opacity: 0.72, fog: false });
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
    return { floorGeometry, floorMaterial, rayGeometry, rayMaterial, moteGeometry, moteMaterial, beaconGeometry, beaconMaterial, shellGeometry, shellMaterial, pearlGeometry, pearlMaterial, orbitGeometry, orbitMaterial };
  }, []);

  useEffect(() => () => {
    const disposable = Object.values(resources);
    for (let index = 0; index < disposable.length; index++) disposable[index]!.dispose();
  }, [resources]);

  useFrame(({ clock }, delta) => {
    for (let index = 0; index < kelp.length; index++) {
      const uniform = kelp[index]!.windUniform;
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
      <mesh geometry={resources.beaconGeometry} material={resources.beaconMaterial} matrixAutoUpdate={false} />
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
  environmentDrawCalls: 10,
  realmAvatarDrawCalls: 1,
  maxTotalDrawCallsIncludingAvatar: 11,
  wallHeightWu: KELP_REALM_WALL_HEIGHT_WU,
});
