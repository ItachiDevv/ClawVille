'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Centering offset (map centered at origin)
// ---------------------------------------------------------------------------
const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatLabel(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function zoneCenter(zone: BuildingZone): [number, number, number] {
  const cx = OFFSET_X + (zone.x + zone.width / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  return [cx, 0, cz];
}

function FloatingLabel({ text, y }: { text: string; y: number }) {
  return (
    <group position={[0, y, 0]}>
      <mesh position={[0, -8, 0]}>
        <cylinderGeometry args={[0.7, 1, 14, 8]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.85} />
      </mesh>
      <Billboard follow lockX={false} lockY={false} lockZ={false}>
        <group>
          <mesh scale={[1.95, 1.18, 1]}>
            <circleGeometry args={[10.5, 32]} />
            <meshBasicMaterial color={0x606880} depthTest={false} />
          </mesh>
          <mesh position={[0, 0, 0.2]} scale={[1.72, 1.02, 1]}>
            <circleGeometry args={[9.4, 32]} />
            <meshBasicMaterial color={0xf0efb3} depthTest={false} />
          </mesh>
          <Text
            position={[0, 0.05, 0.5]}
            fontSize={3.9}
            color="#2f3440"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.3}
            outlineColor="#f0efb3"
            maxWidth={30}
          >
            {text}
          </Text>
        </group>
      </Billboard>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Pitched roof (triangular prism) — reused by several buildings
// ---------------------------------------------------------------------------
function PitchedRoof({ width, depth, height, color }: { width: number; depth: number; height: number; color: number }) {
  const geometry = useMemo(() => {
    const hw = width / 2;
    const hd = depth / 2;
    const vertices = new Float32Array([
      -hw, 0, -hd, hw, 0, -hd, 0, height, -hd,
      -hw, 0, hd, hw, 0, hd, 0, height, hd,
      -hw, 0, -hd, 0, height, -hd, 0, height, hd, -hw, 0, hd,
      hw, 0, -hd, hw, 0, hd, 0, height, hd, 0, height, -hd,
      -hw, 0, -hd, -hw, 0, hd, hw, 0, hd, hw, 0, -hd,
    ]);
    const indices = [0, 1, 2, 3, 5, 4, 6, 7, 8, 6, 8, 9, 10, 11, 12, 10, 12, 13, 14, 15, 16, 14, 16, 17];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [width, depth, height]);

  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color={color} roughness={0.7} side={THREE.DoubleSide} />
    </mesh>
  );
}

function seedFromString(text: string): number {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return Math.abs(seed);
}

function seededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

type ScatterTone = 'warm' | 'magic' | 'forest' | 'cool' | 'mint';

const FLOWER_TONES: Record<ScatterTone, number[]> = {
  warm: [0xff7043, 0xffca28, 0xf06292],
  magic: [0xce93d8, 0x69f0ae, 0xffd54f],
  forest: [0x81c784, 0xffeb3b, 0xef5350],
  cool: [0x4fc3f7, 0x80deea, 0x90caf9],
  mint: [0x80cbc4, 0xa5d6a7, 0xdcedc8],
};

type StoneScatter = { x: number; z: number; radius: number; rotation: number; color: number };
type MushroomScatter = { x: number; z: number; stemH: number; capR: number; capColor: number; tilt: number };
type FlowerScatter = { x: number; z: number; bloomR: number; bloomColor: number; stemH: number };

function GroundScatter({
  seedKey,
  radius,
  tone,
}: {
  seedKey: string;
  radius: number;
  tone: ScatterTone;
}) {
  const { stones, mushrooms, flowers } = useMemo(() => {
    const rand = seededRandom(seedFromString(seedKey));
    const colors = FLOWER_TONES[tone];

    const stoneCount = 6 + Math.floor(rand() * 4);
    const stoneItems: StoneScatter[] = [];
    for (let i = 0; i < stoneCount; i++) {
      const angle = (i / stoneCount) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const dist = radius * (0.7 + rand() * 0.45);
      stoneItems.push({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        radius: 1.8 + rand() * 2.4,
        rotation: rand() * Math.PI,
        color: rand() > 0.5 ? 0xb0bec5 : 0x9e9e9e,
      });
    }

    const mushroomCount = 3 + Math.floor(rand() * 3);
    const mushroomItems: MushroomScatter[] = [];
    for (let i = 0; i < mushroomCount; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = radius * (0.35 + rand() * 0.5);
      mushroomItems.push({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        stemH: 1.8 + rand() * 1.5,
        capR: 1.3 + rand() * 1.2,
        capColor: [0xef5350, 0xab47bc, 0xffca28][Math.floor(rand() * 3)],
        tilt: (rand() - 0.5) * 0.35,
      });
    }

    const flowerCount = 10 + Math.floor(rand() * 6);
    const flowerItems: FlowerScatter[] = [];
    for (let i = 0; i < flowerCount; i++) {
      const angle = rand() * Math.PI * 2;
      const dist = radius * (0.2 + rand() * 0.8);
      flowerItems.push({
        x: Math.cos(angle) * dist,
        z: Math.sin(angle) * dist,
        bloomR: 0.8 + rand() * 0.7,
        bloomColor: colors[Math.floor(rand() * colors.length)],
        stemH: 1.1 + rand() * 0.8,
      });
    }

    return { stones: stoneItems, mushrooms: mushroomItems, flowers: flowerItems };
  }, [seedKey, radius, tone]);

  return (
    <group>
      {stones.map((stone, i) => (
        <mesh
          key={`stone-${i}`}
          position={[stone.x, 0.35, stone.z]}
          rotation={[-Math.PI / 2, 0, stone.rotation]}
        >
          <circleGeometry args={[stone.radius, 8]} />
          <meshStandardMaterial color={stone.color} roughness={0.9} />
        </mesh>
      ))}
      {mushrooms.map((mushroom, i) => (
        <group key={`mushroom-${i}`} position={[mushroom.x, 0, mushroom.z]} rotation={[0, 0, mushroom.tilt]}>
          <mesh position={[0, mushroom.stemH * 0.5, 0]}>
            <cylinderGeometry args={[0.35, 0.45, mushroom.stemH, 6]} />
            <meshStandardMaterial color={0xfff8e1} roughness={0.8} />
          </mesh>
          <mesh position={[0, mushroom.stemH + mushroom.capR * 0.35, 0]}>
            <sphereGeometry args={[mushroom.capR, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6]} />
            <meshStandardMaterial color={mushroom.capColor} roughness={0.65} />
          </mesh>
        </group>
      ))}
      {flowers.map((flower, i) => (
        <group key={`flower-${i}`} position={[flower.x, 0, flower.z]}>
          <mesh position={[0, flower.stemH * 0.5, 0]}>
            <cylinderGeometry args={[0.2, 0.2, flower.stemH, 4]} />
            <meshStandardMaterial color={0x2e7d32} roughness={0.8} />
          </mesh>
          <mesh position={[0, flower.stemH + flower.bloomR * 0.35, 0]}>
            <sphereGeometry args={[flower.bloomR, 6, 5]} />
            <meshStandardMaterial color={flower.bloomColor} roughness={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// 1. CRON HUB — Clock tower with gears, pendulum. Brown/gold. Animated pendulum.
// ---------------------------------------------------------------------------
function CronHubBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const pendulumRef = useRef<THREE.Group>(null);
  const gearRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (pendulumRef.current) {
      pendulumRef.current.rotation.z = Math.sin(t * 1.8) * 0.35;
    }
    if (gearRef.current) {
      gearRef.current.rotation.z = t * 0.5;
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Stone base */}
      <mesh position={[0, 12, 0]} castShadow>
        <boxGeometry args={[w * 0.5, 24, w * 0.5]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.85} />
      </mesh>
      {/* Tower body */}
      <mesh position={[0, 38, 0]} castShadow>
        <boxGeometry args={[w * 0.4, 28, w * 0.4]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.8} />
      </mesh>
      {/* Clock face */}
      <mesh position={[0, 42, -w * 0.21]}>
        <circleGeometry args={[8, 24]} />
        <meshStandardMaterial color={0xfff8e1} roughness={0.4} />
      </mesh>
      {/* Clock rim */}
      <mesh position={[0, 42, -w * 0.22]}>
        <torusGeometry args={[8.5, 1, 8, 24]} />
        <meshStandardMaterial color={0xffd700} metalness={0.7} roughness={0.2} />
      </mesh>
      {/* Clock hands */}
      <mesh position={[0, 45, -w * 0.23]} rotation={[0, 0, 0.4]}>
        <boxGeometry args={[0.8, 6, 0.3]} />
        <meshStandardMaterial color={0x3e2723} roughness={0.7} />
      </mesh>
      <mesh position={[0, 43, -w * 0.23]} rotation={[0, 0, -0.8]}>
        <boxGeometry args={[0.6, 4.5, 0.3]} />
        <meshStandardMaterial color={0x3e2723} roughness={0.7} />
      </mesh>
      {/* Pointed roof */}
      <mesh position={[0, 58, 0]} castShadow>
        <coneGeometry args={[w * 0.28, 16, 4]} />
        <meshStandardMaterial color={0x5d4037} roughness={0.75} />
      </mesh>
      {/* Gold finial */}
      <mesh position={[0, 67, 0]}>
        <sphereGeometry args={[2, 8, 8]} />
        <meshStandardMaterial color={0xffd700} metalness={0.8} roughness={0.15} />
      </mesh>
      {/* Gear on front */}
      <mesh ref={gearRef} position={[0, 28, -w * 0.26]}>
        <torusGeometry args={[5, 1.2, 6, 8]} />
        <meshStandardMaterial color={0xffc107} metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Second gear */}
      <mesh position={[8, 25, -w * 0.26]}>
        <torusGeometry args={[3.5, 0.9, 6, 8]} />
        <meshStandardMaterial color={0xffb300} metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Pendulum */}
      <group ref={pendulumRef} position={[0, 16, -w * 0.26]}>
        <mesh position={[0, -5, 0]}>
          <cylinderGeometry args={[0.4, 0.4, 10, 4]} />
          <meshStandardMaterial color={0x5d4037} roughness={0.8} />
        </mesh>
        <mesh position={[0, -11, 0]}>
          <sphereGeometry args={[2.5, 8, 8]} />
          <meshStandardMaterial color={0xffd700} metalness={0.75} roughness={0.2} />
        </mesh>
      </group>
      {/* Door */}
      <mesh position={[0, 7, -w * 0.26]}>
        <boxGeometry args={[8, 14, 1.5]} />
        <meshStandardMaterial color={0x3e2723} roughness={0.85} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={w * 0.55} tone="warm" />
      <FloatingLabel text="Cron Hub" y={78} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 2. WEBHOOK GATEWAY — Gateway arch with glowing signal lines. Orange/amber.
// ---------------------------------------------------------------------------
function WebhookGatewayBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const pulseRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (pulseRef.current) {
      pulseRef.current.children.forEach((child, i) => {
        const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0.3 + Math.sin(t * 3 + i * 1.5) * 0.4;
        mat.opacity = 0.6 + Math.sin(t * 3 + i * 1.5) * 0.3;
      });
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Left pillar */}
      <mesh position={[-w * 0.22, 22, 0]} castShadow>
        <boxGeometry args={[10, 44, 10]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.8} />
      </mesh>
      {/* Right pillar */}
      <mesh position={[w * 0.22, 22, 0]} castShadow>
        <boxGeometry args={[10, 44, 10]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.8} />
      </mesh>
      {/* Arch top */}
      <mesh position={[0, 46, 0]}>
        <torusGeometry args={[w * 0.22, 5, 8, 16, Math.PI]} />
        <meshStandardMaterial color={0xff8f00} roughness={0.5} />
      </mesh>
      {/* Keystone */}
      <mesh position={[0, 52, 0]}>
        <boxGeometry args={[8, 8, 8]} />
        <meshStandardMaterial color={0xffa000} metalness={0.5} roughness={0.3} />
      </mesh>
      {/* Signal lines on pillars */}
      <group ref={pulseRef}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={`pulse-l-${i}`} position={[-w * 0.22, 8 + i * 9, -6]}>
            <boxGeometry args={[2, 1.2, 0.5]} />
            <meshStandardMaterial color={0xff6f00} emissive={0xff6f00} emissiveIntensity={0.5} transparent opacity={0.8} />
          </mesh>
        ))}
        {[0, 1, 2, 3].map((i) => (
          <mesh key={`pulse-r-${i}`} position={[w * 0.22, 8 + i * 9, -6]}>
            <boxGeometry args={[2, 1.2, 0.5]} />
            <meshStandardMaterial color={0xff6f00} emissive={0xff6f00} emissiveIntensity={0.5} transparent opacity={0.8} />
          </mesh>
        ))}
      </group>
      {/* Horizontal signal beam under arch */}
      <mesh position={[0, 36, -5.5]}>
        <boxGeometry args={[w * 0.35, 0.8, 0.4]} />
        <meshStandardMaterial color={0xffca28} emissive={0xffca28} emissiveIntensity={0.4} />
      </mesh>
      {/* Amber lanterns on top of pillars */}
      {[-1, 1].map((side) => (
        <mesh key={`lantern-${side}`} position={[side * w * 0.22, 46, 0]}>
          <sphereGeometry args={[3, 8, 8]} />
          <meshStandardMaterial color={0xffb300} emissive={0xff8f00} emissiveIntensity={0.5} />
        </mesh>
      ))}
      {/* Base platform */}
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[w * 0.7, 2, d * 0.5]} />
        <meshStandardMaterial color={0x795548} roughness={0.85} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={w * 0.5} tone="warm" />
      <FloatingLabel text="Webhook Gateway" y={68} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 3. MEMORY VAULT — Domed vault/bank with heavy door. Green/dark. Inner glow.
// ---------------------------------------------------------------------------
function MemoryVaultBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const glowRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (glowRef.current) {
      const t = clock.getElapsedTime();
      glowRef.current.emissiveIntensity = 0.2 + Math.sin(t * 1.5) * 0.15;
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Vault base */}
      <mesh position={[0, 14, 0]} castShadow>
        <boxGeometry args={[w * 0.7, 28, d * 0.65]} />
        <meshStandardMaterial color={0x2e7d32} roughness={0.75} />
      </mesh>
      {/* Dome roof */}
      <mesh position={[0, 30, 0]} castShadow>
        <sphereGeometry args={[w * 0.38, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
        <meshStandardMaterial color={0x1b5e20} roughness={0.6} />
      </mesh>
      {/* Dark trim bands */}
      {[10, 20].map((y) => (
        <mesh key={`band-${y}`} position={[0, y, -d * 0.33]}>
          <boxGeometry args={[w * 0.72, 1.5, 0.5]} />
          <meshStandardMaterial color={0x1b5e20} roughness={0.7} />
        </mesh>
      ))}
      {/* Heavy vault door */}
      <mesh position={[0, 12, -d * 0.34]}>
        <boxGeometry args={[14, 20, 2]} />
        <meshStandardMaterial color={0x263238} roughness={0.6} metalness={0.4} />
      </mesh>
      {/* Door wheel/lock */}
      <mesh position={[0, 14, -d * 0.36]}>
        <torusGeometry args={[4, 0.8, 6, 16]} />
        <meshStandardMaterial color={0x9e9e9e} metalness={0.7} roughness={0.25} />
      </mesh>
      {/* Inner glow from door cracks */}
      <mesh position={[0, 12, -d * 0.35]}>
        <planeGeometry args={[12, 18]} />
        <meshStandardMaterial ref={glowRef} color={0x69f0ae} emissive={0x69f0ae} emissiveIntensity={0.2} transparent opacity={0.3} />
      </mesh>
      {/* Side columns */}
      {[-1, 1].map((side) => (
        <mesh key={`col-${side}`} position={[side * w * 0.3, 14, -d * 0.34]} castShadow>
          <cylinderGeometry args={[3, 3.5, 28, 8]} />
          <meshStandardMaterial color={0x388e3c} roughness={0.7} />
        </mesh>
      ))}
      {/* Gold rivets on door */}
      {[[-4, 8], [4, 8], [-4, 18], [4, 18]].map((pos, i) => (
        <mesh key={`rivet-${i}`} position={[pos[0], pos[1], -d * 0.36]}>
          <sphereGeometry args={[1, 6, 6]} />
          <meshStandardMaterial color={0xffd700} metalness={0.7} roughness={0.2} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="forest" />
      <FloatingLabel text="Memory Vault" y={62} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 4. SKILL FORGE — Blacksmith forge with anvil, fire. Red/dark iron. Animated flames.
// ---------------------------------------------------------------------------
function SkillForgeBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const flameRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (flameRef.current) {
      flameRef.current.children.forEach((child, i) => {
        const mesh = child as THREE.Mesh;
        mesh.scale.y = 0.8 + Math.sin(t * 5 + i * 2) * 0.4;
        mesh.scale.x = 0.8 + Math.sin(t * 4 + i * 1.3) * 0.2;
        mesh.position.y = 4 + Math.sin(t * 6 + i * 0.8) * 1.5;
      });
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Forge structure */}
      <mesh position={[0, 16, 0]} castShadow>
        <boxGeometry args={[w * 0.6, 32, d * 0.55]} />
        <meshStandardMaterial color={0x424242} roughness={0.9} />
      </mesh>
      {/* Chimney */}
      <mesh position={[w * 0.12, 40, d * 0.1]} castShadow>
        <boxGeometry args={[8, 16, 8]} />
        <meshStandardMaterial color={0x37474f} roughness={0.85} />
      </mesh>
      {/* Fire pit opening */}
      <mesh position={[0, 14, -d * 0.28]}>
        <boxGeometry args={[16, 12, 2]} />
        <meshStandardMaterial color={0x212121} roughness={0.9} />
      </mesh>
      {/* Flames inside */}
      <group ref={flameRef} position={[0, 12, -d * 0.26]}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={`flame-${i}`} position={[-4 + i * 3, 4, 0]}>
            <coneGeometry args={[1.5, 6, 5]} />
            <meshStandardMaterial color={i % 2 === 0 ? 0xff5722 : 0xffca28} emissive={i % 2 === 0 ? 0xff5722 : 0xffca28} emissiveIntensity={0.7} />
          </mesh>
        ))}
      </group>
      {/* Red accent roof */}
      <group position={[0, 32, 0]}>
        <PitchedRoof width={w * 0.7} depth={d * 0.65} height={14} color={0xc62828} />
      </group>
      {/* Anvil */}
      <group position={[-w * 0.25, 0, -d * 0.35]}>
        <mesh position={[0, 4, 0]}>
          <cylinderGeometry args={[3, 4, 8, 6]} />
          <meshStandardMaterial color={0x616161} metalness={0.6} roughness={0.4} />
        </mesh>
        <mesh position={[0, 9, 0]}>
          <boxGeometry args={[10, 2, 5]} />
          <meshStandardMaterial color={0x424242} metalness={0.7} roughness={0.3} />
        </mesh>
      </group>
      {/* Hammer next to anvil */}
      <mesh position={[-w * 0.18, 11, -d * 0.4]} rotation={[0, 0, 0.5]}>
        <cylinderGeometry args={[0.6, 0.6, 10, 4]} />
        <meshStandardMaterial color={0x795548} roughness={0.8} />
      </mesh>
      <mesh position={[-w * 0.14, 15, -d * 0.4]}>
        <boxGeometry args={[3, 3, 3]} />
        <meshStandardMaterial color={0x616161} metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Embers on ground */}
      {[[-3, 0.5, -8], [5, 0.5, -10], [-6, 0.5, -12]].map((pos, i) => (
        <mesh key={`ember-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[0.8, 6, 6]} />
          <meshStandardMaterial color={0xff6f00} emissive={0xff6f00} emissiveIntensity={0.5} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="warm" />
      <FloatingLabel text="Skill Forge" y={60} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 5. CHANNEL BRIDGE — Suspension bridge structure. Blue/silver.
// ---------------------------------------------------------------------------
function ChannelBridgeBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;

  return (
    <group position={[cx, 0, cz]}>
      {/* Bridge deck */}
      <mesh position={[0, 8, 0]} castShadow>
        <boxGeometry args={[w * 0.8, 3, d * 0.35]} />
        <meshStandardMaterial color={0x90a4ae} roughness={0.7} />
      </mesh>
      {/* Deck planks */}
      {[-3, -1, 1, 3].map((i) => (
        <mesh key={`plank-${i}`} position={[i * w * 0.09, 9.8, 0]}>
          <boxGeometry args={[w * 0.08, 0.5, d * 0.33]} />
          <meshStandardMaterial color={0x78909c} roughness={0.8} />
        </mesh>
      ))}
      {/* Left tower */}
      <mesh position={[-w * 0.35, 28, 0]} castShadow>
        <boxGeometry args={[8, 48, 8]} />
        <meshStandardMaterial color={0x42a5f5} roughness={0.5} />
      </mesh>
      {/* Right tower */}
      <mesh position={[w * 0.35, 28, 0]} castShadow>
        <boxGeometry args={[8, 48, 8]} />
        <meshStandardMaterial color={0x42a5f5} roughness={0.5} />
      </mesh>
      {/* Tower caps */}
      {[-1, 1].map((side) => (
        <mesh key={`cap-${side}`} position={[side * w * 0.35, 54, 0]}>
          <coneGeometry args={[6, 8, 4]} />
          <meshStandardMaterial color={0x1e88e5} roughness={0.45} />
        </mesh>
      ))}
      {/* Main cables (top of towers to deck center) */}
      {[-1, 1].map((side) => (
        <group key={`cable-${side}`}>
          <mesh position={[side * w * 0.17, 34, -d * 0.12]} rotation={[0, 0, side * 0.55]}>
            <cylinderGeometry args={[0.4, 0.4, w * 0.38, 4]} />
            <meshStandardMaterial color={0xb0bec5} metalness={0.6} roughness={0.3} />
          </mesh>
          <mesh position={[side * w * 0.17, 34, d * 0.12]} rotation={[0, 0, side * 0.55]}>
            <cylinderGeometry args={[0.4, 0.4, w * 0.38, 4]} />
            <meshStandardMaterial color={0xb0bec5} metalness={0.6} roughness={0.3} />
          </mesh>
        </group>
      ))}
      {/* Vertical suspender cables */}
      {[-2, -1, 0, 1, 2].map((i) => (
        <mesh key={`susp-${i}`} position={[i * w * 0.1, 22, -d * 0.12]}>
          <cylinderGeometry args={[0.25, 0.25, 18 - Math.abs(i) * 4, 4]} />
          <meshStandardMaterial color={0xcfd8dc} metalness={0.5} roughness={0.35} />
        </mesh>
      ))}
      {/* Silver railing */}
      {[-1, 1].map((side) => (
        <mesh key={`rail-${side}`} position={[0, 11, side * d * 0.17]}>
          <boxGeometry args={[w * 0.78, 1, 0.8]} />
          <meshStandardMaterial color={0xb0bec5} metalness={0.5} roughness={0.3} />
        </mesh>
      ))}
      {/* Blue accent light on bridge */}
      <mesh position={[0, 10, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2, 4, 12]} />
        <meshStandardMaterial color={0x42a5f5} emissive={0x42a5f5} emissiveIntensity={0.3} transparent opacity={0.5} side={THREE.DoubleSide} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="cool" />
      <FloatingLabel text="Channel Bridge" y={70} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 6. TOOL WORKSHOP — Workshop shed with tools hanging. Purple/wood brown.
// ---------------------------------------------------------------------------
function ToolWorkshopBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 36;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.03]}>
      {/* Wooden shed body */}
      <mesh position={[0, wallH * 0.45, 0]} castShadow>
        <boxGeometry args={[w * 0.7, wallH * 0.9, d * 0.65]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.85} />
      </mesh>
      {/* Purple accent panel */}
      <mesh position={[0, wallH * 0.45, -d * 0.33]}>
        <boxGeometry args={[w * 0.72, wallH * 0.92, 1]} />
        <meshStandardMaterial color={0x7b1fa2} roughness={0.65} />
      </mesh>
      {/* Pitched roof */}
      <group position={[0, wallH, 0]}>
        <PitchedRoof width={w * 0.82} depth={d * 0.75} height={16} color={0x4a148c} />
      </group>
      {/* Tool pegboard on front */}
      <mesh position={[w * 0.2, wallH * 0.55, -d * 0.34]}>
        <boxGeometry args={[14, 12, 0.5]} />
        <meshStandardMaterial color={0x5d4037} roughness={0.8} />
      </mesh>
      {/* Hanging tools: wrench */}
      <mesh position={[w * 0.16, wallH * 0.6, -d * 0.35]} rotation={[0, 0, 0.3]}>
        <boxGeometry args={[1.5, 8, 0.4]} />
        <meshStandardMaterial color={0x9e9e9e} metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Hanging tools: hammer */}
      <mesh position={[w * 0.22, wallH * 0.58, -d * 0.35]} rotation={[0, 0, -0.2]}>
        <boxGeometry args={[1.2, 7, 0.4]} />
        <meshStandardMaterial color={0x795548} roughness={0.8} />
      </mesh>
      <mesh position={[w * 0.22, wallH * 0.65, -d * 0.36]}>
        <boxGeometry args={[3.5, 2.5, 1]} />
        <meshStandardMaterial color={0x757575} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Hanging tools: saw */}
      <mesh position={[w * 0.28, wallH * 0.52, -d * 0.35]} rotation={[0, 0, 0.1]}>
        <boxGeometry args={[1, 10, 0.3]} />
        <meshStandardMaterial color={0xbdbdbd} metalness={0.5} roughness={0.3} />
      </mesh>
      {/* Workbench outside */}
      <mesh position={[-w * 0.28, 5, -d * 0.38]}>
        <boxGeometry args={[14, 10, 6]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.82} />
      </mesh>
      {/* Parts on bench */}
      {[-2, 1, 4].map((x, i) => (
        <mesh key={`part-${i}`} position={[-w * 0.28 + x, 11, -d * 0.38]}>
          <boxGeometry args={[2, 2, 2]} />
          <meshStandardMaterial color={[0x9c27b0, 0xce93d8, 0x7b1fa2][i]} roughness={0.5} />
        </mesh>
      ))}
      {/* Window */}
      <mesh position={[-w * 0.18, wallH * 0.5, -d * 0.34]}>
        <planeGeometry args={[8, 8]} />
        <meshStandardMaterial color={0xfff8e1} emissive={0xffca28} emissiveIntensity={0.2} />
      </mesh>
      {/* Door */}
      <mesh position={[0, 8, -d * 0.34]}>
        <boxGeometry args={[10, 16, 1.5]} />
        <meshStandardMaterial color={0x4e342e} roughness={0.85} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.48} tone="magic" />
      <FloatingLabel text="Tool Workshop" y={64} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 7. CANVAS STUDIO — Easel/art studio with paint splashes. Pink/multicolor.
// ---------------------------------------------------------------------------
function CanvasStudioBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 38;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.04]}>
      {/* Studio body */}
      <mesh position={[0, wallH * 0.45, 0]} castShadow>
        <boxGeometry args={[w * 0.8, wallH * 0.9, d * 0.75]} />
        <meshStandardMaterial color={0xfce4ec} roughness={0.65} />
      </mesh>
      {/* Side extension */}
      <mesh position={[w * 0.2, wallH * 0.35, d * 0.2]} rotation={[0, 0.1, 0.04]} castShadow>
        <boxGeometry args={[w * 0.3, wallH * 0.5, d * 0.3]} />
        <meshStandardMaterial color={0xf8bbd0} roughness={0.6} />
      </mesh>
      {/* Colorful slanted roof */}
      <group position={[0, wallH, 0]} rotation={[0, 0, 0.04]}>
        <PitchedRoof width={w + 8} depth={d + 6} height={20} color={0xe91e63} />
      </group>
      {/* Skylight */}
      <mesh position={[0, wallH + 11, -3]} rotation={[0.5, 0, 0.04]}>
        <planeGeometry args={[10, 8]} />
        <meshStandardMaterial color={0xbbdefb} emissive={0x90caf9} emissiveIntensity={0.3} transparent opacity={0.8} />
      </mesh>
      {/* Paint splatters on front */}
      {[
        { pos: [-w * 0.25, 22, -d / 2 - 1], color: 0xff5722, r: 3.5 },
        { pos: [w * 0.15, 16, -d / 2 - 1], color: 0x2196f3, r: 3 },
        { pos: [-w * 0.08, 28, -d / 2 - 1], color: 0xffeb3b, r: 2.8 },
        { pos: [w * 0.3, 24, -d / 2 - 1], color: 0x4caf50, r: 3.2 },
        { pos: [w * 0.05, 12, -d / 2 - 1], color: 0x9c27b0, r: 2.5 },
      ].map((splat, i) => (
        <group key={`splat-${i}`} position={splat.pos as [number, number, number]}>
          <mesh>
            <circleGeometry args={[splat.r, 10]} />
            <meshStandardMaterial color={splat.color} roughness={0.55} />
          </mesh>
          <mesh position={[0, -3, 0]}>
            <boxGeometry args={[0.9, 3.5, 0.3]} />
            <meshStandardMaterial color={splat.color} roughness={0.55} />
          </mesh>
        </group>
      ))}
      {/* Giant easel + canvas outside */}
      <group position={[-w * 0.38, 0, -d / 2 - 8]}>
        <mesh position={[-2, 9, 0]} rotation={[0, 0, 0.15]}>
          <cylinderGeometry args={[0.6, 0.6, 18, 4]} />
          <meshStandardMaterial color={0x8d6e63} roughness={0.9} />
        </mesh>
        <mesh position={[2, 9, 0]} rotation={[0, 0, -0.15]}>
          <cylinderGeometry args={[0.6, 0.6, 18, 4]} />
          <meshStandardMaterial color={0x8d6e63} roughness={0.9} />
        </mesh>
        <mesh position={[0, 13, -1]}>
          <boxGeometry args={[10, 8, 0.5]} />
          <meshStandardMaterial color={0xffffff} roughness={0.45} />
        </mesh>
        {/* Paint dabs on canvas */}
        {[[-3, 14], [0, 12], [3, 15]].map((pos, i) => (
          <mesh key={`dab-${i}`} position={[pos[0], pos[1], -1.3]}>
            <circleGeometry args={[1.2, 6]} />
            <meshStandardMaterial color={[0xff5722, 0x2196f3, 0xffeb3b][i]} roughness={0.5} />
          </mesh>
        ))}
      </group>
      {/* Colored pencil fence */}
      {[-2, -1, 0, 1, 2].map((i) => (
        <mesh key={`pencil-${i}`} position={[w * 0.38 + i * 2.5, 5, -d / 2 - 6]} rotation={[0, 0, (i - 1) * 0.03]}>
          <coneGeometry args={[1.2, 10, 6]} />
          <meshStandardMaterial color={[0xef5350, 0x42a5f5, 0xffca28, 0x66bb6a, 0xab47bc][i + 2]} roughness={0.5} />
        </mesh>
      ))}
      {/* Door */}
      <mesh position={[0, 8, -d / 2 - 1]}>
        <boxGeometry args={[10, 16, 1.5]} />
        <meshStandardMaterial color={0x5d4037} roughness={0.8} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="warm" />
      <FloatingLabel text="Canvas Studio" y={70} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 8. VOICE TOWER — Tall radio tower with speaker cone. Grey/blue. Animated sound waves.
// ---------------------------------------------------------------------------
function VoiceTowerBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const wavesRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (wavesRef.current) {
      wavesRef.current.children.forEach((child, i) => {
        const mesh = child as THREE.Mesh;
        const scale = 1 + Math.sin(t * 2.5 - i * 0.8) * 0.3;
        mesh.scale.setScalar(scale);
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.opacity = 0.5 - i * 0.1 + Math.sin(t * 2.5 - i * 0.8) * 0.15;
      });
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Base building */}
      <mesh position={[0, 10, 0]} castShadow>
        <boxGeometry args={[w * 0.45, 20, w * 0.45]} />
        <meshStandardMaterial color={0x78909c} roughness={0.75} />
      </mesh>
      {/* Tower shaft */}
      <mesh position={[0, 36, 0]} castShadow>
        <cylinderGeometry args={[4, 6, 32, 8]} />
        <meshStandardMaterial color={0x607d8b} roughness={0.6} />
      </mesh>
      {/* Lattice cross-braces */}
      {[25, 35, 45].map((y) => (
        <mesh key={`brace-${y}`} position={[0, y, 0]}>
          <boxGeometry args={[12, 0.8, 12]} />
          <meshStandardMaterial color={0x546e7a} roughness={0.65} />
        </mesh>
      ))}
      {/* Antenna top */}
      <mesh position={[0, 56, 0]}>
        <cylinderGeometry args={[0.8, 1.2, 8, 4]} />
        <meshStandardMaterial color={0x455a64} roughness={0.5} />
      </mesh>
      {/* Red beacon light */}
      <mesh position={[0, 61, 0]}>
        <sphereGeometry args={[1.5, 8, 8]} />
        <meshStandardMaterial color={0xef5350} emissive={0xef5350} emissiveIntensity={0.6} />
      </mesh>
      {/* Speaker cone on front */}
      <mesh position={[0, 18, -w * 0.24]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[7, 8, 12]} />
        <meshStandardMaterial color={0x455a64} roughness={0.6} />
      </mesh>
      {/* Speaker face */}
      <mesh position={[0, 18, -w * 0.24 - 4]}>
        <circleGeometry args={[7, 12]} />
        <meshStandardMaterial color={0x37474f} roughness={0.5} />
      </mesh>
      {/* Concentric rings on speaker */}
      {[2, 4, 6].map((r, i) => (
        <mesh key={`ring-${i}`} position={[0, 18, -w * 0.24 - 4.2]}>
          <torusGeometry args={[r, 0.3, 4, 16]} />
          <meshStandardMaterial color={0x546e7a} roughness={0.5} />
        </mesh>
      ))}
      {/* Animated sound waves */}
      <group ref={wavesRef} position={[0, 18, -w * 0.24 - 6]}>
        {[0, 1, 2].map((i) => (
          <mesh key={`wave-${i}`} position={[0, 0, -i * 3]}>
            <torusGeometry args={[5 + i * 3, 0.5, 4, 16, Math.PI]} />
            <meshStandardMaterial color={0x42a5f5} emissive={0x42a5f5} emissiveIntensity={0.3} transparent opacity={0.4} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
      {/* Door */}
      <mesh position={[0, 6, -w * 0.23]}>
        <boxGeometry args={[7, 12, 1.5]} />
        <meshStandardMaterial color={0x37474f} roughness={0.7} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={w * 0.55} tone="cool" />
      <FloatingLabel text="Voice Tower" y={72} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 9. SECURITY FORTRESS — Castle fortress with walls, gate. Cyan/stone grey.
// ---------------------------------------------------------------------------
function SecurityFortressBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;

  return (
    <group position={[cx, 0, cz]}>
      {/* Main keep */}
      <mesh position={[0, 20, 0]} castShadow>
        <boxGeometry args={[w * 0.55, 40, d * 0.5]} />
        <meshStandardMaterial color={0x78909c} roughness={0.85} />
      </mesh>
      {/* Corner towers */}
      {[[-1, -1], [-1, 1], [1, -1], [1, 1]].map((corner, i) => (
        <group key={`tower-${i}`} position={[corner[0] * w * 0.3, 0, corner[1] * d * 0.28]}>
          <mesh position={[0, 24, 0]} castShadow>
            <cylinderGeometry args={[6, 7, 48, 8]} />
            <meshStandardMaterial color={0x90a4ae} roughness={0.8} />
          </mesh>
          {/* Battlement on tower */}
          <mesh position={[0, 49, 0]}>
            <cylinderGeometry args={[7, 6.5, 3, 8]} />
            <meshStandardMaterial color={0x607d8b} roughness={0.75} />
          </mesh>
          {/* Cyan accent ring */}
          <mesh position={[0, 44, 0]}>
            <torusGeometry args={[6.5, 0.8, 6, 12]} />
            <meshStandardMaterial color={0x00bcd4} emissive={0x00bcd4} emissiveIntensity={0.25} />
          </mesh>
        </group>
      ))}
      {/* Crenellations on main keep */}
      {[-2, -1, 0, 1, 2].map((i) => (
        <mesh key={`crenel-${i}`} position={[i * w * 0.1, 42, -d * 0.26]}>
          <boxGeometry args={[4, 4, 3]} />
          <meshStandardMaterial color={0x607d8b} roughness={0.8} />
        </mesh>
      ))}
      {/* Fortress walls connecting towers */}
      {[-1, 1].map((side) => (
        <mesh key={`wall-${side}`} position={[side * w * 0.3, 14, 0]} castShadow>
          <boxGeometry args={[3, 28, d * 0.5]} />
          <meshStandardMaterial color={0x78909c} roughness={0.85} />
        </mesh>
      ))}
      {/* Gate with arch */}
      <mesh position={[0, 10, -d * 0.26]}>
        <boxGeometry args={[14, 20, 3]} />
        <meshStandardMaterial color={0x455a64} roughness={0.8} />
      </mesh>
      <mesh position={[0, 20, -d * 0.26]}>
        <cylinderGeometry args={[7, 7, 3, 12, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color={0x546e7a} roughness={0.75} side={THREE.DoubleSide} />
      </mesh>
      {/* Portcullis lines */}
      {[-4, -2, 0, 2, 4].map((x) => (
        <mesh key={`portcullis-${x}`} position={[x, 10, -d * 0.28]}>
          <boxGeometry args={[0.5, 18, 0.4]} />
          <meshStandardMaterial color={0x37474f} roughness={0.6} metalness={0.4} />
        </mesh>
      ))}
      {/* Cyan shield emblem */}
      <mesh position={[0, 30, -d * 0.27]}>
        <circleGeometry args={[4, 6]} />
        <meshStandardMaterial color={0x00bcd4} emissive={0x00bcd4} emissiveIntensity={0.3} />
      </mesh>
      {/* Flag on top */}
      <mesh position={[0, 46, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 12, 4]} />
        <meshStandardMaterial color={0x455a64} roughness={0.7} />
      </mesh>
      <mesh position={[4, 50, 0]} rotation={[0, 0.2, 0]}>
        <planeGeometry args={[8, 5]} />
        <meshStandardMaterial color={0x00bcd4} roughness={0.5} side={THREE.DoubleSide} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.55} tone="cool" />
      <FloatingLabel text="Security Fortress" y={72} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 10. CONFIG CITADEL — Citadel/command center tower. Grey/white.
// ---------------------------------------------------------------------------
function ConfigCitadelBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;

  return (
    <group position={[cx, 0, cz]}>
      {/* Wide base platform */}
      <mesh position={[0, 3, 0]} castShadow>
        <boxGeometry args={[w * 0.75, 6, d * 0.7]} />
        <meshStandardMaterial color={0xeceff1} roughness={0.7} />
      </mesh>
      {/* Main citadel body */}
      <mesh position={[0, 24, 0]} castShadow>
        <boxGeometry args={[w * 0.55, 36, d * 0.5]} />
        <meshStandardMaterial color={0xb0bec5} roughness={0.65} />
      </mesh>
      {/* Upper command section */}
      <mesh position={[0, 46, 0]} castShadow>
        <boxGeometry args={[w * 0.4, 10, d * 0.38]} />
        <meshStandardMaterial color={0xcfd8dc} roughness={0.55} />
      </mesh>
      {/* Dome on top */}
      <mesh position={[0, 53, 0]} castShadow>
        <sphereGeometry args={[w * 0.22, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
        <meshStandardMaterial color={0xffffff} roughness={0.4} />
      </mesh>
      {/* Spire */}
      <mesh position={[0, 62, 0]}>
        <coneGeometry args={[2, 10, 6]} />
        <meshStandardMaterial color={0xeceff1} roughness={0.4} />
      </mesh>
      {/* Windows in grid pattern */}
      {[0, 1, 2].map((floor) =>
        [-1, 0, 1].map((col) => (
          <mesh key={`win-${floor}-${col}`} position={[col * w * 0.14, 12 + floor * 12, -d * 0.26]}>
            <planeGeometry args={[5, 7]} />
            <meshStandardMaterial color={0xe3f2fd} emissive={0x90caf9} emissiveIntensity={floor === 1 ? 0.3 : 0.15} />
          </mesh>
        ))
      )}
      {/* Control panel details on front */}
      <mesh position={[0, 46, -d * 0.2]}>
        <planeGeometry args={[w * 0.3, 6]} />
        <meshStandardMaterial color={0x78909c} roughness={0.5} />
      </mesh>
      {/* Status LEDs on control panel */}
      {[-3, -1, 1, 3].map((x, i) => (
        <mesh key={`led-${i}`} position={[x * 2, 47, -d * 0.21]}>
          <sphereGeometry args={[0.6, 6, 6]} />
          <meshStandardMaterial color={[0x4caf50, 0x4caf50, 0xffeb3b, 0x4caf50][i]} emissive={[0x4caf50, 0x4caf50, 0xffeb3b, 0x4caf50][i]} emissiveIntensity={0.4} />
        </mesh>
      ))}
      {/* Side buttresses */}
      {[-1, 1].map((side) => (
        <mesh key={`buttress-${side}`} position={[side * w * 0.3, 15, 0]} castShadow>
          <boxGeometry args={[4, 24, d * 0.3]} />
          <meshStandardMaterial color={0x90a4ae} roughness={0.7} />
        </mesh>
      ))}
      {/* Entry door */}
      <mesh position={[0, 8, -d * 0.26]}>
        <boxGeometry args={[10, 14, 1.5]} />
        <meshStandardMaterial color={0x607d8b} roughness={0.7} />
      </mesh>
      {/* Steps */}
      {[0, 1].map((step) => (
        <mesh key={`step-${step}`} position={[0, 1.5 + step * 1.5, -d * 0.3 - step * 2]}>
          <boxGeometry args={[14, 1.3, 2.5]} />
          <meshStandardMaterial color={0xeceff1} roughness={0.6} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.52} tone="mint" />
      <FloatingLabel text="Config Citadel" y={78} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Building dispatcher
// ---------------------------------------------------------------------------
const BUILDING_RENDERERS: Record<string, React.FC<{ zone: BuildingZone }>> = {
  'cron-hub': CronHubBuilding,
  'webhook-gateway': WebhookGatewayBuilding,
  'memory-vault': MemoryVaultBuilding,
  'skill-forge': SkillForgeBuilding,
  'channel-bridge': ChannelBridgeBuilding,
  'tool-workshop': ToolWorkshopBuilding,
  'canvas-studio': CanvasStudioBuilding,
  'voice-tower': VoiceTowerBuilding,
  'security-fortress': SecurityFortressBuilding,
  'config-citadel': ConfigCitadelBuilding,
};

function BuildingMesh({ zone }: { zone: BuildingZone }) {
  const Renderer = BUILDING_RENDERERS[zone.id];
  if (!Renderer) return null;
  return <Renderer zone={zone} />;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default function ArenaBuildings() {
  return (
    <group>
      {buildingZones.map((zone) => (
        <BuildingMesh key={zone.id} zone={zone} />
      ))}
    </group>
  );
}
