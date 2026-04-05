'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard } from '@react-three/drei';
import * as THREE from 'three/webgpu';
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
      {/* Kelp stalk post */}
      <mesh position={[0, -8, 0]}>
        <cylinderGeometry args={[0.7, 1, 14, 8]} />
        <meshStandardMaterial color={0x2e7d32} roughness={0.75} />
      </mesh>
      <Billboard follow lockX={false} lockY={false} lockZ={false}>
        <group>
          {/* Shell-shaped sign background */}
          <mesh scale={[1.95, 1.18, 1]}>
            <circleGeometry args={[10.5, 32]} />
            <meshBasicMaterial color={0x1a4a5a} depthTest={false} />
          </mesh>
          <mesh position={[0, 0, 0.2]} scale={[1.72, 1.02, 1]}>
            <circleGeometry args={[9.4, 32]} />
            <meshBasicMaterial color={0xe0f2f1} depthTest={false} />
          </mesh>
          <Text
            position={[0, 0.05, 0.5]}
            fontSize={3.9}
            color="#0d3b3e"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.3}
            outlineColor="#e0f2f1"
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

// Sea-themed scatter tones (coral, anemone, bioluminescent)
const FLOWER_TONES: Record<ScatterTone, number[]> = {
  warm: [0xff6f61, 0xff8a65, 0xffab91],      // Warm coral
  magic: [0x7c4dff, 0x00e5ff, 0x69f0ae],      // Bioluminescent
  forest: [0x00897b, 0x26a69a, 0x4db6ac],     // Kelp/seagrass
  cool: [0x039be5, 0x4fc3f7, 0x81d4fa],       // Deep ocean blue
  mint: [0x80cbc4, 0x4dd0e1, 0x84ffff],       // Tropical shallows
};

type StoneScatter = { x: number; z: number; radius: number; rotation: number; color: number }; // shells/pebbles
type MushroomScatter = { x: number; z: number; stemH: number; capR: number; capColor: number; tilt: number }; // sea urchins
type FlowerScatter = { x: number; z: number; bloomR: number; bloomColor: number; stemH: number }; // anemones

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
        color: rand() > 0.5 ? 0xc2b280 : 0xa89070, // sandy shells
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
        capColor: [0x7b1fa2, 0x1a237e, 0x004d40][Math.floor(rand() * 3)], // sea urchin colors
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
        <group key={`urchin-${i}`} position={[mushroom.x, 0, mushroom.z]} rotation={[0, 0, mushroom.tilt]}>
          {/* Sea urchin body */}
          <mesh position={[0, mushroom.capR * 0.5 + 0.2, 0]}>
            <sphereGeometry args={[mushroom.capR, 8, 6]} />
            <meshStandardMaterial color={mushroom.capColor} roughness={0.5} />
          </mesh>
        </group>
      ))}
      {flowers.map((flower, i) => (
        <group key={`anemone-${i}`} position={[flower.x, 0, flower.z]}>
          {/* Anemone base */}
          <mesh position={[0, flower.stemH * 0.4, 0]}>
            <cylinderGeometry args={[0.3, 0.4, flower.stemH * 0.8, 4]} />
            <meshStandardMaterial color={0x2e6b62} roughness={0.7} />
          </mesh>
          {/* Anemone tentacles */}
          <mesh position={[0, flower.stemH + flower.bloomR * 0.3, 0]}>
            <sphereGeometry args={[flower.bloomR, 6, 5]} />
            <meshStandardMaterial color={flower.bloomColor} emissive={flower.bloomColor} emissiveIntensity={0.1} roughness={0.5} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// 1. TIDE CLOCK GROTTO — Giant conch shell with tidal clock face. Ocean teal/pearl.
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
      {/* Coral rock base */}
      <mesh position={[0, 12, 0]} castShadow>
        <boxGeometry args={[w * 0.5, 24, w * 0.5]} />
        <meshStandardMaterial color={0x3e6b62} roughness={0.85} />
      </mesh>
      {/* Conch tower body */}
      <mesh position={[0, 38, 0]} castShadow>
        <cylinderGeometry args={[w * 0.18, w * 0.22, 28, 8]} />
        <meshStandardMaterial color={0xffccbc} roughness={0.6} />
      </mesh>
      {/* Tide clock face (shell-like) */}
      <mesh position={[0, 42, -w * 0.19]}>
        <circleGeometry args={[8, 24]} />
        <meshStandardMaterial color={0xe0f7fa} roughness={0.35} />
      </mesh>
      {/* Clock rim — pearl */}
      <mesh position={[0, 42, -w * 0.20]}>
        <torusGeometry args={[8.5, 1, 8, 24]} />
        <meshStandardMaterial color={0xfce4ec} metalness={0.5} roughness={0.25} />
      </mesh>
      {/* Clock hands */}
      <mesh position={[0, 45, -w * 0.21]} rotation={[0, 0, 0.4]}>
        <boxGeometry args={[0.8, 6, 0.3]} />
        <meshStandardMaterial color={0x004d40} roughness={0.7} />
      </mesh>
      <mesh position={[0, 43, -w * 0.21]} rotation={[0, 0, -0.8]}>
        <boxGeometry args={[0.6, 4.5, 0.3]} />
        <meshStandardMaterial color={0x004d40} roughness={0.7} />
      </mesh>
      {/* Spiral shell top */}
      <mesh position={[0, 58, 0]} castShadow>
        <coneGeometry args={[w * 0.22, 16, 12]} />
        <meshStandardMaterial color={0xffab91} roughness={0.5} />
      </mesh>
      {/* Pearl finial */}
      <mesh position={[0, 67, 0]}>
        <sphereGeometry args={[2, 12, 12]} />
        <meshStandardMaterial color={0xfff3e0} metalness={0.4} roughness={0.2} />
      </mesh>
      {/* Barnacle gears */}
      <mesh ref={gearRef} position={[0, 28, -w * 0.24]}>
        <torusGeometry args={[5, 1.2, 6, 8]} />
        <meshStandardMaterial color={0x80cbc4} metalness={0.4} roughness={0.35} />
      </mesh>
      <mesh position={[8, 25, -w * 0.24]}>
        <torusGeometry args={[3.5, 0.9, 6, 8]} />
        <meshStandardMaterial color={0x4db6ac} metalness={0.4} roughness={0.35} />
      </mesh>
      {/* Kelp pendulum */}
      <group ref={pendulumRef} position={[0, 16, -w * 0.24]}>
        <mesh position={[0, -5, 0]}>
          <cylinderGeometry args={[0.4, 0.4, 10, 4]} />
          <meshStandardMaterial color={0x2e7d32} roughness={0.7} />
        </mesh>
        <mesh position={[0, -11, 0]}>
          <sphereGeometry args={[2.5, 8, 8]} />
          <meshStandardMaterial color={0xfce4ec} metalness={0.5} roughness={0.25} />
        </mesh>
      </group>
      {/* Cave entrance */}
      <mesh position={[0, 7, -w * 0.24]}>
        <boxGeometry args={[8, 14, 1.5]} />
        <meshStandardMaterial color={0x1a3c34} roughness={0.85} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={w * 0.55} tone="warm" />
      <FloatingLabel text="Tide Clock Grotto" y={78} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 2. CURRENT GATEWAY — Coral arch with bioluminescent current lines.
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
      {/* Left coral pillar */}
      <mesh position={[-w * 0.22, 22, 0]} castShadow>
        <cylinderGeometry args={[4, 6, 44, 8]} />
        <meshStandardMaterial color={0xff8a65} roughness={0.7} />
      </mesh>
      {/* Right coral pillar */}
      <mesh position={[w * 0.22, 22, 0]} castShadow>
        <cylinderGeometry args={[4, 6, 44, 8]} />
        <meshStandardMaterial color={0xff8a65} roughness={0.7} />
      </mesh>
      {/* Coral arch top */}
      <mesh position={[0, 46, 0]}>
        <torusGeometry args={[w * 0.22, 5, 8, 16, Math.PI]} />
        <meshStandardMaterial color={0xef6c00} roughness={0.55} />
      </mesh>
      {/* Keystone — giant pearl */}
      <mesh position={[0, 52, 0]}>
        <sphereGeometry args={[5, 12, 12]} />
        <meshStandardMaterial color={0xfff3e0} metalness={0.4} roughness={0.2} />
      </mesh>
      {/* Bioluminescent current lines */}
      <group ref={pulseRef}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={`pulse-l-${i}`} position={[-w * 0.22, 8 + i * 9, -5]}>
            <boxGeometry args={[2, 1.2, 0.5]} />
            <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.5} transparent opacity={0.8} />
          </mesh>
        ))}
        {[0, 1, 2, 3].map((i) => (
          <mesh key={`pulse-r-${i}`} position={[w * 0.22, 8 + i * 9, -5]}>
            <boxGeometry args={[2, 1.2, 0.5]} />
            <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.5} transparent opacity={0.8} />
          </mesh>
        ))}
      </group>
      {/* Current beam under arch */}
      <mesh position={[0, 36, -5.5]}>
        <boxGeometry args={[w * 0.35, 0.8, 0.4]} />
        <meshStandardMaterial color={0x00bcd4} emissive={0x00bcd4} emissiveIntensity={0.4} />
      </mesh>
      {/* Jellyfish lanterns on top */}
      {[-1, 1].map((side) => (
        <mesh key={`lantern-${side}`} position={[side * w * 0.22, 46, 0]}>
          <sphereGeometry args={[3, 8, 8]} />
          <meshStandardMaterial color={0x80deea} emissive={0x00bcd4} emissiveIntensity={0.4} transparent opacity={0.7} />
        </mesh>
      ))}
      {/* Sandy base platform */}
      <mesh position={[0, 1, 0]}>
        <boxGeometry args={[w * 0.7, 2, d * 0.5]} />
        <meshStandardMaterial color={0xc2b280} roughness={0.85} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={w * 0.5} tone="cool" />
      <FloatingLabel text="Current Gateway" y={68} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 3. ABYSSAL VAULT — Deep-sea nautilus chamber sealed in rock. Dark blue/green glow.
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
      {/* Abyssal rock base */}
      <mesh position={[0, 14, 0]} castShadow>
        <boxGeometry args={[w * 0.7, 28, d * 0.65]} />
        <meshStandardMaterial color={0x1a3a4a} roughness={0.85} />
      </mesh>
      {/* Nautilus dome */}
      <mesh position={[0, 30, 0]} castShadow>
        <sphereGeometry args={[w * 0.38, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
        <meshStandardMaterial color={0x0d253a} roughness={0.5} />
      </mesh>
      {/* Barnacle trim bands */}
      {[10, 20].map((y) => (
        <mesh key={`band-${y}`} position={[0, y, -d * 0.33]}>
          <boxGeometry args={[w * 0.72, 1.5, 0.5]} />
          <meshStandardMaterial color={0x37474f} roughness={0.8} />
        </mesh>
      ))}
      {/* Heavy sealed hatch */}
      <mesh position={[0, 12, -d * 0.34]}>
        <boxGeometry args={[14, 20, 2]} />
        <meshStandardMaterial color={0x263238} roughness={0.5} metalness={0.5} />
      </mesh>
      {/* Wheel lock */}
      <mesh position={[0, 14, -d * 0.36]}>
        <torusGeometry args={[4, 0.8, 6, 16]} />
        <meshStandardMaterial color={0x546e7a} metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Bioluminescent glow from cracks */}
      <mesh position={[0, 12, -d * 0.35]}>
        <planeGeometry args={[12, 18]} />
        <meshStandardMaterial ref={glowRef} color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.2} transparent opacity={0.3} />
      </mesh>
      {/* Coral columns */}
      {[-1, 1].map((side) => (
        <mesh key={`col-${side}`} position={[side * w * 0.3, 14, -d * 0.34]} castShadow>
          <cylinderGeometry args={[3, 3.5, 28, 8]} />
          <meshStandardMaterial color={0x00695c} roughness={0.7} />
        </mesh>
      ))}
      {/* Pearl rivets */}
      {[[-4, 8], [4, 8], [-4, 18], [4, 18]].map((pos, i) => (
        <mesh key={`rivet-${i}`} position={[pos[0], pos[1], -d * 0.36]}>
          <sphereGeometry args={[1, 6, 6]} />
          <meshStandardMaterial color={0xfce4ec} metalness={0.5} roughness={0.25} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="cool" />
      <FloatingLabel text="Abyssal Vault" y={62} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 4. HYDROTHERMAL FORGE — Volcanic vent forge. Magma orange/dark basalt.
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
      {/* Basalt vent structure */}
      <mesh position={[0, 16, 0]} castShadow>
        <boxGeometry args={[w * 0.6, 32, d * 0.55]} />
        <meshStandardMaterial color={0x37474f} roughness={0.9} />
      </mesh>
      {/* Volcanic chimney */}
      <mesh position={[w * 0.12, 40, d * 0.1]} castShadow>
        <cylinderGeometry args={[3, 5, 16, 8]} />
        <meshStandardMaterial color={0x263238} roughness={0.85} />
      </mesh>
      {/* Vent opening */}
      <mesh position={[0, 14, -d * 0.28]}>
        <boxGeometry args={[16, 12, 2]} />
        <meshStandardMaterial color={0x1a1a1a} roughness={0.9} />
      </mesh>
      {/* Magma plumes */}
      <group ref={flameRef} position={[0, 12, -d * 0.26]}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={`plume-${i}`} position={[-4 + i * 3, 4, 0]}>
            <coneGeometry args={[1.5, 6, 5]} />
            <meshStandardMaterial color={i % 2 === 0 ? 0xff5722 : 0xff8f00} emissive={i % 2 === 0 ? 0xff5722 : 0xff8f00} emissiveIntensity={0.7} />
          </mesh>
        ))}
      </group>
      {/* Jagged basalt roof */}
      <group position={[0, 32, 0]}>
        <PitchedRoof width={w * 0.7} depth={d * 0.65} height={14} color={0x455a64} />
      </group>
      {/* Obsidian anvil */}
      <group position={[-w * 0.25, 0, -d * 0.35]}>
        <mesh position={[0, 4, 0]}>
          <cylinderGeometry args={[3, 4, 8, 6]} />
          <meshStandardMaterial color={0x212121} metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0, 9, 0]}>
          <boxGeometry args={[10, 2, 5]} />
          <meshStandardMaterial color={0x1a1a1a} metalness={0.8} roughness={0.2} />
        </mesh>
      </group>
      {/* Coral hammer */}
      <mesh position={[-w * 0.18, 11, -d * 0.4]} rotation={[0, 0, 0.5]}>
        <cylinderGeometry args={[0.6, 0.6, 10, 4]} />
        <meshStandardMaterial color={0xff6f61} roughness={0.7} />
      </mesh>
      <mesh position={[-w * 0.14, 15, -d * 0.4]}>
        <boxGeometry args={[3, 3, 3]} />
        <meshStandardMaterial color={0x455a64} metalness={0.6} roughness={0.3} />
      </mesh>
      {/* Magma pools on ground */}
      {[[-3, 0.5, -8], [5, 0.5, -10], [-6, 0.5, -12]].map((pos, i) => (
        <mesh key={`magma-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[0.8, 6, 6]} />
          <meshStandardMaterial color={0xff6f00} emissive={0xff6f00} emissiveIntensity={0.6} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="warm" />
      <FloatingLabel text="Hydrothermal Forge" y={60} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 5. CORAL BRIDGE — Living coral bridge. Warm coral/cyan.
// ---------------------------------------------------------------------------
function ChannelBridgeBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;

  return (
    <group position={[cx, 0, cz]}>
      {/* Coral bridge deck */}
      <mesh position={[0, 8, 0]} castShadow>
        <boxGeometry args={[w * 0.8, 3, d * 0.35]} />
        <meshStandardMaterial color={0xff8a65} roughness={0.65} />
      </mesh>
      {/* Coral ridges on deck */}
      {[-3, -1, 1, 3].map((i) => (
        <mesh key={`ridge-${i}`} position={[i * w * 0.09, 9.8, 0]}>
          <boxGeometry args={[w * 0.08, 0.5, d * 0.33]} />
          <meshStandardMaterial color={0xef6c00} roughness={0.7} />
        </mesh>
      ))}
      {/* Left coral tower */}
      <mesh position={[-w * 0.35, 28, 0]} castShadow>
        <cylinderGeometry args={[4, 5, 48, 8]} />
        <meshStandardMaterial color={0xff7043} roughness={0.6} />
      </mesh>
      {/* Right coral tower */}
      <mesh position={[w * 0.35, 28, 0]} castShadow>
        <cylinderGeometry args={[4, 5, 48, 8]} />
        <meshStandardMaterial color={0xff7043} roughness={0.6} />
      </mesh>
      {/* Tower coral caps */}
      {[-1, 1].map((side) => (
        <mesh key={`cap-${side}`} position={[side * w * 0.35, 54, 0]}>
          <sphereGeometry args={[6, 8, 8]} />
          <meshStandardMaterial color={0xff5722} roughness={0.5} />
        </mesh>
      ))}
      {/* Kelp vine cables */}
      {[-1, 1].map((side) => (
        <group key={`cable-${side}`}>
          <mesh position={[side * w * 0.17, 34, -d * 0.12]} rotation={[0, 0, side * 0.55]}>
            <cylinderGeometry args={[0.4, 0.4, w * 0.38, 4]} />
            <meshStandardMaterial color={0x2e7d32} roughness={0.7} />
          </mesh>
          <mesh position={[side * w * 0.17, 34, d * 0.12]} rotation={[0, 0, side * 0.55]}>
            <cylinderGeometry args={[0.4, 0.4, w * 0.38, 4]} />
            <meshStandardMaterial color={0x2e7d32} roughness={0.7} />
          </mesh>
        </group>
      ))}
      {/* Kelp suspenders */}
      {[-2, -1, 0, 1, 2].map((i) => (
        <mesh key={`susp-${i}`} position={[i * w * 0.1, 22, -d * 0.12]}>
          <cylinderGeometry args={[0.25, 0.25, 18 - Math.abs(i) * 4, 4]} />
          <meshStandardMaterial color={0x388e3c} roughness={0.7} />
        </mesh>
      ))}
      {/* Coral railing */}
      {[-1, 1].map((side) => (
        <mesh key={`rail-${side}`} position={[0, 11, side * d * 0.17]}>
          <boxGeometry args={[w * 0.78, 1, 0.8]} />
          <meshStandardMaterial color={0xffab91} roughness={0.6} />
        </mesh>
      ))}
      {/* Bioluminescent accent on bridge */}
      <mesh position={[0, 10, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2, 4, 12]} />
        <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.3} transparent opacity={0.5} side={THREE.DoubleSide} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="warm" />
      <FloatingLabel text="Coral Bridge" y={70} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 6. SALVAGE WORKSHOP — Shipwreck workshop with anchor and sea glass. Teal/driftwood.
// ---------------------------------------------------------------------------
function ToolWorkshopBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 36;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.03]}>
      {/* Driftwood shed body */}
      <mesh position={[0, wallH * 0.45, 0]} castShadow>
        <boxGeometry args={[w * 0.7, wallH * 0.9, d * 0.65]} />
        <meshStandardMaterial color={0x5d4037} roughness={0.85} />
      </mesh>
      {/* Teal sea glass accent panel */}
      <mesh position={[0, wallH * 0.45, -d * 0.33]}>
        <boxGeometry args={[w * 0.72, wallH * 0.92, 1]} />
        <meshStandardMaterial color={0x00695c} roughness={0.55} />
      </mesh>
      {/* Barnacle-crusted roof */}
      <group position={[0, wallH, 0]}>
        <PitchedRoof width={w * 0.82} depth={d * 0.75} height={16} color={0x37474f} />
      </group>
      {/* Salvage board */}
      <mesh position={[w * 0.2, wallH * 0.55, -d * 0.34]}>
        <boxGeometry args={[14, 12, 0.5]} />
        <meshStandardMaterial color={0x4e342e} roughness={0.8} />
      </mesh>
      {/* Hanging anchor */}
      <mesh position={[w * 0.16, wallH * 0.6, -d * 0.35]} rotation={[0, 0, 0.3]}>
        <boxGeometry args={[1.5, 8, 0.4]} />
        <meshStandardMaterial color={0x546e7a} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Hanging chain */}
      <mesh position={[w * 0.22, wallH * 0.58, -d * 0.35]} rotation={[0, 0, -0.2]}>
        <boxGeometry args={[1.2, 7, 0.4]} />
        <meshStandardMaterial color={0x78909c} metalness={0.4} roughness={0.4} />
      </mesh>
      <mesh position={[w * 0.22, wallH * 0.65, -d * 0.36]}>
        <boxGeometry args={[3.5, 2.5, 1]} />
        <meshStandardMaterial color={0x607d8b} metalness={0.5} roughness={0.35} />
      </mesh>
      {/* Trident */}
      <mesh position={[w * 0.28, wallH * 0.52, -d * 0.35]} rotation={[0, 0, 0.1]}>
        <boxGeometry args={[1, 10, 0.3]} />
        <meshStandardMaterial color={0x80cbc4} metalness={0.4} roughness={0.3} />
      </mesh>
      {/* Driftwood workbench */}
      <mesh position={[-w * 0.28, 5, -d * 0.38]}>
        <boxGeometry args={[14, 10, 6]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.85} />
      </mesh>
      {/* Sea glass parts on bench */}
      {[-2, 1, 4].map((x, i) => (
        <mesh key={`part-${i}`} position={[-w * 0.28 + x, 11, -d * 0.38]}>
          <boxGeometry args={[2, 2, 2]} />
          <meshStandardMaterial color={[0x00bcd4, 0x4dd0e1, 0x80deea][i]} roughness={0.4} transparent opacity={0.8} />
        </mesh>
      ))}
      {/* Porthole window */}
      <mesh position={[-w * 0.18, wallH * 0.5, -d * 0.34]}>
        <circleGeometry args={[4, 12]} />
        <meshStandardMaterial color={0xb2ebf2} emissive={0x00bcd4} emissiveIntensity={0.15} />
      </mesh>
      {/* Door */}
      <mesh position={[0, 8, -d * 0.34]}>
        <boxGeometry args={[10, 16, 1.5]} />
        <meshStandardMaterial color={0x3e2723} roughness={0.85} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.48} tone="magic" />
      <FloatingLabel text="Salvage Workshop" y={64} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 7. BIOLUME STUDIO — Bioluminescent art cave with glowing ink splashes.
// ---------------------------------------------------------------------------
function CanvasStudioBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 38;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.04]}>
      {/* Deep cave studio body */}
      <mesh position={[0, wallH * 0.45, 0]} castShadow>
        <boxGeometry args={[w * 0.8, wallH * 0.9, d * 0.75]} />
        <meshStandardMaterial color={0x1a3c4a} roughness={0.75} />
      </mesh>
      {/* Side grotto */}
      <mesh position={[w * 0.2, wallH * 0.35, d * 0.2]} rotation={[0, 0.1, 0.04]} castShadow>
        <boxGeometry args={[w * 0.3, wallH * 0.5, d * 0.3]} />
        <meshStandardMaterial color={0x263238} roughness={0.7} />
      </mesh>
      {/* Rocky cavern roof */}
      <group position={[0, wallH, 0]} rotation={[0, 0, 0.04]}>
        <PitchedRoof width={w + 8} depth={d + 6} height={20} color={0x37474f} />
      </group>
      {/* Bioluminescent skylight */}
      <mesh position={[0, wallH + 11, -3]} rotation={[0.5, 0, 0.04]}>
        <planeGeometry args={[10, 8]} />
        <meshStandardMaterial color={0x00e5ff} emissive={0x00bcd4} emissiveIntensity={0.4} transparent opacity={0.6} />
      </mesh>
      {/* Bioluminescent ink splatters on front */}
      {[
        { pos: [-w * 0.25, 22, -d / 2 - 1], color: 0x00e5ff, r: 3.5 },
        { pos: [w * 0.15, 16, -d / 2 - 1], color: 0x7c4dff, r: 3 },
        { pos: [-w * 0.08, 28, -d / 2 - 1], color: 0x69f0ae, r: 2.8 },
        { pos: [w * 0.3, 24, -d / 2 - 1], color: 0xff4081, r: 3.2 },
        { pos: [w * 0.05, 12, -d / 2 - 1], color: 0xffab40, r: 2.5 },
      ].map((splat, i) => (
        <group key={`splat-${i}`} position={splat.pos as [number, number, number]}>
          <mesh>
            <circleGeometry args={[splat.r, 10]} />
            <meshStandardMaterial color={splat.color} emissive={splat.color} emissiveIntensity={0.3} roughness={0.4} />
          </mesh>
          <mesh position={[0, -3, 0]}>
            <boxGeometry args={[0.9, 3.5, 0.3]} />
            <meshStandardMaterial color={splat.color} emissive={splat.color} emissiveIntensity={0.2} roughness={0.4} />
          </mesh>
        </group>
      ))}
      {/* Kelp easel + shell canvas outside */}
      <group position={[-w * 0.38, 0, -d / 2 - 8]}>
        <mesh position={[-2, 9, 0]} rotation={[0, 0, 0.15]}>
          <cylinderGeometry args={[0.6, 0.6, 18, 4]} />
          <meshStandardMaterial color={0x2e7d32} roughness={0.8} />
        </mesh>
        <mesh position={[2, 9, 0]} rotation={[0, 0, -0.15]}>
          <cylinderGeometry args={[0.6, 0.6, 18, 4]} />
          <meshStandardMaterial color={0x2e7d32} roughness={0.8} />
        </mesh>
        <mesh position={[0, 13, -1]}>
          <boxGeometry args={[10, 8, 0.5]} />
          <meshStandardMaterial color={0xfff3e0} roughness={0.5} />
        </mesh>
        {/* Biolume ink dabs */}
        {[[-3, 14], [0, 12], [3, 15]].map((pos, i) => (
          <mesh key={`dab-${i}`} position={[pos[0], pos[1], -1.3]}>
            <circleGeometry args={[1.2, 6]} />
            <meshStandardMaterial color={[0x00e5ff, 0x7c4dff, 0x69f0ae][i]} emissive={[0x00e5ff, 0x7c4dff, 0x69f0ae][i]} emissiveIntensity={0.3} />
          </mesh>
        ))}
      </group>
      {/* Coral spire fence */}
      {[-2, -1, 0, 1, 2].map((i) => (
        <mesh key={`spire-${i}`} position={[w * 0.38 + i * 2.5, 5, -d / 2 - 6]} rotation={[0, 0, (i - 1) * 0.03]}>
          <coneGeometry args={[1.2, 10, 6]} />
          <meshStandardMaterial color={[0xff6f61, 0xff8a65, 0xffab91, 0xef6c00, 0xe65100][i + 2]} roughness={0.6} />
        </mesh>
      ))}
      {/* Cave entrance */}
      <mesh position={[0, 8, -d / 2 - 1]}>
        <boxGeometry args={[10, 16, 1.5]} />
        <meshStandardMaterial color={0x0d1b2a} roughness={0.85} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="magic" />
      <FloatingLabel text="Biolume Studio" y={70} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 8. ECHO SPIRE — Tall sonar spire with whale-song resonators. Deep blue/teal.
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
      {/* Coral rock base */}
      <mesh position={[0, 10, 0]} castShadow>
        <boxGeometry args={[w * 0.45, 20, w * 0.45]} />
        <meshStandardMaterial color={0x1a3c4a} roughness={0.8} />
      </mesh>
      {/* Spire shaft (like a sea stack) */}
      <mesh position={[0, 36, 0]} castShadow>
        <cylinderGeometry args={[3, 6, 32, 8]} />
        <meshStandardMaterial color={0x004d40} roughness={0.65} />
      </mesh>
      {/* Coral ring braces */}
      {[25, 35, 45].map((y) => (
        <mesh key={`brace-${y}`} position={[0, y, 0]}>
          <torusGeometry args={[7, 1, 6, 12]} />
          <meshStandardMaterial color={0xff8a65} roughness={0.6} />
        </mesh>
      ))}
      {/* Antenna — narwhal tusk */}
      <mesh position={[0, 56, 0]}>
        <coneGeometry args={[1.2, 12, 6]} />
        <meshStandardMaterial color={0xfff3e0} roughness={0.35} />
      </mesh>
      {/* Glowing pearl beacon */}
      <mesh position={[0, 63, 0]}>
        <sphereGeometry args={[1.5, 8, 8]} />
        <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.6} />
      </mesh>
      {/* Conch horn on front */}
      <mesh position={[0, 18, -w * 0.24]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[7, 8, 12]} />
        <meshStandardMaterial color={0xffccbc} roughness={0.5} />
      </mesh>
      {/* Conch opening */}
      <mesh position={[0, 18, -w * 0.24 - 4]}>
        <circleGeometry args={[7, 12]} />
        <meshStandardMaterial color={0xffab91} roughness={0.45} />
      </mesh>
      {/* Ripple rings */}
      {[2, 4, 6].map((r, i) => (
        <mesh key={`ring-${i}`} position={[0, 18, -w * 0.24 - 4.2]}>
          <torusGeometry args={[r, 0.3, 4, 16]} />
          <meshStandardMaterial color={0xff7043} roughness={0.5} />
        </mesh>
      ))}
      {/* Animated sonar waves */}
      <group ref={wavesRef} position={[0, 18, -w * 0.24 - 6]}>
        {[0, 1, 2].map((i) => (
          <mesh key={`wave-${i}`} position={[0, 0, -i * 3]}>
            <torusGeometry args={[5 + i * 3, 0.5, 4, 16, Math.PI]} />
            <meshStandardMaterial color={0x00bcd4} emissive={0x00bcd4} emissiveIntensity={0.3} transparent opacity={0.4} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
      {/* Cave entrance */}
      <mesh position={[0, 6, -w * 0.23]}>
        <boxGeometry args={[7, 12, 1.5]} />
        <meshStandardMaterial color={0x0d1b2a} roughness={0.8} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={w * 0.55} tone="cool" />
      <FloatingLabel text="Echo Spire" y={74} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 9. SHELL FORTRESS — Armored shell fortress with barnacle towers. Deep ocean.
// ---------------------------------------------------------------------------
function SecurityFortressBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;

  return (
    <group position={[cx, 0, cz]}>
      {/* Shell keep — dark armored */}
      <mesh position={[0, 20, 0]} castShadow>
        <boxGeometry args={[w * 0.55, 40, d * 0.5]} />
        <meshStandardMaterial color={0x263238} roughness={0.8} />
      </mesh>
      {/* Shell corner towers */}
      {[[-1, -1], [-1, 1], [1, -1], [1, 1]].map((corner, i) => (
        <group key={`tower-${i}`} position={[corner[0] * w * 0.3, 0, corner[1] * d * 0.28]}>
          <mesh position={[0, 24, 0]} castShadow>
            <cylinderGeometry args={[6, 7, 48, 8]} />
            <meshStandardMaterial color={0x37474f} roughness={0.75} />
          </mesh>
          {/* Barnacle cap */}
          <mesh position={[0, 49, 0]}>
            <sphereGeometry args={[7, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
            <meshStandardMaterial color={0xc2b280} roughness={0.8} />
          </mesh>
          {/* Bioluminescent ring */}
          <mesh position={[0, 44, 0]}>
            <torusGeometry args={[6.5, 0.8, 6, 12]} />
            <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.3} />
          </mesh>
        </group>
      ))}
      {/* Shell spikes on main keep */}
      {[-2, -1, 0, 1, 2].map((i) => (
        <mesh key={`spike-${i}`} position={[i * w * 0.1, 42, -d * 0.26]}>
          <coneGeometry args={[2, 5, 4]} />
          <meshStandardMaterial color={0x455a64} roughness={0.7} />
        </mesh>
      ))}
      {/* Fortress walls */}
      {[-1, 1].map((side) => (
        <mesh key={`wall-${side}`} position={[side * w * 0.3, 14, 0]} castShadow>
          <boxGeometry args={[3, 28, d * 0.5]} />
          <meshStandardMaterial color={0x37474f} roughness={0.85} />
        </mesh>
      ))}
      {/* Gate — dark cave entrance */}
      <mesh position={[0, 10, -d * 0.26]}>
        <boxGeometry args={[14, 20, 3]} />
        <meshStandardMaterial color={0x0d1b2a} roughness={0.85} />
      </mesh>
      <mesh position={[0, 20, -d * 0.26]}>
        <cylinderGeometry args={[7, 7, 3, 12, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color={0x1a2a3a} roughness={0.8} side={THREE.DoubleSide} />
      </mesh>
      {/* Coral portcullis bars */}
      {[-4, -2, 0, 2, 4].map((x) => (
        <mesh key={`portcullis-${x}`} position={[x, 10, -d * 0.28]}>
          <boxGeometry args={[0.5, 18, 0.4]} />
          <meshStandardMaterial color={0xff8a65} roughness={0.6} />
        </mesh>
      ))}
      {/* Shell emblem */}
      <mesh position={[0, 30, -d * 0.27]}>
        <circleGeometry args={[4, 12]} />
        <meshStandardMaterial color={0xfce4ec} metalness={0.4} roughness={0.25} />
      </mesh>
      {/* Kelp flag */}
      <mesh position={[0, 46, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 12, 4]} />
        <meshStandardMaterial color={0x2e7d32} roughness={0.7} />
      </mesh>
      <mesh position={[4, 50, 0]} rotation={[0, 0.2, 0]}>
        <planeGeometry args={[8, 5]} />
        <meshStandardMaterial color={0x00897b} roughness={0.6} side={THREE.DoubleSide} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.55} tone="cool" />
      <FloatingLabel text="Shell Fortress" y={72} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 10. NAUTILUS CITADEL — Spiral nautilus command center. Pearl/deep blue.
// ---------------------------------------------------------------------------
function ConfigCitadelBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;

  return (
    <group position={[cx, 0, cz]}>
      {/* Sandy base platform */}
      <mesh position={[0, 3, 0]} castShadow>
        <boxGeometry args={[w * 0.75, 6, d * 0.7]} />
        <meshStandardMaterial color={0xc2b280} roughness={0.8} />
      </mesh>
      {/* Nautilus shell body */}
      <mesh position={[0, 24, 0]} castShadow>
        <cylinderGeometry args={[w * 0.22, w * 0.28, 36, 12]} />
        <meshStandardMaterial color={0xffccbc} roughness={0.5} />
      </mesh>
      {/* Upper command chamber */}
      <mesh position={[0, 46, 0]} castShadow>
        <cylinderGeometry args={[w * 0.18, w * 0.22, 10, 12]} />
        <meshStandardMaterial color={0xffab91} roughness={0.45} />
      </mesh>
      {/* Pearl dome */}
      <mesh position={[0, 53, 0]} castShadow>
        <sphereGeometry args={[w * 0.2, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
        <meshStandardMaterial color={0xfff3e0} metalness={0.4} roughness={0.25} />
      </mesh>
      {/* Spiral spire */}
      <mesh position={[0, 62, 0]}>
        <coneGeometry args={[2, 10, 8]} />
        <meshStandardMaterial color={0xffccbc} roughness={0.4} />
      </mesh>
      {/* Porthole windows */}
      {[0, 1, 2].map((floor) =>
        [-1, 0, 1].map((col) => (
          <mesh key={`win-${floor}-${col}`} position={[col * w * 0.12, 12 + floor * 12, -w * 0.26]}>
            <circleGeometry args={[2.5, 12]} />
            <meshStandardMaterial color={0xb2ebf2} emissive={0x00bcd4} emissiveIntensity={floor === 1 ? 0.3 : 0.15} />
          </mesh>
        ))
      )}
      {/* Navigation panel */}
      <mesh position={[0, 46, -w * 0.19]}>
        <planeGeometry args={[w * 0.25, 6]} />
        <meshStandardMaterial color={0x004d40} roughness={0.5} />
      </mesh>
      {/* Status pearls */}
      {[-3, -1, 1, 3].map((x, i) => (
        <mesh key={`pearl-${i}`} position={[x * 2, 47, -w * 0.2]}>
          <sphereGeometry args={[0.6, 8, 8]} />
          <meshStandardMaterial color={[0x00e5ff, 0x00e5ff, 0xffab40, 0x00e5ff][i]} emissive={[0x00e5ff, 0x00e5ff, 0xffab40, 0x00e5ff][i]} emissiveIntensity={0.4} />
        </mesh>
      ))}
      {/* Coral buttresses */}
      {[-1, 1].map((side) => (
        <mesh key={`buttress-${side}`} position={[side * w * 0.3, 15, 0]} castShadow>
          <cylinderGeometry args={[2, 3, 24, 6]} />
          <meshStandardMaterial color={0xff8a65} roughness={0.65} />
        </mesh>
      ))}
      {/* Cave entry */}
      <mesh position={[0, 8, -w * 0.26]}>
        <boxGeometry args={[10, 14, 1.5]} />
        <meshStandardMaterial color={0x0d1b2a} roughness={0.85} />
      </mesh>
      {/* Coral steps */}
      {[0, 1].map((step) => (
        <mesh key={`step-${step}`} position={[0, 1.5 + step * 1.5, -w * 0.3 - step * 2]}>
          <boxGeometry args={[14, 1.3, 2.5]} />
          <meshStandardMaterial color={0xffab91} roughness={0.6} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.52} tone="mint" />
      <FloatingLabel text="Nautilus Citadel" y={78} />
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
