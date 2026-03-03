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
  decorationLayer,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Seeded random for deterministic placement
// ---------------------------------------------------------------------------
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// Color constants
// ---------------------------------------------------------------------------
// Sea-floor sand colors (replacing grass)
const GRASS_COLORS = [
  new THREE.Color(0x2e6b62), // Sandy seafloor - dark teal
  new THREE.Color(0x3d8b7a), // Lighter seafloor - medium teal
  new THREE.Color(0x1a4a42), // Deep seafloor - dark marine
];

const PATH_COLORS: Record<number, THREE.Color> = {
  [TILES.DIRT_PATH]: new THREE.Color(0xc2b280), // Sandy path
  [TILES.STONE_PATH]: new THREE.Color(0x708090), // Slate stone path
};

const WATER_COLOR = new THREE.Color(0x006994);
const WATER_COLOR_DEEP = new THREE.Color(0x003366);

// Coral/kelp colors replacing trees
const TREE_TRUNK_COLOR = new THREE.Color(0x5d4037); // Kelp stalk
const TREE_CANOPY_COLORS = [
  new THREE.Color(0xff6f61), // Coral pink
  new THREE.Color(0xe65100), // Orange coral
];
// Sea anemone colors replacing flowers
const FLOWER_COLORS = [
  new THREE.Color(0xff4081), // Pink anemone
  new THREE.Color(0x7c4dff), // Purple anemone
];
const BUSH_COLOR = new THREE.Color(0x2e7d32); // Kelp bush

// Centering offset: place map origin at world center
const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

// ---------------------------------------------------------------------------
// Helper: tile world position (center of tile)
// ---------------------------------------------------------------------------
function tilePos(col: number, row: number): [number, number, number] {
  return [
    OFFSET_X + col * TILE_SIZE + TILE_SIZE / 2,
    0,
    OFFSET_Z + row * TILE_SIZE + TILE_SIZE / 2,
  ];
}

// ---------------------------------------------------------------------------
// Sub-component: Ground tiles (instanced)
// ---------------------------------------------------------------------------
function GroundTiles() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const { count, matrices, colors } = useMemo(() => {
    const rand = seededRandom(42);
    const totalTiles = MAP_COLS * MAP_ROWS;
    const tempMatrix = new THREE.Matrix4();
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];

    for (let i = 0; i < totalTiles; i++) {
      const col = i % MAP_COLS;
      const row = Math.floor(i / MAP_COLS);
      const tile = groundLayer[i];

      if (tile === TILES.WATER) continue; // water rendered separately

      const [x, , z] = tilePos(col, row);
      // Slight Y variation for natural feel
      const yOffset = (rand() - 0.5) * 0.3;
      tempMatrix.makeTranslation(x, yOffset, z);
      mats.push(tempMatrix.clone());

      // Pick grass color based on tile type with slight random variation
      let baseColor: THREE.Color;
      if (tile === TILES.GRASS_1) baseColor = GRASS_COLORS[0];
      else if (tile === TILES.GRASS_2) baseColor = GRASS_COLORS[1];
      else baseColor = GRASS_COLORS[2];

      const variation = new THREE.Color(baseColor);
      variation.offsetHSL(0, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.04);
      cols.push(variation);
    }

    return { count: mats.length, matrices: mats, colors: cols };
  }, []);

  useMemo(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, matrices[i]);
      mesh.setColorAt(i, colors[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [count, matrices, colors]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <boxGeometry args={[TILE_SIZE, 1, TILE_SIZE]} />
      <meshStandardMaterial vertexColors roughness={0.9} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Path tiles (instanced)
// ---------------------------------------------------------------------------
function PathTiles() {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const { count, matrices, colors } = useMemo(() => {
    const tempMatrix = new THREE.Matrix4();
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const rand = seededRandom(99);

    for (let i = 0; i < pathLayer.length; i++) {
      const tile = pathLayer[i];
      if (tile === TILES.EMPTY) continue;

      const col = i % MAP_COLS;
      const row = Math.floor(i / MAP_COLS);
      const [x, , z] = tilePos(col, row);

      // Paths sit slightly above ground
      const y = 0.6 + rand() * 0.1;
      tempMatrix.makeTranslation(x, y, z);
      mats.push(tempMatrix.clone());

      const color = PATH_COLORS[tile] ?? new THREE.Color(0x8d6e63);
      const varied = new THREE.Color(color);
      varied.offsetHSL(0, 0, (rand() - 0.5) * 0.05);
      cols.push(varied);
    }

    return { count: mats.length, matrices: mats, colors: cols };
  }, []);

  useMemo(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, matrices[i]);
      mesh.setColorAt(i, colors[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [count, matrices, colors]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]}>
      <boxGeometry args={[TILE_SIZE, 0.4, TILE_SIZE]} />
      <meshStandardMaterial vertexColors roughness={0.85} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Water surface (animated)
// ---------------------------------------------------------------------------
function WaterSurface() {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);

  // Collect water tile positions
  const waterTiles = useMemo(() => {
    const tiles: Array<[number, number]> = [];
    for (let i = 0; i < groundLayer.length; i++) {
      if (groundLayer[i] === TILES.WATER) {
        const col = i % MAP_COLS;
        const row = Math.floor(i / MAP_COLS);
        tiles.push([col, row]);
      }
    }
    return tiles;
  }, []);

  // Calculate bounding box of water tiles
  const { centerX, centerZ, width, height } = useMemo(() => {
    if (waterTiles.length === 0) return { centerX: 0, centerZ: 0, width: 0, height: 0 };
    let minCol = Infinity, maxCol = -Infinity;
    let minRow = Infinity, maxRow = -Infinity;
    for (const [c, r] of waterTiles) {
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
    }
    const w = (maxCol - minCol + 1) * TILE_SIZE;
    const h = (maxRow - minRow + 1) * TILE_SIZE;
    const cx = OFFSET_X + (minCol + (maxCol - minCol + 1) / 2) * TILE_SIZE;
    const cz = OFFSET_Z + (minRow + (maxRow - minRow + 1) / 2) * TILE_SIZE;
    return { centerX: cx, centerZ: cz, width: w, height: h };
  }, [waterTiles]);

  // Animate water color / opacity shimmer
  useFrame(({ clock }) => {
    if (materialRef.current) {
      const t = clock.getElapsedTime();
      const lerp = (Math.sin(t * 1.5) + 1) / 2;
      materialRef.current.color.copy(WATER_COLOR).lerp(WATER_COLOR_DEEP, lerp * 0.4);
      materialRef.current.opacity = 0.75 + Math.sin(t * 2) * 0.1;
    }
  });

  if (waterTiles.length === 0) return null;

  return (
    <mesh ref={meshRef} position={[centerX, 0.3, centerZ]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[width, height]} />
      <meshStandardMaterial
        ref={materialRef}
        color={WATER_COLOR}
        transparent
        opacity={0.8}
        roughness={0.15}
        metalness={0.6}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Procedural Tree
// ---------------------------------------------------------------------------
function Tree({ position, variant }: { position: [number, number, number]; variant: number }) {
  const trunkHeight = 10 + variant * 4;
  const coralColor = TREE_CANOPY_COLORS[variant % 2];

  return (
    <group position={position}>
      {/* Coral trunk / kelp stalk */}
      <mesh position={[0, trunkHeight / 2, 0]}>
        <cylinderGeometry args={[1.2, 2, trunkHeight, 6]} />
        <meshStandardMaterial color={TREE_TRUNK_COLOR} roughness={0.8} />
      </mesh>
      {/* Coral branches (sphere cluster instead of cone canopy) */}
      <mesh position={[0, trunkHeight + 2, 0]}>
        <sphereGeometry args={[6 + variant * 2, 8, 6]} />
        <meshStandardMaterial color={coralColor} roughness={0.6} />
      </mesh>
      <mesh position={[3, trunkHeight, 2]}>
        <sphereGeometry args={[4 + variant, 8, 6]} />
        <meshStandardMaterial color={coralColor} roughness={0.6} />
      </mesh>
      <mesh position={[-3, trunkHeight + 1, -1]}>
        <sphereGeometry args={[3 + variant, 8, 6]} />
        <meshStandardMaterial color={coralColor} roughness={0.6} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Flower
// ---------------------------------------------------------------------------
function Flower({ position, variant }: { position: [number, number, number]; variant: number }) {
  const color = FLOWER_COLORS[variant % 2];
  return (
    <group position={position}>
      {/* Sea anemone base */}
      <mesh position={[0, 0.8, 0]}>
        <cylinderGeometry args={[0.6, 1, 1.6, 6]} />
        <meshStandardMaterial color={0x4a6741} roughness={0.7} />
      </mesh>
      {/* Tentacle cluster */}
      <mesh position={[0, 2.2, 0]}>
        <sphereGeometry args={[1.4, 8, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.15} roughness={0.5} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Bush
// ---------------------------------------------------------------------------
function Bush({ position }: { position: [number, number, number] }) {
  return (
    <group position={[position[0], position[1], position[2]]}>
      {/* Kelp bush cluster */}
      <mesh position={[0, 2, 0]}>
        <sphereGeometry args={[3, 8, 6]} />
        <meshStandardMaterial color={BUSH_COLOR} roughness={0.7} />
      </mesh>
      <mesh position={[1.5, 3, 0.5]}>
        <sphereGeometry args={[2, 8, 6]} />
        <meshStandardMaterial color={0x1b5e20} roughness={0.7} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: All decorations from the decoration layer
// ---------------------------------------------------------------------------
function Decorations() {
  const items = useMemo(() => {
    const rand = seededRandom(777);
    const result: Array<{
      type: 'tree' | 'flower' | 'bush';
      position: [number, number, number];
      variant: number;
    }> = [];

    for (let i = 0; i < decorationLayer.length; i++) {
      const tile = decorationLayer[i];
      if (tile === TILES.EMPTY) continue;

      const col = i % MAP_COLS;
      const row = Math.floor(i / MAP_COLS);
      const [x, , z] = tilePos(col, row);
      // Small random offset for natural feel
      const ox = (rand() - 0.5) * 6;
      const oz = (rand() - 0.5) * 6;
      const pos: [number, number, number] = [x + ox, 0, z + oz];

      if (tile === TILES.TREE_1 || tile === TILES.TREE_2) {
        result.push({ type: 'tree', position: pos, variant: tile === TILES.TREE_1 ? 0 : 1 });
      } else if (tile === TILES.FLOWER_1 || tile === TILES.FLOWER_2) {
        result.push({ type: 'flower', position: pos, variant: tile === TILES.FLOWER_1 ? 0 : 1 });
      } else if (tile === TILES.BUSH) {
        result.push({ type: 'bush', position: pos, variant: 0 });
      }
    }

    return result;
  }, []);

  return (
    <group>
      {items.map((item, i) => {
        switch (item.type) {
          case 'tree':
            return <Tree key={`tree-${i}`} position={item.position} variant={item.variant} />;
          case 'flower':
            return <Flower key={`flower-${i}`} position={item.position} variant={item.variant} />;
          case 'bush':
            return <Bush key={`bush-${i}`} position={item.position} />;
          default:
            return null;
        }
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: Base plane beneath everything
// ---------------------------------------------------------------------------
function BasePlane() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.6, 0]}>
      <planeGeometry args={[MAP_WIDTH + 64, MAP_HEIGHT + 64]} />
      <meshStandardMaterial color={0x0d3b3e} roughness={0.9} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default function ArenaTerrain() {
  return (
    <group>
      {/* Underwater ambient + directional lighting */}
      <ambientLight intensity={0.5} color={0x88ccdd} />
      <directionalLight
        position={[MAP_WIDTH * 0.4, 300, -MAP_HEIGHT * 0.3]}
        intensity={0.8}
        color={0x88ddee}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-MAP_WIDTH / 2}
        shadow-camera-right={MAP_WIDTH / 2}
        shadow-camera-top={MAP_HEIGHT / 2}
        shadow-camera-bottom={-MAP_HEIGHT / 2}
      />
      <hemisphereLight args={[0x1a6e8a, 0x0d3b3e, 0.4]} />

      {/* Base ocean floor plane */}
      <BasePlane />

      {/* Seafloor ground tiles */}
      <GroundTiles />

      {/* Sandy/stone paths */}
      <PathTiles />

      {/* Animated deep water (trench area) */}
      <WaterSurface />

      {/* Coral, anemones, kelp */}
      <Decorations />
    </group>
  );
}
