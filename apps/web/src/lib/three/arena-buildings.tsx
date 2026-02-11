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
// Pitched roof (triangular prism) â€” reused by several buildings
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
// 1. POTION SHOP â€” Mushroom/cauldron shaped, witch-hat roof, purple
// ---------------------------------------------------------------------------
function PotionShopBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const smokeRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (smokeRef.current) {
      const t = clock.getElapsedTime();
      smokeRef.current.children.forEach((child, i) => {
        child.position.y = 5 + Math.sin(t * 1.5 + i * 1.2) * 4;
        (child as THREE.Mesh).scale.setScalar(0.8 + Math.sin(t * 2 + i) * 0.3);
        ((child as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = 0.4 + Math.sin(t + i * 0.5) * 0.2;
      });
    }
  });

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, 0.02]}>
      {/* Starry brim base (Neopia map magic shop feel) */}
      <mesh position={[0, 4, 0]} castShadow>
        <torusGeometry args={[18, 7, 8, 16]} />
        <meshStandardMaterial color={0x5f5ac6} roughness={0.65} />
      </mesh>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <mesh key={`star-${i}`} position={[Math.cos(i * 1.04) * 16, 1.8, Math.sin(i * 1.04) * 16]} rotation={[-Math.PI / 2, 0, i * 0.2]}>
          <circleGeometry args={[2.8, 5]} />
          <meshStandardMaterial color={0xffca28} emissive={0xffca28} emissiveIntensity={0.25} />
        </mesh>
      ))}
      {/* Tall wizard hat body */}
      <mesh position={[0, 23, 0]} castShadow>
        <coneGeometry args={[22, 42, 12]} />
        <meshStandardMaterial color={0x333a8a} roughness={0.62} />
      </mesh>
      <mesh position={[0, 35, 0]} castShadow>
        <coneGeometry args={[13, 18, 10]} />
        <meshStandardMaterial color={0x2a2f74} roughness={0.58} />
      </mesh>
      <mesh position={[3, 48, 0]} rotation={[0, 0, 0.35]} castShadow>
        <coneGeometry args={[3.8, 12, 8]} />
        <meshStandardMaterial color={0x2a2f74} roughness={0.56} />
      </mesh>
      {/* Front star door */}
      <mesh position={[0, 8, -13]}>
        <boxGeometry args={[9, 14, 2]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.82} />
      </mesh>
      <mesh position={[0, 9, -11.8]} rotation={[0, 0, 0.3]}>
        <circleGeometry args={[2.8, 5]} />
        <meshStandardMaterial color={0xffca28} emissive={0xffca28} emissiveIntensity={0.3} />
      </mesh>
      {/* Side potion bottles */}
      {[-1, 1].map((side, i) => (
        <mesh key={`bottle-${i}`} position={[side * 11, 11, -11]}>
          <cylinderGeometry args={[2.1, 2.6, 6, 8]} />
          <meshStandardMaterial color={side > 0 ? 0x69f0ae : 0xce93d8} emissive={side > 0 ? 0x69f0ae : 0xce93d8} emissiveIntensity={0.2} />
        </mesh>
      ))}
      {/* Cauldron + smoke */}
      <mesh position={[15, 4, -10]}>
        <sphereGeometry args={[5.4, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
        <meshStandardMaterial color={0x2c2c2c} roughness={0.9} />
      </mesh>
      <group ref={smokeRef} position={[15, 9, -10]}>
        {[0, 1, 2].map((i) => (
          <mesh key={`smoke-${i}`} position={[(i - 1) * 2.6, 5 + i * 2.7, 0]}>
            <sphereGeometry args={[2.8, 7, 7]} />
            <meshStandardMaterial color={0x69f0ae} transparent opacity={0.42} />
          </mesh>
        ))}
      </group>
      <GroundScatter seedKey={zone.id} radius={TILE_SIZE * 2.15} tone="magic" />
      <FloatingLabel text="Potion Shop" y={70} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 2. AUCTION HOUSE â€” Grand classical with columns, golden trim
// ---------------------------------------------------------------------------
function AuctionHouseBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, 0.04]}>
      {/* Old-map style wooden pedestal + tower */}
      <mesh position={[0, 6, 0]} castShadow>
        <cylinderGeometry args={[w * 0.33, w * 0.42, 12, 12]} />
        <meshStandardMaterial color={0x7a4b28} roughness={0.82} />
      </mesh>
      <mesh position={[0, 15, 0]} castShadow>
        <cylinderGeometry args={[w * 0.22, w * 0.26, 8, 12]} />
        <meshStandardMaterial color={0x8b5a32} roughness={0.82} />
      </mesh>
      <mesh position={[0, 34, 0]} castShadow>
        <cylinderGeometry args={[w * 0.14, w * 0.17, 38, 10]} />
        <meshStandardMaterial color={0xa56a3e} roughness={0.78} />
      </mesh>
      {/* Side beam and gavel head motif */}
      <mesh position={[-w * 0.23, 53, 0]} rotation={[0, 0, 0.03]} castShadow>
        <cylinderGeometry args={[2.2, 2.2, w * 0.5, 8]} />
        <meshStandardMaterial color={0x9c6238} roughness={0.78} />
      </mesh>
      <mesh position={[-w * 0.43, 53, 0]} castShadow>
        <boxGeometry args={[8, 9, 9]} />
        <meshStandardMaterial color={0x7b4a29} roughness={0.8} />
      </mesh>
      {/* Folded blue roof cap */}
      <group position={[0, 54, 0]} rotation={[0, 0, -0.08]}>
        <mesh castShadow>
          <sphereGeometry args={[w * 0.26, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52]} />
          <meshStandardMaterial color={0x355fc5} roughness={0.54} />
        </mesh>
        <mesh position={[0, 1.2, 0]}>
          <sphereGeometry args={[w * 0.23, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.46]} />
          <meshStandardMaterial color={0x4d77e0} roughness={0.5} />
        </mesh>
      </group>
      {/* Tiny front door */}
      <mesh position={[0, 4.5, -w * 0.29]}>
        <boxGeometry args={[8, 8, 1.5]} />
        <meshStandardMaterial color={0x3e2723} roughness={0.8} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.56} tone="warm" />
      <FloatingLabel text="Auction House" y={78} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 3. BOOK SHOP â€” Tall, narrow, leaning, stack-of-books style
// ---------------------------------------------------------------------------
function BookShopBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 48;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.03]}>
      {/* Open-book structure from Neopia Central map */}
      <mesh position={[0, 9, 0]} castShadow>
        <boxGeometry args={[w * 0.46, 18, d * 0.72]} />
        <meshStandardMaterial color={0xf4efe3} roughness={0.66} />
      </mesh>
      {/* Red book covers */}
      <mesh position={[-w * 0.19, wallH * 0.55, 0]} rotation={[0, 0, 0.64]} castShadow>
        <boxGeometry args={[10, wallH, d * 0.8]} />
        <meshStandardMaterial color={0xe53935} roughness={0.55} />
      </mesh>
      <mesh position={[w * 0.19, wallH * 0.55, 0]} rotation={[0, 0, -0.64]} castShadow>
        <boxGeometry args={[10, wallH, d * 0.8]} />
        <meshStandardMaterial color={0xe53935} roughness={0.55} />
      </mesh>
      {/* Blue central page fold/door */}
      <mesh position={[0, 10, -d * 0.34]}>
        <boxGeometry args={[10, 16, 2]} />
        <meshStandardMaterial color={0x8ec5ff} roughness={0.5} />
      </mesh>
      {/* Spine stripes */}
      {[-6, -3, 0, 3, 6].map((x, i) => (
        <mesh key={`page-${i}`} position={[x, 23, 0]}>
          <boxGeometry args={[1, wallH * 0.62, d * 0.75]} />
          <meshStandardMaterial color={0xfff8e1} roughness={0.6} />
        </mesh>
      ))}
      {/* Small round window light */}
      <mesh position={[0, 26, -d * 0.3]}>
        <circleGeometry args={[4.2, 10]} />
        <meshStandardMaterial color={0xffe082} emissive={0xffca28} emissiveIntensity={0.35} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.52} tone="warm" />
      <FloatingLabel text="Book Shop" y={86} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 4. CLOTHING SHOP â€” Pink boutique with striped awning
// ---------------------------------------------------------------------------
function ClothingShopBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 40;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.03]}>
      {/* Rounded boutique base */}
      <mesh position={[0, wallH * 0.45, 0]} castShadow>
        <cylinderGeometry args={[w * 0.46, w * 0.5, wallH * 0.9, 12]} />
        <meshStandardMaterial color={0xf8bbd0} roughness={0.62} />
      </mesh>
      {/* Back loft volume for depth */}
      <mesh position={[0, wallH * 0.62, d * 0.12]} castShadow>
        <boxGeometry args={[w * 0.7, wallH * 0.54, d * 0.55]} />
        <meshStandardMaterial color={0xf48fb1} roughness={0.62} />
      </mesh>
      {/* Curvy roof and bow */}
      <mesh position={[0, wallH + 10, 0]} castShadow>
        <sphereGeometry args={[w * 0.48, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
        <meshStandardMaterial color={0xc2185b} roughness={0.55} />
      </mesh>
      <group position={[0, wallH + 15, 0]}>
        <mesh position={[-4, 0, 0]} rotation={[0, 0, 0.35]}>
          <sphereGeometry args={[4.5, 8, 6]} />
          <meshStandardMaterial color={0xf06292} roughness={0.56} />
        </mesh>
        <mesh position={[4, 0, 0]} rotation={[0, 0, -0.35]}>
          <sphereGeometry args={[4.5, 8, 6]} />
          <meshStandardMaterial color={0xf06292} roughness={0.56} />
        </mesh>
        <mesh>
          <sphereGeometry args={[2.4, 8, 6]} />
          <meshStandardMaterial color={0xf48fb1} roughness={0.56} />
        </mesh>
      </group>
      {/* Striped awning */}
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <mesh key={`awning-${i}`} position={[-w * 0.38 + i * (w * 0.125), wallH * 0.56, -d / 2 - 6]} rotation={[0.38, 0, 0]}>
          <boxGeometry args={[w * 0.11, 11, 1.5]} />
          <meshStandardMaterial color={i % 2 === 0 ? 0xe91e63 : 0xffffff} roughness={0.52} />
        </mesh>
      ))}
      {/* Window + mannequin */}
      <mesh position={[w * 0.2, wallH * 0.45, -d / 2 - 1.4]}>
        <planeGeometry args={[15, 18]} />
        <meshStandardMaterial color={0xfce4ec} emissive={0xf48fb1} emissiveIntensity={0.25} />
      </mesh>
      <mesh position={[w * 0.2, wallH * 0.44, -d / 2 - 2]}>
        <cylinderGeometry args={[1.8, 2.4, 14, 8]} />
        <meshStandardMaterial color={0x880e4f} roughness={0.88} />
      </mesh>
      {/* Decorative hearts and ribbon */}
      {[[-6, wallH - 4, -d / 2 - 1], [6, wallH - 2, -d / 2 - 1]].map((pos, i) => (
        <mesh key={`heart-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[2.4, 8, 6]} />
          <meshStandardMaterial color={0xe91e63} emissive={0xe91e63} emissiveIntensity={0.2} />
        </mesh>
      ))}
      <mesh position={[-w * 0.2, 8, -d / 2 - 1.3]}>
        <boxGeometry args={[10, 16, 2]} />
        <meshStandardMaterial color={0xffffff} roughness={0.5} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="warm" />
      <FloatingLabel text="Clothing Shop" y={72} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 5. BAZAAR â€” Open-air market stalls with colorful tent awnings + pennants
// ---------------------------------------------------------------------------
function BazaarBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const stallColors = [0xef5350, 0x42a5f5, 0xffca28, 0x66bb6a];

  return (
    <group position={[cx, 0, cz]}>
      {/* 4 market stalls */}
      {stallColors.map((color, i) => {
        const sx = -w * 0.3 + i * (w * 0.22);
        return (
          <group key={`stall-${i}`} position={[sx, 0, 0]}>
            {/* Counter */}
            <mesh position={[0, 8, 0]} castShadow>
              <boxGeometry args={[20, 16, 18]} />
              <meshStandardMaterial color={0x8d6e63} roughness={0.85} />
            </mesh>
            {/* Tent pole */}
            <mesh position={[0, 22, 0]}>
              <cylinderGeometry args={[1, 1, 28, 4]} />
              <meshStandardMaterial color={0x5d4037} roughness={0.9} />
            </mesh>
            {/* Tent awning (cone) */}
            <mesh position={[0, 38, 0]}>
              <coneGeometry args={[16, 8, 8]} />
              <meshStandardMaterial color={color} roughness={0.5} side={THREE.DoubleSide} />
            </mesh>
            {/* Goods on counter */}
            <mesh position={[0, 17, 0]}>
              <boxGeometry args={[6, 4, 6]} />
              <meshStandardMaterial color={0xffe0b2} roughness={0.7} />
            </mesh>
          </group>
        );
      })}
      {/* Pennant string between poles */}
      {[0, 1, 2].map((i) => {
        const colors = [0xff5722, 0xffeb3b, 0x2196f3, 0x4caf50];
        return (
          <mesh key={`pennant-${i}`} position={[-w * 0.2 + i * (w * 0.22), 34, 0]} rotation={[0, 0, (i - 1) * 0.1]}>
            <coneGeometry args={[2.5, 5, 3]} />
            <meshStandardMaterial color={colors[i % 4]} roughness={0.5} />
          </mesh>
        );
      })}
      {/* Hanging lanterns */}
      {[-1, 1].map((side) => (
        <mesh key={`lantern-${side}`} position={[side * w * 0.3, 30, 0]}>
          <sphereGeometry args={[2.5, 6, 6]} />
          <meshStandardMaterial color={0xffca28} emissive={0xffa000} emissiveIntensity={0.5} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={Math.max(w, TILE_SIZE * 3) * 0.44} tone="warm" />
      <FloatingLabel text="Bazaar" y={52} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 6. PETPET SHOP â€” Cozy dome cottage with thatched roof, paw prints
// ---------------------------------------------------------------------------
function PetpetShopBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const r = zone.width * TILE_SIZE * 0.45;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.04]}>
      {/* Purple blob body like classic map */}
      <mesh position={[0, 18, 0]} castShadow>
        <sphereGeometry args={[r * 1.08, 12, 10]} />
        <meshStandardMaterial color={0x5a55aa} roughness={0.72} />
      </mesh>
      {/* Root/trunk base */}
      <mesh position={[0, 7, 0]} castShadow>
        <cylinderGeometry args={[r * 0.48, r * 0.65, 14, 10]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.88} />
      </mesh>
      {/* Dark spots */}
      {[[-8, 23, -7], [7, 27, -2], [11, 20, 8], [-10, 18, 7], [0, 29, 9]].map((pos, i) => (
        <mesh key={`spot-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[2.6, 7, 6]} />
          <meshStandardMaterial color={0x2f3f71} roughness={0.8} />
        </mesh>
      ))}
      {/* Yellow circular windows */}
      {[[-r * 0.44, 19, -r * 0.62], [r * 0.42, 17, -r * 0.64]].map((pos, i) => (
        <group key={`petwin-${i}`} position={pos as [number, number, number]}>
          <mesh>
            <cylinderGeometry args={[3.8, 3.8, 1.4, 14]} />
            <meshStandardMaterial color={0x39404f} roughness={0.7} />
          </mesh>
          <mesh position={[0, 0, 0.8]}>
            <circleGeometry args={[3, 12]} />
            <meshStandardMaterial color={0xffeb3b} emissive={0xffca28} emissiveIntensity={0.35} />
          </mesh>
        </group>
      ))}
      {/* Tiny round door */}
      <mesh position={[0, 7, -r * 0.68]}>
        <cylinderGeometry args={[4.5, 4.5, 2, 12, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.85} side={THREE.DoubleSide} />
      </mesh>
      {/* Vines/grass patch */}
      {[[-10, 1, -r], [-4, 1, -r * 1.08], [3, 1, -r * 0.96], [9, 1, -r * 1.05]].map((pos, i) => (
        <mesh key={`vine-${i}`} position={pos as [number, number, number]} rotation={[-Math.PI / 2, 0, i * 0.35]}>
          <circleGeometry args={[3.6, 7]} />
          <meshStandardMaterial color={0x43a047} roughness={0.85} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={r * 1.25} tone="forest" />
      <FloatingLabel text="Petpet Shop" y={64} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 7. MONEY TREE â€” Giant magical tree with face, floating coins, glow
// ---------------------------------------------------------------------------
function MoneyTreeBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const scatterR = Math.max(zone.width, zone.height) * TILE_SIZE * 0.56;
  const canopyRef = useRef<THREE.Group>(null);
  const coinsRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (canopyRef.current) {
      canopyRef.current.rotation.y = Math.sin(t * 0.3) * 0.04;
      canopyRef.current.position.y = 55 + Math.sin(t * 0.6) * 2;
    }
    if (coinsRef.current) {
      coinsRef.current.children.forEach((coin, i) => {
        coin.position.y = 10 + Math.sin(t * 1.5 + i * 1.3) * 6;
        coin.rotation.y = t * 2 + i;
      });
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Curved trunk with root flare */}
      <mesh position={[0, 9, 0]} castShadow>
        <cylinderGeometry args={[8, 12, 18, 10]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.95} />
      </mesh>
      <mesh position={[2, 24, 0]} rotation={[0, 0, -0.18]} castShadow>
        <cylinderGeometry args={[5.5, 7.4, 28, 10]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.94} />
      </mesh>
      <mesh position={[8, 39, -2]} rotation={[0, 0, -0.3]} castShadow>
        <cylinderGeometry args={[3.5, 5, 22, 9]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.92} />
      </mesh>
      {/* Leafy canopy with swirl lobes like map icon */}
      <group ref={canopyRef} position={[10, 58, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[28, 14, 11]} />
          <meshStandardMaterial color={0x3d8b3d} roughness={0.8} />
        </mesh>
        {[[-24, 2, 8], [-8, 16, -6], [18, 10, 10], [22, -4, -6], [-14, -10, -4]].map((pos, i) => (
          <mesh key={`leaf-${i}`} position={pos as [number, number, number]}>
            <sphereGeometry args={[11 + (i % 2), 10, 8]} />
            <meshStandardMaterial color={i % 2 === 0 ? 0x4caf50 : 0x2e7d32} roughness={0.82} />
          </mesh>
        ))}
        {[-1, 1].map((side, i) => (
          <mesh key={`curl-${i}`} position={[side * 25, 0, 2]} rotation={[0, 0, side * 0.7]}>
            <torusGeometry args={[6, 2.2, 8, 14, Math.PI * 1.3]} />
            <meshStandardMaterial color={0x2e7d32} roughness={0.82} />
          </mesh>
        ))}
        {[0, 1, 2].map((i) => (
          <mesh
            key={`leaf-cap-${i}`}
            position={[-5 + i * 8, 14 + (i % 2) * 2, -2 + i]}
            rotation={[-Math.PI / 2, 0, i * 0.35]}
          >
            <circleGeometry args={[8, 14]} />
            <meshStandardMaterial color={0x2f7f2f} roughness={0.82} side={THREE.DoubleSide} />
          </mesh>
        ))}
      </group>
      {/* Coin pile at roots */}
      {[[-6, 2, 8], [-2, 2.4, 10], [2, 2.2, 9], [6, 2.1, 7]].map((pos, i) => (
        <mesh key={`root-coin-${i}`} position={pos as [number, number, number]} rotation={[Math.PI / 2, 0, i * 0.35]}>
          <cylinderGeometry args={[2.5, 2.5, 1, 10]} />
          <meshStandardMaterial color={0xffd700} metalness={0.75} roughness={0.2} />
        </mesh>
      ))}
      {/* Floating gold coins */}
      <group ref={coinsRef}>
        {[[-12, 11, -8], [8, 12, 10], [-6, 16, 12], [14, 10, -6], [0, 18, -12], [-16, 8, 4]].map((pos, i) => (
          <mesh key={`coin-${i}`} position={pos as [number, number, number]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[2.5, 2.5, 0.6, 8]} />
            <meshStandardMaterial color={0xffd700} metalness={0.85} roughness={0.15} emissive={0xffa000} emissiveIntensity={0.2} />
          </mesh>
        ))}
      </group>
      {/* Magical glow ring at base */}
      <mesh position={[0, 1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[14, 18, 24]} />
        <meshStandardMaterial color={0x69f0ae} transparent opacity={0.3} emissive={0x69f0ae} emissiveIntensity={0.4} side={THREE.DoubleSide} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={scatterR} tone="forest" />
      <FloatingLabel text="Money Tree" y={96} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 8. RAINBOW POOL â€” Stone pool, sparkling water, vibrant rainbow arc
// ---------------------------------------------------------------------------
function RainbowPoolBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const arcRef = useRef<THREE.Group>(null);
  const waterRef = useRef<THREE.MeshStandardMaterial>(null);
  const poolR = Math.min(zone.width, zone.height) * TILE_SIZE * 0.45;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (waterRef.current) {
      waterRef.current.opacity = 0.7 + Math.sin(t * 2) * 0.1;
    }
    if (arcRef.current) {
      arcRef.current.rotation.y = t * 0.15;
    }
  });

  const rainbowColors = [0xff0000, 0xff7700, 0xffff00, 0x00ff00, 0x0000ff, 0x8b00ff];

  return (
    <group position={[cx, 0, cz]}>
      {/* Carved stone rim â€” elevated */}
      <mesh position={[0, 3, 0]}>
        <torusGeometry args={[poolR, 4, 8, 24]} />
        <meshStandardMaterial color={0x78909c} roughness={0.85} />
      </mesh>
      {/* Inner stone basin */}
      <mesh position={[0, 1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[poolR - 3, 24]} />
        <meshStandardMaterial color={0x607d8b} roughness={0.8} />
      </mesh>
      {/* Sparkling water */}
      <mesh position={[0, 2.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[poolR - 4, 24]} />
        <meshStandardMaterial ref={waterRef} color={0x4fc3f7} transparent opacity={0.75} roughness={0.05} metalness={0.6} side={THREE.DoubleSide} />
      </mesh>
      {/* Rainbow arc */}
      <group ref={arcRef}>
        {rainbowColors.map((color, i) => (
          <mesh key={`arc-${i}`} position={[0, 6, 0]}>
            <torusGeometry args={[poolR * 0.85 + i * 2.5, 1.5, 6, 32, Math.PI]} />
            <meshStandardMaterial color={color} roughness={0.3} emissive={color} emissiveIntensity={0.2} />
          </mesh>
        ))}
      </group>
      {/* Sparkle orbs floating above water */}
      {[0, 1, 2, 3].map((i) => (
        <mesh key={`sparkle-${i}`} position={[Math.cos(i * 1.5) * poolR * 0.5, 5, Math.sin(i * 1.5) * poolR * 0.5]}>
          <sphereGeometry args={[1, 6, 6]} />
          <meshStandardMaterial color={0xffffff} emissive={0xffffff} emissiveIntensity={0.8} transparent opacity={0.6} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={poolR * 1.15} tone="cool" />
      <FloatingLabel text="Rainbow Pool" y={poolR + 30} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 9. WISHING WELL â€” Fairy-tale stone well, wooden shingle roof, glow
// ---------------------------------------------------------------------------
function WishingWellBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const wellR = TILE_SIZE * 1.2;
  const wallH = TILE_SIZE * 1.0;
  const roofH = TILE_SIZE * 1.2;
  const glowRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (glowRef.current) {
      const t = clock.getElapsedTime();
      glowRef.current.emissiveIntensity = 0.3 + Math.sin(t * 2) * 0.2;
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Stone well walls */}
      <mesh position={[0, wallH / 2, 0]}>
        <cylinderGeometry args={[wellR, wellR, wallH, 12, 1, true]} />
        <meshStandardMaterial color={0x78909c} roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      {/* Well rim â€” ornate stone */}
      <mesh position={[0, wallH, 0]}>
        <torusGeometry args={[wellR + 1, 2.5, 6, 12]} />
        <meshStandardMaterial color={0x607d8b} roughness={0.8} />
      </mesh>
      {/* Magical glow from inside */}
      <mesh position={[0, wallH * 0.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[wellR - 2, 12]} />
        <meshStandardMaterial ref={glowRef} color={0x00bcd4} emissive={0x00bcd4} emissiveIntensity={0.3} transparent opacity={0.7} />
      </mesh>
      {/* Support posts */}
      {[-1, 1].map((side) => (
        <mesh key={`post-${side}`} position={[side * (wellR - 2), wallH + roofH / 2, 0]}>
          <cylinderGeometry args={[1.5, 1.5, roofH, 4]} />
          <meshStandardMaterial color={0x5d4037} roughness={0.9} />
        </mesh>
      ))}
      {/* Wooden shingle roof */}
      <mesh position={[0, wallH + roofH + 5, 0]}>
        <coneGeometry args={[wellR + 8, 16, 6]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.85} />
      </mesh>
      {/* Rope */}
      <mesh position={[0, wallH + roofH * 0.5, 0]}>
        <cylinderGeometry args={[0.5, 0.5, roofH * 0.7, 4]} />
        <meshStandardMaterial color={0xbcaaa4} roughness={0.95} />
      </mesh>
      {/* Bucket */}
      <mesh position={[0, wallH + 4, 0]}>
        <cylinderGeometry args={[2, 2.5, 4, 6]} />
        <meshStandardMaterial color={0x795548} roughness={0.9} />
      </mesh>
      {/* Sparkle wish particles around top */}
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh key={`wish-${i}`} position={[Math.cos(i * 1.26) * (wellR + 4), wallH + 8 + i * 3, Math.sin(i * 1.26) * (wellR + 4)]}>
          <sphereGeometry args={[0.8, 4, 4]} />
          <meshStandardMaterial color={0xffd700} emissive={0xffd700} emissiveIntensity={0.6} transparent opacity={0.5} />
        </mesh>
      ))}
      <GroundScatter seedKey={zone.id} radius={wellR * 1.9} tone="magic" />
      <FloatingLabel text="Wishing Well" y={wallH + roofH + 28} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 10. TREASURE ISLAND â€” Sandy mound, palm tree, treasure chest, pirate flag
// ---------------------------------------------------------------------------
function TreasureIslandBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const palmRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (palmRef.current) {
      const t = clock.getElapsedTime();
      palmRef.current.rotation.z = Math.sin(t * 0.7) * 0.04;
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Sandy island mound */}
      <mesh position={[0, 3, 0]}>
        <cylinderGeometry args={[w * 0.4, w * 0.55, 6, 12]} />
        <meshStandardMaterial color={0xf4d03f} roughness={0.95} />
      </mesh>
      {/* Seashells on sand */}
      {[[8, 6.5, 10], [-12, 6.5, 8], [5, 6.5, -14]].map((pos, i) => (
        <mesh key={`shell-${i}`} position={pos as [number, number, number]} rotation={[-Math.PI / 2, 0, i * 1.2]}>
          <circleGeometry args={[1.5, 6]} />
          <meshStandardMaterial color={0xfce4ec} roughness={0.6} />
        </mesh>
      ))}
      {/* Palm tree */}
      <group ref={palmRef} position={[w * 0.15, 6, 0]}>
        <mesh position={[0, 20, 0]} rotation={[0, 0, 0.12]}>
          <cylinderGeometry args={[2, 3.5, 40, 6]} />
          <meshStandardMaterial color={0x795548} roughness={0.9} />
        </mesh>
        {/* Coconuts */}
        {[[-2, 39, -2], [2, 38, 2], [0, 39, 3]].map((pos, i) => (
          <mesh key={`coco-${i}`} position={pos as [number, number, number]}>
            <sphereGeometry args={[1.5, 6, 6]} />
            <meshStandardMaterial color={0x795548} roughness={0.8} />
          </mesh>
        ))}
        {/* Palm fronds */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <group key={`frond-${i}`} position={[0, 40, 0]} rotation={[0.6, (i * Math.PI * 2) / 6, 0.3]}>
            <mesh position={[0, 0, -10]}>
              <coneGeometry args={[3.5, 22, 4]} />
              <meshStandardMaterial color={0x2e7d32} roughness={0.8} side={THREE.DoubleSide} />
            </mesh>
          </group>
        ))}
      </group>
      {/* Treasure chest */}
      <mesh position={[-w * 0.2, 7.5, 8]}>
        <boxGeometry args={[10, 7, 7]} />
        <meshStandardMaterial color={0x6d4c41} roughness={0.7} />
      </mesh>
      {/* Gold lid */}
      <mesh position={[-w * 0.2, 11.5, 8]}>
        <boxGeometry args={[11, 2, 8]} />
        <meshStandardMaterial color={0xffd700} metalness={0.7} roughness={0.2} />
      </mesh>
      {/* Gold spilling out */}
      {[[-w * 0.2 - 4, 8, 12], [-w * 0.2 + 3, 7.5, 13]].map((pos, i) => (
        <mesh key={`gold-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[1.5, 6, 6]} />
          <meshStandardMaterial color={0xffd700} metalness={0.8} roughness={0.15} />
        </mesh>
      ))}
      {/* Pirate flag on palm */}
      <mesh position={[w * 0.15 + 6, 42, 0]} rotation={[0, 0.3, 0]}>
        <planeGeometry args={[10, 7]} />
        <meshStandardMaterial color={0x212121} roughness={0.7} side={THREE.DoubleSide} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={w * 0.5} tone="warm" />
      <FloatingLabel text="Treasure Island" y={62} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 11. NEOPIAN FLATS â€” Multi-story brick building with dormers & flower boxes
// ---------------------------------------------------------------------------
function NeopianFlatsBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 60;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, 0.015]}>
      {/* Main and side towers for a hotel-like silhouette */}
      <mesh position={[0, wallH * 0.45, 0]} castShadow>
        <boxGeometry args={[w * 0.88, wallH * 0.9, d * 0.88]} />
        <meshStandardMaterial color={0xbf360c} roughness={0.86} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={`wing-${side}`} position={[side * w * 0.36, wallH * 0.4, 0]} castShadow>
          <boxGeometry args={[w * 0.26, wallH * 0.8, d * 0.7]} />
          <meshStandardMaterial color={0xc4512d} roughness={0.84} />
        </mesh>
      ))}
      {/* Mansard roof + dormers */}
      <group position={[0, wallH, 0]}>
        <PitchedRoof width={w + 10} depth={d + 10} height={24} color={0x5d4037} />
      </group>
      {[-1, 0, 1].map((col) => (
        <group key={`dormer-${col}`} position={[col * w * 0.25, wallH + 12, -d * 0.14]}>
          <mesh>
            <boxGeometry args={[10, 8, 8]} />
            <meshStandardMaterial color={0xefebe9} roughness={0.62} />
          </mesh>
          <group position={[0, 5, 0]}>
            <PitchedRoof width={11} depth={10} height={6} color={0x6d4c41} />
          </group>
        </group>
      ))}
      {/* Window grid - 3 columns x 3 floors */}
      {[0, 1, 2].map((floor) =>
        [-1, 0, 1].map((col) => (
          <group key={`win-${floor}-${col}`}>
            <mesh position={[col * (w * 0.26), 9 + floor * 16, -d / 2 - 1.1]}>
              <planeGeometry args={[8, 10]} />
              <meshStandardMaterial color={0xbbdefb} emissive={0xffca28} emissiveIntensity={floor === 1 ? 0.33 : 0.15} />
            </mesh>
            <mesh position={[col * (w * 0.26), 9 + floor * 16, -d / 2 - 0.7]}>
              <boxGeometry args={[9, 11, 0.65]} />
              <meshStandardMaterial color={0xefebe9} roughness={0.62} />
            </mesh>
          </group>
        ))
      )}
      {/* Balconies and flower boxes */}
      {[-1, 1].map((col) => (
        <mesh key={`balcony-${col}`} position={[col * (w * 0.26), 28, -d / 2 - 3.3]}>
          <boxGeometry args={[11, 1.2, 3]} />
          <meshStandardMaterial color={0x8d6e63} roughness={0.82} />
        </mesh>
      ))}
      {[-1, 0, 1].map((col) => (
        <mesh key={`fbox-${col}`} position={[col * (w * 0.26), 4, -d / 2 - 2.8]}>
          <boxGeometry args={[10, 3, 3]} />
          <meshStandardMaterial color={0x6d4c41} roughness={0.82} />
        </mesh>
      ))}
      {[-1, 0, 1].map((col) =>
        [-2, 0, 2].map((fx, fi) => (
          <mesh key={`flower-${col}-${fi}`} position={[col * (w * 0.26) + fx, 6.7, -d / 2 - 2.7]}>
            <sphereGeometry args={[1, 6, 5]} />
            <meshStandardMaterial color={[0xef5350, 0xffca28, 0xf48fb1][fi]} />
          </mesh>
        ))
      )}
      {/* Arched entry */}
      <mesh position={[0, 10, -d / 2 - 1.1]}>
        <boxGeometry args={[13, 20, 2]} />
        <meshStandardMaterial color={0x5d4037} roughness={0.8} />
      </mesh>
      <mesh position={[0, 20, -d / 2 - 1.1]}>
        <cylinderGeometry args={[6.6, 6.6, 2, 12, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.75} side={THREE.DoubleSide} />
      </mesh>
      {[0, 1].map((step) => (
        <mesh key={`step-${step}`} position={[0, 1 + step * 1.4, -d / 2 - 4.4 - step * 1.8]}>
          <boxGeometry args={[17, 1.3, 2.4]} />
          <meshStandardMaterial color={0x9e9e9e} roughness={0.8} />
        </mesh>
      ))}
      <mesh position={[w * 0.3, wallH + 15, 0]}>
        <boxGeometry args={[6, 12, 6]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.86} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.56} tone="warm" />
      <FloatingLabel text="Neopian Flats" y={92} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 12. ART STUDIO — Bohemian cottage with paint splatters, skylight, easel
// ---------------------------------------------------------------------------
function ArtStudioBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 38;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.045]}>
      {/* Crooked studio volumes */}
      <mesh position={[0, wallH * 0.45, 0]} castShadow>
        <boxGeometry args={[w * 0.86, wallH * 0.9, d * 0.84]} />
        <meshStandardMaterial color={0xfff3e0} roughness={0.72} />
      </mesh>
      <mesh position={[w * 0.18, wallH * 0.36, d * 0.22]} rotation={[0, 0.12, 0.05]} castShadow>
        <boxGeometry args={[w * 0.36, wallH * 0.55, d * 0.34]} />
        <meshStandardMaterial color={0xffe0b2} roughness={0.7} />
      </mesh>
      {/* Slanted loft roof + bright trim */}
      <group position={[0, wallH, 0]} rotation={[0, 0, 0.05]}>
        <PitchedRoof width={w + 10} depth={d + 10} height={24} color={0x42a5f5} />
      </group>
      <mesh position={[0, wallH + 3, 0]} rotation={[0, 0, 0.05]}>
        <boxGeometry args={[w + 8, 2, d + 8]} />
        <meshStandardMaterial color={0xffca28} roughness={0.6} />
      </mesh>
      {/* Skylight */}
      <mesh position={[0, wallH + 13, -4]} rotation={[0.52, 0, 0.05]}>
        <planeGeometry args={[12, 9]} />
        <meshStandardMaterial color={0xbbdefb} emissive={0x90caf9} emissiveIntensity={0.34} transparent opacity={0.82} />
      </mesh>
      {/* Paint splatters and drips */}
      {[
        { pos: [-w * 0.3, 24, -d / 2 - 1], color: 0xef5350, r: 3.2 },
        { pos: [w * 0.2, 18, -d / 2 - 1], color: 0x42a5f5, r: 3.7 },
        { pos: [-w * 0.1, 30, -d / 2 - 1], color: 0xffca28, r: 2.9 },
        { pos: [w * 0.35, 26, -d / 2 - 1], color: 0x66bb6a, r: 3.4 },
      ].map((splat, i) => (
        <group key={`splat-${i}`} position={splat.pos as [number, number, number]}>
          <mesh>
            <circleGeometry args={[splat.r, 10]} />
            <meshStandardMaterial color={splat.color} roughness={0.6} />
          </mesh>
          <mesh position={[0, -3.5, 0]}>
            <boxGeometry args={[1.1, 3.8, 0.4]} />
            <meshStandardMaterial color={splat.color} roughness={0.6} />
          </mesh>
        </group>
      ))}
      {/* Easel + canvas */}
      <group position={[-w * 0.4, 0, -d / 2 - 9]}>
        <mesh position={[-2, 8, 0]} rotation={[0, 0, 0.15]}>
          <cylinderGeometry args={[0.5, 0.5, 16, 4]} />
          <meshStandardMaterial color={0x8d6e63} roughness={0.9} />
        </mesh>
        <mesh position={[2, 8, 0]} rotation={[0, 0, -0.15]}>
          <cylinderGeometry args={[0.5, 0.5, 16, 4]} />
          <meshStandardMaterial color={0x8d6e63} roughness={0.9} />
        </mesh>
        <mesh position={[0, 12, -1]}>
          <boxGeometry args={[8, 6, 0.5]} />
          <meshStandardMaterial color={0xffffff} roughness={0.5} />
        </mesh>
      </group>
      {/* Pencil fence */}
      {[-2, -1, 0, 1, 2].map((i) => (
        <mesh key={`pencil-${i}`} position={[w * 0.4 + i * 2.5, 4, -d / 2 - 7]} rotation={[0, 0, (i - 1) * 0.04]}>
          <coneGeometry args={[1, 8, 6]} />
          <meshStandardMaterial color={[0xef5350, 0x42a5f5, 0xffca28, 0x66bb6a, 0xab47bc][i + 2]} roughness={0.56} />
        </mesh>
      ))}
      <mesh position={[0, 8, -d / 2 - 1.2]}>
        <boxGeometry args={[10, 16, 2]} />
        <meshStandardMaterial color={0x5d4037} roughness={0.8} />
      </mesh>
      <mesh position={[w * 0.35, 20, -d / 2 - 5]}>
        <circleGeometry args={[5, 12]} />
        <meshStandardMaterial color={0xffd700} roughness={0.5} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.5} tone="warm" />
      <FloatingLabel text="Art Studio" y={72} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 13. JUICE SHOP â€” Fruit-shaped building, orange dome, straw on top
// ---------------------------------------------------------------------------
function JuiceShopBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const r = zone.width * TILE_SIZE * 0.42;

  return (
    <group position={[cx, 0, cz]}>
      {/* Orange fruit body */}
      <mesh position={[0, r, 0]} castShadow>
        <sphereGeometry args={[r, 12, 10]} />
        <meshStandardMaterial color={0xff9800} roughness={0.6} />
      </mesh>
      {/* Green leaf top */}
      <mesh position={[0, r * 2 - 2, 0]}>
        <coneGeometry args={[8, 6, 6]} />
        <meshStandardMaterial color={0x4caf50} roughness={0.7} />
      </mesh>
      {/* Straw sticking out */}
      <mesh position={[3, r * 2 + 6, 0]} rotation={[0, 0, 0.15]}>
        <cylinderGeometry args={[0.8, 0.8, 16, 4]} />
        <meshStandardMaterial color={0xef5350} roughness={0.5} />
      </mesh>
      {/* Straw bend */}
      <mesh position={[5, r * 2 + 14, 0]} rotation={[0, 0, 0.6]}>
        <cylinderGeometry args={[0.8, 0.8, 6, 4]} />
        <meshStandardMaterial color={0xef5350} roughness={0.5} />
      </mesh>
      {/* Orange slice decoration on front */}
      <mesh position={[0, r, -r - 0.5]} rotation={[0, 0, 0]}>
        <circleGeometry args={[8, 8]} />
        <meshStandardMaterial color={0xffa726} roughness={0.5} />
      </mesh>
      {/* Slice segments */}
      {[0, 1, 2, 3].map((i) => (
        <mesh key={`seg-${i}`} position={[Math.cos(i * 0.8 - 0.8) * 4, r + Math.sin(i * 0.8 - 0.8) * 4, -r - 1]}>
          <circleGeometry args={[1.5, 6]} />
          <meshStandardMaterial color={0xffcc80} roughness={0.5} />
        </mesh>
      ))}
      {/* Door carved into fruit */}
      <mesh position={[0, 8, -r + 2]}>
        <boxGeometry args={[10, 16, 4]} />
        <meshStandardMaterial color={0xe65100} roughness={0.7} />
      </mesh>
      {/* Fruit crate outside */}
      <mesh position={[r + 4, 3, 0]}>
        <boxGeometry args={[6, 6, 6]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.8} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={r * 1.28} tone="warm" />
      <FloatingLabel text="Juice Shop" y={r * 2 + 24} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 14. ELECTRONICS SHOP â€” Angular, futuristic, antenna, circuit glow
// ---------------------------------------------------------------------------
function ElectronicsShopBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 34;
  const glowRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame(({ clock }) => {
    if (glowRef.current) {
      const t = clock.getElapsedTime();
      glowRef.current.emissiveIntensity = 0.3 + Math.sin(t * 3) * 0.2;
    }
  });

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, 0.03]}>
      {/* Compact gadget hut instead of flat slab */}
      <mesh position={[0, wallH * 0.45, 0]} castShadow>
        <boxGeometry args={[w * 0.68, wallH * 0.9, d * 0.62]} />
        <meshStandardMaterial color={0x455a64} roughness={0.72} />
      </mesh>
      <group position={[0, wallH + 5, 0]} rotation={[0, 0, -0.08]}>
        <PitchedRoof width={w * 0.84} depth={d * 0.72} height={10} color={0x2f3a44} />
      </group>
      {/* Neon fascia strip */}
      <mesh position={[0, wallH + 2.2, -d * 0.08]}>
        <boxGeometry args={[w * 0.72, 1.1, d * 0.06]} />
        <meshStandardMaterial color={0x00bcd4} emissive={0x00bcd4} emissiveIntensity={0.35} />
      </mesh>
      {/* Satellite dish + antenna */}
      <mesh position={[w * 0.2, wallH + 12, 0]} rotation={[0.55, 0, 0]}>
        <sphereGeometry args={[6, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.45]} />
        <meshStandardMaterial color={0x90a4ae} roughness={0.45} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[-w * 0.22, wallH + 11, 0]}>
        <cylinderGeometry args={[0.55, 0.55, 18, 6]} />
        <meshStandardMaterial color={0x78909c} roughness={0.6} />
      </mesh>
      <mesh position={[-w * 0.22, wallH + 20, 0]}>
        <sphereGeometry args={[1.4, 8, 6]} />
        <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.85} />
      </mesh>
      {/* Screen panel */}
      <mesh position={[0, wallH * 0.52, -d * 0.33]}>
        <planeGeometry args={[16, 11]} />
        <meshStandardMaterial ref={glowRef} color={0x00bcd4} emissive={0x00bcd4} emissiveIntensity={0.3} />
      </mesh>
      {/* Circuit motifs */}
      {[[-8, 10, -d * 0.33], [8, 15, -d * 0.33], [-2, 19, -d * 0.33], [6, 12, -d * 0.33]].map((pos, i) => (
        <mesh key={`circuit-${i}`} position={pos as [number, number, number]}>
          <boxGeometry args={[6, 0.6, 0.4]} />
          <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.45} />
        </mesh>
      ))}
      {[[-6, 4, -d * 0.34], [0, 4, -d * 0.34], [6, 4, -d * 0.34]].map((pos, i) => (
        <mesh key={`led-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[0.9, 8, 6]} />
          <meshStandardMaterial color={0x80deea} emissive={0x4dd0e1} emissiveIntensity={0.35} />
        </mesh>
      ))}
      <mesh position={[0, 8, -d * 0.31]}>
        <boxGeometry args={[10, 15, 2]} />
        <meshStandardMaterial color={0x263238} roughness={0.72} />
      </mesh>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.46} tone="cool" />
      <FloatingLabel text="Electronics Shop" y={wallH + 30} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// 15. PHARMACY â€” Clean white building, green cross, medicine details
// ---------------------------------------------------------------------------
function PharmacyBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallH = 38;

  return (
    <group position={[cx, 0, cz]} rotation={[0, 0, -0.03]}>
      {/* Yellow cottage body based on map pharmacy */}
      <mesh position={[0, wallH * 0.42, 0]} castShadow>
        <boxGeometry args={[w * 0.84, wallH * 0.84, d * 0.8]} />
        <meshStandardMaterial color={0xf2e577} roughness={0.58} />
      </mesh>
      {/* Dark blue curved roof */}
      <group position={[0, wallH + 6, 0]} rotation={[0, 0, 0.06]}>
        <mesh castShadow>
          <sphereGeometry args={[w * 0.44, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
          <meshStandardMaterial color={0x2f3f71} roughness={0.62} />
        </mesh>
        <mesh position={[0, 1.3, 0]}>
          <sphereGeometry args={[w * 0.39, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.46]} />
          <meshStandardMaterial color={0x3f5491} roughness={0.56} />
        </mesh>
      </group>
      {/* Chimney */}
      <mesh position={[w * 0.26, wallH + 17, 0]} rotation={[0, 0, 0.06]}>
        <boxGeometry args={[4.5, 10, 4.5]} />
        <meshStandardMaterial color={0xcf4d3a} roughness={0.7} />
      </mesh>
      {/* Green cross sign */}
      <group position={[0, wallH * 0.62, -d / 2 - 1.6]}>
        <mesh>
          <boxGeometry args={[4, 12, 2]} />
          <meshStandardMaterial color={0x4caf50} emissive={0x4caf50} emissiveIntensity={0.24} />
        </mesh>
        <mesh>
          <boxGeometry args={[12, 4, 2]} />
          <meshStandardMaterial color={0x4caf50} emissive={0x4caf50} emissiveIntensity={0.24} />
        </mesh>
      </group>
      {/* Oval windows */}
      {[-w * 0.22, w * 0.22].map((x, i) => (
        <group key={`pwin-${i}`} position={[x, wallH * 0.46, -d / 2 - 1.1]}>
          <mesh>
            <cylinderGeometry args={[3.6, 3.6, 1.4, 12]} />
            <meshStandardMaterial color={0x2f3f71} roughness={0.7} />
          </mesh>
          <mesh position={[0, 0, 0.8]}>
            <circleGeometry args={[2.8, 10]} />
            <meshStandardMaterial color={0xecffe0} emissive={0xc8e6c9} emissiveIntensity={0.25} />
          </mesh>
        </group>
      ))}
      {/* Front door */}
      <mesh position={[0, 8, -d / 2 - 1.2]}>
        <boxGeometry args={[10, 16, 2]} />
        <meshStandardMaterial color={0xffffff} roughness={0.5} />
      </mesh>
      <mesh position={[0, 15, -d / 2 - 1.2]}>
        <cylinderGeometry args={[5.2, 5.2, 2, 12, 1, false, 0, Math.PI]} />
        <meshStandardMaterial color={0xeff8ff} roughness={0.5} side={THREE.DoubleSide} />
      </mesh>
      {/* Small mortar icon on side */}
      <group position={[w * 0.36, 21, -d / 2 - 4.8]}>
        <mesh>
          <sphereGeometry args={[3.6, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
          <meshStandardMaterial color={0x9e9e9e} roughness={0.7} />
        </mesh>
        <mesh position={[1, 1.8, 0]} rotation={[0, 0, 0.6]}>
          <cylinderGeometry args={[0.8, 0.8, 5, 6]} />
          <meshStandardMaterial color={0xbdbdbd} roughness={0.6} />
        </mesh>
      </group>
      <GroundScatter seedKey={zone.id} radius={Math.max(w, d) * 0.52} tone="mint" />
      <FloatingLabel text="Pharmacy" y={64} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Building dispatcher
// ---------------------------------------------------------------------------
const BUILDING_RENDERERS: Record<string, React.FC<{ zone: BuildingZone }>> = {
  'potion-shop': PotionShopBuilding,
  'auction-house': AuctionHouseBuilding,
  'book-shop': BookShopBuilding,
  'clothing-shop': ClothingShopBuilding,
  'bazaar': BazaarBuilding,
  'petpet-shop': PetpetShopBuilding,
  'money-tree': MoneyTreeBuilding,
  'rainbow-pool': RainbowPoolBuilding,
  'wishing-well': WishingWellBuilding,
  'treasure-island': TreasureIslandBuilding,
  'neopian-flats': NeopianFlatsBuilding,
  'art-studio': ArtStudioBuilding,
  'juice-shop': JuiceShopBuilding,
  'electronics-shop': ElectronicsShopBuilding,
  'pharmacy': PharmacyBuilding,
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


