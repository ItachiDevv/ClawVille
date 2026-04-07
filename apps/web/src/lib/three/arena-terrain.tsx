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
// Seeded random
// ---------------------------------------------------------------------------
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// UNDERWATER COLOR PALETTE — SpongeBob Bikini Bottom style
// ---------------------------------------------------------------------------

// Sandy ocean floor (warm, bright sand — like Bikini Bottom)
const SAND_COLORS = [
  new THREE.Color(0xd4b896), // Warm sand
  new THREE.Color(0xc9a97a), // Medium sand
  new THREE.Color(0xe8d5b7), // Light sand
  new THREE.Color(0xbfa06a), // Darker sand patches
];

// Paths — smooth packed sand and sea-stones
const PATH_COLORS: Record<number, THREE.Color> = {
  [TILES.DIRT_PATH]: new THREE.Color(0xb89b71), // Packed sand path
  [TILES.STONE_PATH]: new THREE.Color(0x8faaaa), // Smooth sea-stones
};

// Water trench
const WATER_COLOR = new THREE.Color(0x1a8bba);
const WATER_COLOR_DEEP = new THREE.Color(0x0d6b9b);

// Coral — vibrant reef colors
const CORAL_COLORS = [
  new THREE.Color(0xff6f61), // Living coral
  new THREE.Color(0xff4081), // Hot pink
  new THREE.Color(0xe65100), // Orange
  new THREE.Color(0xffab40), // Amber
  new THREE.Color(0x7c4dff), // Purple
  new THREE.Color(0x00e5ff), // Cyan
];

// Kelp / seaweed
const KELP_COLORS = [
  new THREE.Color(0x2e7d32),
  new THREE.Color(0x388e3c),
  new THREE.Color(0x1b5e20),
];

// Anemone
const ANEMONE_COLORS = [
  new THREE.Color(0xff4081),
  new THREE.Color(0x7c4dff),
  new THREE.Color(0x00e5ff),
  new THREE.Color(0xffeb3b),
];

// Centering
const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

function tilePos(col: number, row: number): [number, number, number] {
  return [
    OFFSET_X + col * TILE_SIZE + TILE_SIZE / 2,
    0,
    OFFSET_Z + row * TILE_SIZE + TILE_SIZE / 2,
  ];
}

// ---------------------------------------------------------------------------
// Sand ripple detail — scattered small bumps for visual interest
// ---------------------------------------------------------------------------
function SandRipples() {
  const ripples = useMemo(() => {
    const rand = seededRandom(42);
    const items: { x: number; z: number; sx: number; sz: number; rot: number }[] = [];
    for (let i = 0; i < 60; i++) {
      items.push({
        x: OFFSET_X + rand() * MAP_WIDTH,
        z: OFFSET_Z + rand() * MAP_HEIGHT,
        sx: 20 + rand() * 40,
        sz: 10 + rand() * 20,
        rot: rand() * Math.PI,
      });
    }
    return items;
  }, []);

  return (
    <group>
      {ripples.map((r, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, r.rot, 0]} position={[r.x, -0.5, r.z]} receiveShadow>
          <planeGeometry args={[r.sx, r.sz]} />
          <meshStandardMaterial color={0xc9a97a} roughness={1} transparent opacity={0.5} />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Path Tiles — individual meshes for reliability
// ---------------------------------------------------------------------------
function PathTiles() {
  const paths = useMemo(() => {
    const rand = seededRandom(99);
    const items: { x: number; y: number; z: number; color: string }[] = [];

    for (let i = 0; i < pathLayer.length; i++) {
      const tile = pathLayer[i];
      if (tile === TILES.EMPTY) continue;

      const col = i % MAP_COLS;
      const row = Math.floor(i / MAP_COLS);
      const [x, , z] = tilePos(col, row);
      const y = 0.3 + rand() * 0.1;
      const color = tile === TILES.STONE_PATH ? '#8faaaa' : '#b89b71';
      items.push({ x, y, z, color });
    }
    return items;
  }, []);

  // Group path tiles by color to reduce draw calls
  return (
    <group>
      {paths.map((p, i) => (
        <mesh key={i} position={[p.x, p.y, p.z]}>
          <boxGeometry args={[TILE_SIZE, 0.5, TILE_SIZE]} />
          <meshStandardMaterial color={p.color} roughness={0.8} />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Animated Water (trench area)
// ---------------------------------------------------------------------------
function WaterSurface() {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);

  const waterTiles = useMemo(() => {
    const tiles: Array<[number, number]> = [];
    for (let i = 0; i < groundLayer.length; i++) {
      if (groundLayer[i] === TILES.WATER) {
        tiles.push([i % MAP_COLS, Math.floor(i / MAP_COLS)]);
      }
    }
    return tiles;
  }, []);

  const { centerX, centerZ, width, height } = useMemo(() => {
    if (waterTiles.length === 0) return { centerX: 0, centerZ: 0, width: 0, height: 0 };
    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    for (const [c, r] of waterTiles) {
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
    }
    return {
      centerX: OFFSET_X + (minCol + (maxCol - minCol + 1) / 2) * TILE_SIZE,
      centerZ: OFFSET_Z + (minRow + (maxRow - minRow + 1) / 2) * TILE_SIZE,
      width: (maxCol - minCol + 1) * TILE_SIZE,
      height: (maxRow - minRow + 1) * TILE_SIZE,
    };
  }, [waterTiles]);

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
// Branch Coral (replaces Tree)
// ---------------------------------------------------------------------------
function BranchCoral({ position, variant }: { position: [number, number, number]; variant: number }) {
  const color = CORAL_COLORS[variant % CORAL_COLORS.length];
  const height = 10 + variant * 4;

  return (
    <group position={position}>
      {/* Coral trunk */}
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[1.5, 2.5, height, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      {/* Coral branches */}
      <mesh position={[3, height * 0.7, 1]} rotation={[0, 0, 0.4]}>
        <cylinderGeometry args={[0.8, 1.2, height * 0.5, 6]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      <mesh position={[-2, height * 0.8, -1]} rotation={[0, 0, -0.3]}>
        <cylinderGeometry args={[0.6, 1, height * 0.4, 6]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      {/* Bulbous tips */}
      <mesh position={[0, height + 1, 0]}>
        <sphereGeometry args={[2.5 + variant, 8, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.1} roughness={0.4} />
      </mesh>
      <mesh position={[4, height * 0.9, 1.5]}>
        <sphereGeometry args={[1.8 + variant * 0.5, 8, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.1} roughness={0.4} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Sea Anemone (replaces Flower)
// ---------------------------------------------------------------------------
function SeaAnemone({ position, variant }: { position: [number, number, number]; variant: number }) {
  const color = ANEMONE_COLORS[variant % ANEMONE_COLORS.length];
  const groupRef = useRef<THREE.Group>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      const t = clock.getElapsedTime();
      const s = 1 + Math.sin(t * 1.5 + phase) * 0.08;
      groupRef.current.scale.set(s, s, s);
    }
  });

  return (
    <group position={position} ref={groupRef}>
      {/* Base */}
      <mesh position={[0, 1, 0]}>
        <cylinderGeometry args={[1, 2, 2, 8]} />
        <meshStandardMaterial color={0x4a6741} roughness={0.7} />
      </mesh>
      {/* Glowing tentacle cluster */}
      <mesh position={[0, 3, 0]}>
        <sphereGeometry args={[2, 10, 8]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.25}
          roughness={0.3}
          transparent
          opacity={0.9}
        />
      </mesh>
      {/* Smaller orbs */}
      {[0, 1.2, 2.4, 3.6, 4.8].map((angle, i) => (
        <mesh
          key={i}
          position={[
            Math.cos(angle * Math.PI) * 1.6,
            2.5,
            Math.sin(angle * Math.PI) * 1.6,
          ]}
        >
          <sphereGeometry args={[0.7, 6, 4]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.3}
            transparent
            opacity={0.8}
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Kelp Bush (replaces Bush) — with gentle sway
// ---------------------------------------------------------------------------
function KelpBush({ position }: { position: [number, number, number] }) {
  const groupRef = useRef<THREE.Group>(null);
  const phaseOffset = useMemo(() => Math.random() * Math.PI * 2, []);
  const kelpColor = KELP_COLORS[Math.floor(Math.random() * KELP_COLORS.length)];

  useFrame(({ clock }) => {
    if (groupRef.current) {
      const t = clock.getElapsedTime();
      groupRef.current.rotation.z = Math.sin(t * 0.8 + phaseOffset) * 0.1;
      groupRef.current.rotation.x = Math.cos(t * 0.6 + phaseOffset * 0.7) * 0.05;
    }
  });

  return (
    <group position={position}>
      <group ref={groupRef}>
        {/* Kelp fronds */}
        <mesh position={[0, 4, 0]}>
          <boxGeometry args={[2.5, 8, 0.8]} />
          <meshStandardMaterial color={kelpColor} transparent opacity={0.85} roughness={0.6} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[1.5, 3.5, 0.5]} rotation={[0, 0.5, 0.15]}>
          <boxGeometry args={[2, 7, 0.6]} />
          <meshStandardMaterial color={kelpColor} transparent opacity={0.8} roughness={0.6} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[-1, 3, -0.5]} rotation={[0, -0.3, -0.1]}>
          <boxGeometry args={[1.8, 6, 0.6]} />
          <meshStandardMaterial color={kelpColor} transparent opacity={0.8} roughness={0.6} side={THREE.DoubleSide} />
        </mesh>
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Decorations from tilemap
// ---------------------------------------------------------------------------
function Decorations() {
  const items = useMemo(() => {
    const rand = seededRandom(777);
    const result: Array<{
      type: 'coral' | 'anemone' | 'kelp';
      position: [number, number, number];
      variant: number;
    }> = [];

    for (let i = 0; i < decorationLayer.length; i++) {
      const tile = decorationLayer[i];
      if (tile === TILES.EMPTY) continue;

      const col = i % MAP_COLS;
      const row = Math.floor(i / MAP_COLS);
      const [x, , z] = tilePos(col, row);
      const ox = (rand() - 0.5) * 6;
      const oz = (rand() - 0.5) * 6;
      const pos: [number, number, number] = [x + ox, 0, z + oz];

      if (tile === TILES.TREE_1 || tile === TILES.TREE_2) {
        result.push({ type: 'coral', position: pos, variant: tile === TILES.TREE_1 ? 0 : 1 });
      } else if (tile === TILES.FLOWER_1 || tile === TILES.FLOWER_2) {
        result.push({ type: 'anemone', position: pos, variant: tile === TILES.FLOWER_1 ? 0 : 1 });
      } else if (tile === TILES.BUSH) {
        result.push({ type: 'kelp', position: pos, variant: 0 });
      }
    }

    return result;
  }, []);

  return (
    <group>
      {items.map((item, i) => {
        switch (item.type) {
          case 'coral':
            return <BranchCoral key={`c-${i}`} position={item.position} variant={item.variant} />;
          case 'anemone':
            return <SeaAnemone key={`a-${i}`} position={item.position} variant={item.variant} />;
          case 'kelp':
            return <KelpBush key={`k-${i}`} position={item.position} />;
          default:
            return null;
        }
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Scattered shells, starfish, sea urchins on the sand
// ---------------------------------------------------------------------------
function SeaFloorDetails() {
  const items = useMemo(() => {
    const rand = seededRandom(555);
    const details: Array<{
      type: 'shell' | 'starfish' | 'rock' | 'urchin';
      pos: [number, number, number];
      rot: number;
      scale: number;
      color: THREE.Color;
    }> = [];

    for (let i = 0; i < 60; i++) {
      const x = OFFSET_X + rand() * MAP_WIDTH;
      const z = OFFSET_Z + rand() * MAP_HEIGHT;
      const r = rand();
      const type = r < 0.3 ? 'shell' : r < 0.5 ? 'starfish' : r < 0.75 ? 'rock' : 'urchin';
      const colorMap: Record<string, THREE.Color[]> = {
        shell: [new THREE.Color(0xfff5e1), new THREE.Color(0xffe0b2), new THREE.Color(0xffccbc)],
        starfish: [new THREE.Color(0xff5722), new THREE.Color(0xff7043), new THREE.Color(0xffab91)],
        rock: [new THREE.Color(0x78909c), new THREE.Color(0x90a4ae), new THREE.Color(0x607d8b)],
        urchin: [new THREE.Color(0x311b92), new THREE.Color(0x4a148c), new THREE.Color(0x1a237e)],
      };
      details.push({
        type,
        pos: [x, 0.5, z],
        rot: rand() * Math.PI * 2,
        scale: 0.5 + rand() * 1.0,
        color: colorMap[type][Math.floor(rand() * 3)],
      });
    }
    return details;
  }, []);

  return (
    <group>
      {items.map((item, i) => {
        if (item.type === 'shell') {
          return (
            <mesh key={i} position={item.pos} rotation={[0, item.rot, 0]} scale={item.scale}>
              <sphereGeometry args={[1, 8, 4, 0, Math.PI]} />
              <meshStandardMaterial color={item.color} roughness={0.6} />
            </mesh>
          );
        }
        if (item.type === 'starfish') {
          return (
            <mesh key={i} position={item.pos} rotation={[-Math.PI / 2, 0, item.rot]} scale={item.scale}>
              <circleGeometry args={[1.5, 5]} />
              <meshStandardMaterial color={item.color} roughness={0.7} side={THREE.DoubleSide} />
            </mesh>
          );
        }
        if (item.type === 'rock') {
          return (
            <mesh key={i} position={item.pos} rotation={[0, item.rot, 0]} scale={[item.scale, item.scale * 0.6, item.scale]}>
              <dodecahedronGeometry args={[1.5, 0]} />
              <meshStandardMaterial color={item.color} roughness={0.9} />
            </mesh>
          );
        }
        return (
          <mesh key={i} position={item.pos} rotation={[0, item.rot, 0]} scale={item.scale * 0.8}>
            <sphereGeometry args={[1.2, 8, 8]} />
            <meshStandardMaterial color={item.color} roughness={0.3} metalness={0.2} />
          </mesh>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Animated Bubbles rising from the floor
// ---------------------------------------------------------------------------
function UnderwaterBubbles() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const bubbleCount = 80;

  const bubbleData = useMemo(() => {
    const data: Array<{
      x: number; y: number; z: number;
      speed: number; wobblePhase: number; wobbleAmp: number;
      baseX: number; baseZ: number; size: number;
    }> = [];
    for (let i = 0; i < bubbleCount; i++) {
      const x = OFFSET_X + Math.random() * MAP_WIDTH;
      const z = OFFSET_Z + Math.random() * MAP_HEIGHT;
      data.push({
        x, y: Math.random() * 150, z,
        speed: 8 + Math.random() * 15,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleAmp: 1 + Math.random() * 2,
        baseX: x, baseZ: z,
        size: 0.3 + Math.random() * 1.0,
      });
    }
    return data;
  }, []);

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = clock.getElapsedTime();
    const tempObj = new THREE.Object3D();

    for (let i = 0; i < bubbleCount; i++) {
      const b = bubbleData[i];
      b.y += b.speed * 0.016;
      if (b.y > 200) {
        b.y = -5;
        b.x = b.baseX + (Math.random() - 0.5) * 20;
        b.z = b.baseZ + (Math.random() - 0.5) * 20;
      }

      const wx = Math.sin(t * 1.2 + b.wobblePhase) * b.wobbleAmp;
      const wz = Math.cos(t * 0.9 + b.wobblePhase * 0.7) * b.wobbleAmp * 0.6;

      tempObj.position.set(b.x + wx, b.y, b.z + wz);
      tempObj.scale.setScalar(b.size);
      tempObj.updateMatrix();
      mesh.setMatrixAt(i, tempObj.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, bubbleCount]}>
      <sphereGeometry args={[1, 8, 6]} />
      <meshStandardMaterial
        color={0xccf5ff}
        transparent
        opacity={0.3}
        roughness={0.0}
        metalness={0.8}
      />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Underwater Light Rays (god rays from surface)
// ---------------------------------------------------------------------------
function LightRays() {
  const raysRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (raysRef.current) {
      const t = clock.getElapsedTime();
      raysRef.current.children.forEach((child, i) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.opacity = 0.04 + Math.sin(t * 0.5 + i * 1.2) * 0.025;
        }
      });
    }
  });

  const rays = useMemo(() => {
    const rand = seededRandom(333);
    return Array.from({ length: 8 }).map(() => ({
      x: OFFSET_X + rand() * MAP_WIDTH,
      z: OFFSET_Z + rand() * MAP_HEIGHT,
      width: 30 + rand() * 50,
      rotation: rand() * 0.3 - 0.15,
    }));
  }, []);

  return (
    <group ref={raysRef}>
      {rays.map((ray, i) => (
        <mesh key={i} position={[ray.x, 80, ray.z]} rotation={[0, 0, ray.rotation]}>
          <planeGeometry args={[ray.width, 200]} />
          <meshBasicMaterial
            color={0x88ddff}
            transparent
            opacity={0.05}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Caustic Light Pattern on the floor
// ---------------------------------------------------------------------------
function CausticLight() {
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0x66ccff) },
  }), []);

  useFrame(({ clock }) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = clock.getElapsedTime();
    }
  });

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 1.2, 0]}>
      <planeGeometry args={[MAP_WIDTH, MAP_HEIGHT]} />
      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        uniforms={uniforms}
        vertexShader={`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          uniform float uTime;
          uniform vec3 uColor;
          varying vec2 vUv;

          float caustic(vec2 uv, float time) {
            vec2 p = uv * 8.0;
            float c = 0.0;
            c += sin(p.x * 3.0 + time * 0.8) * cos(p.y * 2.5 + time * 0.6) * 0.5;
            c += sin(p.x * 1.5 - time * 0.4 + p.y * 2.0) * 0.3;
            c += cos(p.y * 4.0 + time * 1.0 + p.x * 1.5) * 0.2;
            return clamp(c, 0.0, 1.0);
          }

          void main() {
            float c = caustic(vUv, uTime);
            gl_FragColor = vec4(uColor, c * 0.1);
          }
        `}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Base plane (deep sand beneath tiles)
// ---------------------------------------------------------------------------
function BasePlane() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1, 0]}>
      <planeGeometry args={[MAP_WIDTH + 200, MAP_HEIGHT + 200]} />
      <meshStandardMaterial color={0xe8d5b7} roughness={0.9} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default function ArenaTerrain() {
  return (
    <group>
      {/* Underwater ambient + directional lighting — bright enough to see sandy floor */}
      <ambientLight intensity={0.9} color={0xaaddee} />
      <directionalLight
        position={[MAP_WIDTH * 0.3, 400, -MAP_HEIGHT * 0.2]}
        intensity={1.2}
        color={0xffeedd}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-MAP_WIDTH / 2}
        shadow-camera-right={MAP_WIDTH / 2}
        shadow-camera-top={MAP_HEIGHT / 2}
        shadow-camera-bottom={-MAP_HEIGHT / 2}
      />
      {/* Sky light — blue above, warm sand below */}
      <hemisphereLight args={[0x88bbdd, 0xe8d5b7, 0.6]} />
      {/* Warm underwater sun column */}
      <pointLight position={[0, 300, 0]} intensity={0.5} color={0x88eeff} distance={1200} />

      {/* Sandy ocean floor */}
      <BasePlane />
      <SandRipples />
      <PathTiles />

      {/* Deep water trench */}
      <WaterSurface />

      {/* Underwater effects */}
      <CausticLight />
      <LightRays />
      <UnderwaterBubbles />

      {/* Floor scatter — shells, starfish, rocks */}
      <SeaFloorDetails />

      {/* Living reef — coral, kelp, anemones */}
      <Decorations />
    </group>
  );
}
