'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  MAP_COLS,
  MAP_ROWS,
  TILES,
  pathLayer,
  groundLayer,
} from '@/lib/pixi/tilemap-data';

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

function seeded(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}


// ---------------------------------------------------------------------------
// Ocean floor with procedural sand texture + displacement
// ---------------------------------------------------------------------------
function OceanFloor() {
  const { geo } = useMemo(() => {
    const g = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, 100, 70);
    const pos = g.attributes.position;
    const rand = seeded(42);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getY(i);
      // Multi-octave dunes
      const dune1 = Math.sin(x * 0.008) * Math.cos(z * 0.012) * 6;
      const dune2 = Math.sin(x * 0.02 + 1.5) * Math.cos(z * 0.018) * 2.5;
      const ripple = Math.sin(x * 0.05) * Math.cos(z * 0.06) * 0.8;
      const noise = (rand() - 0.5) * 0.6;
      pos.setZ(i, dune1 + dune2 + ripple + noise);
    }
    g.computeVertexNormals();
    // Vertex colors for sand variation (no texture allocation)
    const colors = new Float32Array(pos.count * 3);
    const sandPalette = [
      new THREE.Color(0xd4b896), new THREE.Color(0xc9a97a),
      new THREE.Color(0xe8d5b7), new THREE.Color(0xbfa06a), new THREE.Color(0xdec49e),
    ];
    for (let j = 0; j < pos.count; j++) {
      const height = pos.getZ(j) / 8;
      const ci = Math.floor(Math.abs(height * 2 + rand()) * sandPalette.length) % sandPalette.length;
      const c = sandPalette[ci];
      const dark = 0.85 + height * 0.1;
      colors[j * 3] = c.r * dark; colors[j * 3 + 1] = c.g * dark; colors[j * 3 + 2] = c.b * dark;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return { geo: g };
  }, []);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2, 0]} receiveShadow geometry={geo}>
      <meshStandardMaterial vertexColors roughness={0.92} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Instanced path tiles
// ---------------------------------------------------------------------------
function PathTiles() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const { count, matrices, colors } = useMemo(() => {
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const rand = seeded(99);
    const pathColor = new THREE.Color(0x8faaaa);
    const dirtColor = new THREE.Color(0xb89b71);

    for (let i = 0; i < pathLayer.length; i++) {
      const tile = pathLayer[i];
      if (tile === TILES.EMPTY) continue;
      const col = i % MAP_COLS;
      const row = Math.floor(i / MAP_COLS);
      const x = OFFSET_X + col * TILE_SIZE + TILE_SIZE / 2;
      const z = OFFSET_Z + row * TILE_SIZE + TILE_SIZE / 2;
      const m = new THREE.Matrix4();
      m.setPosition(x, 0.3 + rand() * 0.1, z);
      mats.push(m);
      cols.push(tile === TILES.STONE_PATH ? pathColor : dirtColor);
    }
    return { count: mats.length, matrices: mats, colors: cols };
  }, []);

  useMemo(() => {
    if (!ref.current || count === 0) return;
    for (let i = 0; i < count; i++) {
      ref.current.setMatrixAt(i, matrices[i]);
      ref.current.setColorAt(i, colors[i]);
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, [count, matrices, colors]);

  if (count === 0) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} receiveShadow>
      <boxGeometry args={[TILE_SIZE, 0.5, TILE_SIZE]} />
      <meshStandardMaterial roughness={0.8} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Animated water surface at top of scene
// ---------------------------------------------------------------------------
function WaterSurface() {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  const tiles = useMemo(() => {
    const t: [number, number][] = [];
    for (let i = 0; i < groundLayer.length; i++) {
      if (groundLayer[i] === TILES.WATER) t.push([i % MAP_COLS, Math.floor(i / MAP_COLS)]);
    }
    return t;
  }, []);

  const { cx, cz, w, h } = useMemo(() => {
    if (tiles.length === 0) return { cx: 0, cz: 0, w: 0, h: 0 };
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const [c, r] of tiles) {
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
    }
    return {
      cx: OFFSET_X + (minC + (maxC - minC + 1) / 2) * TILE_SIZE,
      cz: OFFSET_Z + (minR + (maxR - minR + 1) / 2) * TILE_SIZE,
      w: (maxC - minC + 1) * TILE_SIZE, h: (maxR - minR + 1) * TILE_SIZE,
    };
  }, [tiles]);

  useFrame(({ clock }) => {
    if (matRef.current) {
      const t = clock.elapsedTime;
      matRef.current.opacity = 0.6 + Math.sin(t * 1.5) * 0.1;
    }
  });

  if (w === 0) return null;
  return (
    <mesh position={[cx, 0.5, cz]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial ref={matRef} color={0x1a8bba} transparent opacity={0.65} roughness={0.1} metalness={0.6} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Multi-segment kelp with swaying (instanced, 1 draw call)
// ---------------------------------------------------------------------------
function KelpForest() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 50;

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    const rand = seeded(55);
    const dummy = new THREE.Object3D();

    for (let i = 0; i < count; i++) {
      const baseX = OFFSET_X + rand() * MAP_WIDTH;
      const baseZ = OFFSET_Z + rand() * MAP_HEIGHT;
      const height = 10 + rand() * 20;
      const phase = rand() * Math.PI * 2;

      // Sway animation
      const sway = Math.sin(t * 0.6 + phase) * 0.08;

      dummy.position.set(baseX + Math.sin(t * 0.4 + phase) * 2, height / 2 - 1, baseZ);
      dummy.scale.set(0.8 + rand() * 0.5, height, 0.8 + rand() * 0.5);
      dummy.rotation.set(sway, rand() * Math.PI * 2, sway * 0.5);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  });

  // Set initial colors
  useMemo(() => {
    if (!ref.current) return;
    const rand = seeded(55);
    const kelpColors = [0x2e7d32, 0x388e3c, 0x43a047, 0x558b2f, 0x33691e];
    for (let i = 0; i < count; i++) {
      // Skip rand calls to match position generation
      rand(); rand(); rand(); rand();
      ref.current.setColorAt(i, new THREE.Color(kelpColors[Math.floor(rand() * kelpColors.length)]));
    }
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, []);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <cylinderGeometry args={[0.4, 0.8, 1, 5]} />
      <meshStandardMaterial roughness={0.7} emissive={0x1a3a1a} emissiveIntensity={0.2} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Coral reef formations (instanced)
// ---------------------------------------------------------------------------
function CoralReef() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 40;

  useMemo(() => {
    if (!ref.current) return;
    const rand = seeded(77);
    const dummy = new THREE.Object3D();
    const coralColors = [0xff6f61, 0xff4081, 0xe65100, 0xffab40, 0x7c4dff, 0x00e5ff, 0xff7043, 0xab47bc, 0xef5350, 0x26c6da];
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        OFFSET_X + rand() * MAP_WIDTH,
        -1 + rand() * 3,
        OFFSET_Z + rand() * MAP_HEIGHT,
      );
      // Organic irregular scaling
      dummy.scale.set(2 + rand() * 4, 4 + rand() * 10, 2 + rand() * 4);
      dummy.rotation.set(rand() * 0.3, rand() * Math.PI * 2, rand() * 0.3);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
      ref.current.setColorAt(i, new THREE.Color(coralColors[Math.floor(rand() * coralColors.length)]));
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, []);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <icosahedronGeometry args={[1, 1]} />
      <meshStandardMaterial roughness={0.5} emissive={0x220808} emissiveIntensity={0.4} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Rocky outcrops (instanced)
// ---------------------------------------------------------------------------
function Rocks() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 25;

  useMemo(() => {
    if (!ref.current) return;
    const rand = seeded(33);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        OFFSET_X + rand() * MAP_WIDTH,
        -1 + rand() * 2,
        OFFSET_Z + rand() * MAP_HEIGHT,
      );
      dummy.scale.set(3 + rand() * 8, 2 + rand() * 5, 3 + rand() * 8);
      dummy.rotation.set(rand() * 0.5, rand() * Math.PI, rand() * 0.5);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
      ref.current.setColorAt(i, new THREE.Color().setHSL(0.08, 0.12 + rand() * 0.1, 0.25 + rand() * 0.15));
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, []);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <icosahedronGeometry args={[1, 0]} />
      <meshStandardMaterial roughness={0.95} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Seashells scattered on the floor (instanced)
// ---------------------------------------------------------------------------
function Seashells() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 30;

  useMemo(() => {
    if (!ref.current) return;
    const rand = seeded(111);
    const dummy = new THREE.Object3D();
    const shellColors = [0xfff8e1, 0xffe0b2, 0xffccbc, 0xf0f4c3, 0xb2dfdb];
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        OFFSET_X + rand() * MAP_WIDTH,
        -1.5 + rand() * 0.5,
        OFFSET_Z + rand() * MAP_HEIGHT,
      );
      dummy.scale.setScalar(0.5 + rand() * 1.5);
      dummy.rotation.set(rand() * Math.PI, rand() * Math.PI * 2, 0);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
      ref.current.setColorAt(i, new THREE.Color(shellColors[Math.floor(rand() * shellColors.length)]));
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, []);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <sphereGeometry args={[1, 6, 4, 0, Math.PI]} />
      <meshStandardMaterial roughness={0.3} metalness={0.2} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Main terrain (~10 draw calls total)
// ---------------------------------------------------------------------------
export default function ArenaTerrain() {
  return (
    <group>
      <OceanFloor />
      <PathTiles />
      <WaterSurface />
      <CoralReef />
      <KelpForest />
      <Rocks />
      <Seashells />
    </group>
  );
}
