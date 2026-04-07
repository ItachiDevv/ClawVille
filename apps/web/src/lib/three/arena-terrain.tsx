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
  groundLayer,
  pathLayer,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Optimized terrain — uses merged geometry and instanced meshes
// to keep draw calls under 30 (was 1000+ with individual tiles)
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

function seeded(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// ---------------------------------------------------------------------------
// Single merged ground plane with vertex colors (1 draw call)
// ---------------------------------------------------------------------------
function OceanFloor() {
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(MAP_WIDTH, MAP_HEIGHT, MAP_COLS, MAP_ROWS);
    const pos = g.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const rand = seeded(42);
    const sandColors = [
      new THREE.Color(0xd4b896), new THREE.Color(0xc9a97a),
      new THREE.Color(0xe8d5b7), new THREE.Color(0xbfa06a),
    ];

    for (let i = 0; i < pos.count; i++) {
      // Gentle undulation
      const x = pos.getX(i);
      const z = pos.getY(i);
      pos.setZ(i, Math.sin(x * 0.01) * 1.5 + Math.cos(z * 0.015) * 1 + rand() * 0.3);
      const c = sandColors[Math.floor(rand() * sandColors.length)];
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, []);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]} receiveShadow geometry={geo}>
      <meshStandardMaterial vertexColors roughness={0.85} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Instanced path tiles (1 draw call for all paths)
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
      m.setPosition(x, 0.2 + rand() * 0.1, z);
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
      <boxGeometry args={[TILE_SIZE, 0.4, TILE_SIZE]} />
      <meshStandardMaterial roughness={0.8} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Animated water area (1 draw call)
// ---------------------------------------------------------------------------
function WaterSurface() {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const waterColor = new THREE.Color(0x1a8bba);
  const waterDeep = new THREE.Color(0x0d6b9b);

  const { cx, cz, w, h } = useMemo(() => {
    const tiles: [number, number][] = [];
    for (let i = 0; i < groundLayer.length; i++) {
      if (groundLayer[i] === TILES.WATER) {
        tiles.push([i % MAP_COLS, Math.floor(i / MAP_COLS)]);
      }
    }
    if (tiles.length === 0) return { cx: 0, cz: 0, w: 0, h: 0 };
    let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const [c, r] of tiles) {
      if (c < minC) minC = c; if (c > maxC) maxC = c;
      if (r < minR) minR = r; if (r > maxR) maxR = r;
    }
    return {
      cx: OFFSET_X + (minC + (maxC - minC + 1) / 2) * TILE_SIZE,
      cz: OFFSET_Z + (minR + (maxR - minR + 1) / 2) * TILE_SIZE,
      w: (maxC - minC + 1) * TILE_SIZE,
      h: (maxR - minR + 1) * TILE_SIZE,
    };
  }, []);

  useFrame(({ clock }) => {
    if (matRef.current) {
      const t = clock.elapsedTime;
      matRef.current.color.copy(waterColor).lerp(waterDeep, (Math.sin(t * 1.5) + 1) * 0.2);
      matRef.current.opacity = 0.75 + Math.sin(t * 2) * 0.1;
    }
  });

  if (w === 0) return null;
  return (
    <mesh position={[cx, 0.3, cz]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[w, h]} />
      <meshStandardMaterial ref={matRef} color={waterColor} transparent opacity={0.8} roughness={0.15} metalness={0.6} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Instanced coral (1 draw call for all coral)
// ---------------------------------------------------------------------------
function CoralInstances() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 25;

  useMemo(() => {
    if (!ref.current) return;
    const rand = seeded(77);
    const dummy = new THREE.Object3D();
    const coralColors = [0xff6f61, 0xff4081, 0xe65100, 0xffab40, 0x7c4dff, 0x00e5ff];
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        OFFSET_X + rand() * MAP_WIDTH,
        rand() * 3,
        OFFSET_Z + rand() * MAP_HEIGHT,
      );
      dummy.scale.setScalar(1 + rand() * 3);
      dummy.rotation.y = rand() * Math.PI * 2;
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
      ref.current.setColorAt(i, new THREE.Color(coralColors[Math.floor(rand() * coralColors.length)]));
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, []);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} castShadow>
      <dodecahedronGeometry args={[1, 1]} />
      <meshStandardMaterial roughness={0.6} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Instanced kelp (1 draw call)
// ---------------------------------------------------------------------------
function KelpInstances() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 30;

  useMemo(() => {
    if (!ref.current) return;
    const rand = seeded(55);
    const dummy = new THREE.Object3D();
    const kelpColors = [0x2e7d32, 0x388e3c, 0x1b5e20];
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        OFFSET_X + rand() * MAP_WIDTH,
        2 + rand() * 4,
        OFFSET_Z + rand() * MAP_HEIGHT,
      );
      dummy.scale.set(0.3 + rand() * 0.3, 2 + rand() * 4, 0.3 + rand() * 0.3);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
      ref.current.setColorAt(i, new THREE.Color(kelpColors[Math.floor(rand() * kelpColors.length)]));
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, []);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} castShadow>
      <cylinderGeometry args={[0.5, 0.8, 1, 6]} />
      <meshStandardMaterial roughness={0.7} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Instanced rocks (1 draw call)
// ---------------------------------------------------------------------------
function RockInstances() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 20;

  useMemo(() => {
    if (!ref.current) return;
    const rand = seeded(33);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set(
        OFFSET_X + rand() * MAP_WIDTH,
        rand() * 0.5,
        OFFSET_Z + rand() * MAP_HEIGHT,
      );
      dummy.scale.setScalar(1 + rand() * 3);
      dummy.rotation.set(rand(), rand(), rand());
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
      ref.current.setColorAt(i, new THREE.Color().setHSL(0.08, 0.1, 0.35 + rand() * 0.15));
    }
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, []);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <dodecahedronGeometry args={[1, 0]} />
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Main terrain — ~8 draw calls total (was 1000+)
// ---------------------------------------------------------------------------
export default function ArenaTerrain() {
  return (
    <group>
      <OceanFloor />
      <PathTiles />
      <WaterSurface />
      <CoralInstances />
      <KelpInstances />
      <RockInstances />
    </group>
  );
}
