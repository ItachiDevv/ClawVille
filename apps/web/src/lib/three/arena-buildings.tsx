'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// Centering offset
// ---------------------------------------------------------------------------
const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

// ---------------------------------------------------------------------------
// Building color config
// ---------------------------------------------------------------------------
interface BuildingStyle {
  wall: number;
  roof: number;
  type: 'standard' | 'money-tree' | 'rainbow-pool' | 'wishing-well' | 'treasure-island';
}

const BUILDING_STYLES: Record<string, BuildingStyle> = {
  'potion-shop':      { wall: 0x9c27b0, roof: 0x7b1fa2, type: 'standard' },
  'auction-house':    { wall: 0xd7ccc8, roof: 0xef5350, type: 'standard' },
  'book-shop':        { wall: 0x8d6e63, roof: 0x5d4037, type: 'standard' },
  'clothing-shop':    { wall: 0xec407a, roof: 0xc2185b, type: 'standard' },
  'bazaar':           { wall: 0xd7ccc8, roof: 0xef5350, type: 'standard' },
  'petpet-shop':      { wall: 0xffe0b2, roof: 0x66bb6a, type: 'standard' },
  'money-tree':       { wall: 0x795548, roof: 0x4caf50, type: 'money-tree' },
  'rainbow-pool':     { wall: 0x29b6f6, roof: 0xff5722, type: 'rainbow-pool' },
  'wishing-well':     { wall: 0x9e9e9e, roof: 0x8d6e63, type: 'wishing-well' },
  'treasure-island':  { wall: 0xffe082, roof: 0x795548, type: 'treasure-island' },
  'neopian-flats':    { wall: 0xffccbc, roof: 0xef5350, type: 'standard' },
  'art-studio':       { wall: 0xfff3e0, roof: 0x42a5f5, type: 'standard' },
  'juice-shop':       { wall: 0xff9800, roof: 0xe65100, type: 'standard' },
  'electronics-shop': { wall: 0x78909c, roof: 0x37474f, type: 'standard' },
  'pharmacy':         { wall: 0xf5f5f5, roof: 0x4caf50, type: 'standard' },
};

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

// ---------------------------------------------------------------------------
// Pitched roof geometry (triangular prism)
// ---------------------------------------------------------------------------
function PitchedRoof({
  width,
  depth,
  height,
  color,
}: {
  width: number;
  depth: number;
  height: number;
  color: number;
}) {
  const geometry = useMemo(() => {
    const hw = width / 2;
    const hd = depth / 2;

    // Vertices for a triangular prism roof
    const vertices = new Float32Array([
      // Front triangle
      -hw, 0, -hd,
       hw, 0, -hd,
       0,  height, -hd,
      // Back triangle
      -hw, 0, hd,
       hw, 0, hd,
       0,  height, hd,
      // Left slope
      -hw, 0, -hd,
       0,  height, -hd,
       0,  height, hd,
      -hw, 0, hd,
      // Right slope
       hw, 0, -hd,
       hw, 0, hd,
       0,  height, hd,
       0,  height, -hd,
      // Bottom
      -hw, 0, -hd,
      -hw, 0, hd,
       hw, 0, hd,
       hw, 0, -hd,
    ]);

    const indices = [
      // Front
      0, 1, 2,
      // Back
      3, 5, 4,
      // Left slope
      6, 7, 8, 6, 8, 9,
      // Right slope
      10, 11, 12, 10, 12, 13,
      // Bottom
      14, 15, 16, 14, 16, 17,
    ];

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

// ---------------------------------------------------------------------------
// Standard building: box walls + pitched roof + door
// ---------------------------------------------------------------------------
function StandardBuilding({ zone, style }: { zone: BuildingZone; style: BuildingStyle }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const wallHeight = Math.max(w, d) * 0.55;
  const roofHeight = wallHeight * 0.45;
  const doorWidth = TILE_SIZE * 0.8;
  const doorHeight = wallHeight * 0.5;

  return (
    <group position={[cx, 0, cz]}>
      {/* Walls */}
      <mesh position={[0, wallHeight / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, wallHeight, d]} />
        <meshStandardMaterial color={style.wall} roughness={0.75} />
      </mesh>

      {/* Door (recessed on front face, z = -depth/2) */}
      <mesh position={[0, doorHeight / 2, -d / 2 - 0.1]}>
        <boxGeometry args={[doorWidth, doorHeight, 1]} />
        <meshStandardMaterial color={0x5d4037} roughness={0.8} />
      </mesh>

      {/* Windows - front face */}
      <mesh position={[-w * 0.3, wallHeight * 0.6, -d / 2 - 0.1]}>
        <boxGeometry args={[TILE_SIZE * 0.5, TILE_SIZE * 0.5, 0.5]} />
        <meshStandardMaterial color={0xbbdefb} roughness={0.3} metalness={0.2} />
      </mesh>
      <mesh position={[w * 0.3, wallHeight * 0.6, -d / 2 - 0.1]}>
        <boxGeometry args={[TILE_SIZE * 0.5, TILE_SIZE * 0.5, 0.5]} />
        <meshStandardMaterial color={0xbbdefb} roughness={0.3} metalness={0.2} />
      </mesh>

      {/* Pitched roof */}
      <group position={[0, wallHeight, 0]}>
        <PitchedRoof width={w + 8} depth={d + 8} height={roofHeight} color={style.roof} />
      </group>

      {/* Floating label */}
      <Text
        position={[0, wallHeight + roofHeight + 10, 0]}
        fontSize={8}
        color="white"
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.8}
        outlineColor="black"
      >
        {formatLabel(zone.id)}
      </Text>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Special: Money Tree (large tree with trunk + canopy sphere)
// ---------------------------------------------------------------------------
function MoneyTreeBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const canopyRef = useRef<THREE.Mesh>(null);

  // Gentle sway animation
  useFrame(({ clock }) => {
    if (canopyRef.current) {
      const t = clock.getElapsedTime();
      canopyRef.current.rotation.y = Math.sin(t * 0.5) * 0.05;
      canopyRef.current.position.y = 55 + Math.sin(t * 0.8) * 1.5;
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Trunk */}
      <mesh position={[0, 22, 0]} castShadow>
        <cylinderGeometry args={[4, 6, 44, 8]} />
        <meshStandardMaterial color={0x795548} roughness={0.9} />
      </mesh>

      {/* Main canopy */}
      <mesh ref={canopyRef} position={[0, 55, 0]} castShadow>
        <sphereGeometry args={[32, 12, 10]} />
        <meshStandardMaterial color={0x4caf50} roughness={0.8} />
      </mesh>

      {/* Secondary smaller canopy blobs */}
      <mesh position={[-18, 45, 10]}>
        <sphereGeometry args={[16, 8, 8]} />
        <meshStandardMaterial color={0x66bb6a} roughness={0.85} />
      </mesh>
      <mesh position={[16, 48, -12]}>
        <sphereGeometry args={[14, 8, 8]} />
        <meshStandardMaterial color={0x388e3c} roughness={0.85} />
      </mesh>

      {/* Gold coins scattered at base */}
      {[
        [-8, 1, -6],
        [5, 1, 8],
        [-3, 1, 10],
        [10, 1, -4],
        [0, 1, -10],
      ].map((pos, i) => (
        <mesh key={`coin-${i}`} position={pos as [number, number, number]} rotation={[Math.PI / 2, 0, i * 0.7]}>
          <cylinderGeometry args={[2, 2, 0.5, 8]} />
          <meshStandardMaterial color={0xffd700} metalness={0.8} roughness={0.2} />
        </mesh>
      ))}

      {/* Label */}
      <Text
        position={[0, 90, 0]}
        fontSize={8}
        color="white"
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.8}
        outlineColor="black"
      >
        Money Tree
      </Text>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Special: Rainbow Pool (water ring + colorful arc)
// ---------------------------------------------------------------------------
function RainbowPoolBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const arcRef = useRef<THREE.Group>(null);
  const waterRef = useRef<THREE.MeshStandardMaterial>(null);

  const poolRadius = Math.min(zone.width, zone.height) * TILE_SIZE * 0.45;

  // Animate water and rainbow arc
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (waterRef.current) {
      waterRef.current.opacity = 0.7 + Math.sin(t * 2) * 0.1;
    }
    if (arcRef.current) {
      arcRef.current.rotation.y = t * 0.2;
    }
  });

  // Rainbow arc colors
  const rainbowColors = [0xff0000, 0xff7700, 0xffff00, 0x00ff00, 0x0000ff, 0x8b00ff];

  return (
    <group position={[cx, 0, cz]}>
      {/* Pool basin (stone ring) */}
      <mesh position={[0, 1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[poolRadius - 4, poolRadius + 4, 24]} />
        <meshStandardMaterial color={0x9e9e9e} roughness={0.8} side={THREE.DoubleSide} />
      </mesh>

      {/* Water surface */}
      <mesh position={[0, 1.5, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[poolRadius - 4, 24]} />
        <meshStandardMaterial
          ref={waterRef}
          color={0x29b6f6}
          transparent
          opacity={0.75}
          roughness={0.1}
          metalness={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Rainbow arc (series of thin torus segments) */}
      <group ref={arcRef} position={[0, 0, 0]}>
        {rainbowColors.map((color, i) => (
          <mesh
            key={`arc-${i}`}
            position={[0, 5, 0]}
            rotation={[0, 0, 0]}
          >
            <torusGeometry args={[poolRadius * 0.8 + i * 2, 1.2, 6, 24, Math.PI]} />
            <meshStandardMaterial
              color={color}
              roughness={0.4}
              emissive={color}
              emissiveIntensity={0.15}
            />
          </mesh>
        ))}
      </group>

      {/* Label */}
      <Text
        position={[0, poolRadius + 25, 0]}
        fontSize={8}
        color="white"
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.8}
        outlineColor="black"
      >
        Rainbow Pool
      </Text>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Special: Wishing Well (circular stone well + wooden roof)
// ---------------------------------------------------------------------------
function WishingWellBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const wellRadius = TILE_SIZE * 1.2;
  const wallHeight = TILE_SIZE * 1.0;
  const roofHeight = TILE_SIZE * 1.2;

  return (
    <group position={[cx, 0, cz]}>
      {/* Stone well walls (hollow cylinder effect via torus) */}
      <mesh position={[0, wallHeight / 2, 0]}>
        <cylinderGeometry args={[wellRadius, wellRadius, wallHeight, 12, 1, true]} />
        <meshStandardMaterial color={0x9e9e9e} roughness={0.85} side={THREE.DoubleSide} />
      </mesh>

      {/* Well rim */}
      <mesh position={[0, wallHeight, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[wellRadius - 2, wellRadius + 3, 12]} />
        <meshStandardMaterial color={0x757575} roughness={0.8} side={THREE.DoubleSide} />
      </mesh>

      {/* Water inside */}
      <mesh position={[0, wallHeight * 0.3, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[wellRadius - 2, 12]} />
        <meshStandardMaterial color={0x0288d1} transparent opacity={0.6} roughness={0.1} metalness={0.4} />
      </mesh>

      {/* Support posts */}
      {[-1, 1].map((side) => (
        <mesh key={`post-${side}`} position={[side * (wellRadius - 2), wallHeight + roofHeight / 2, 0]}>
          <cylinderGeometry args={[1.5, 1.5, roofHeight, 4]} />
          <meshStandardMaterial color={0x795548} roughness={0.9} />
        </mesh>
      ))}

      {/* Wooden roof (cone) */}
      <mesh position={[0, wallHeight + roofHeight + 5, 0]}>
        <coneGeometry args={[wellRadius + 6, 14, 6]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.8} />
      </mesh>

      {/* Rope + bucket hint */}
      <mesh position={[0, wallHeight + roofHeight * 0.5, 0]}>
        <cylinderGeometry args={[0.4, 0.4, roofHeight * 0.7, 4]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.9} />
      </mesh>

      {/* Label */}
      <Text
        position={[0, wallHeight + roofHeight + 22, 0]}
        fontSize={8}
        color="white"
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.8}
        outlineColor="black"
      >
        Wishing Well
      </Text>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Special: Treasure Island (sandy base + palm tree)
// ---------------------------------------------------------------------------
function TreasureIslandBuilding({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;
  const palmRef = useRef<THREE.Group>(null);

  // Subtle sway
  useFrame(({ clock }) => {
    if (palmRef.current) {
      const t = clock.getElapsedTime();
      palmRef.current.rotation.z = Math.sin(t * 0.7) * 0.04;
    }
  });

  return (
    <group position={[cx, 0, cz]}>
      {/* Sandy base mound */}
      <mesh position={[0, 3, 0]}>
        <cylinderGeometry args={[w * 0.45, w * 0.55, 6, 10]} />
        <meshStandardMaterial color={0xffe082} roughness={0.95} />
      </mesh>

      {/* Palm tree */}
      <group ref={palmRef} position={[w * 0.15, 6, 0]}>
        {/* Curved trunk (simplified as tilted cylinder) */}
        <mesh position={[0, 20, 0]} rotation={[0, 0, 0.1]}>
          <cylinderGeometry args={[2, 3, 40, 6]} />
          <meshStandardMaterial color={0x795548} roughness={0.9} />
        </mesh>

        {/* Palm fronds (flat cones radiating out) */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <group key={`frond-${i}`} position={[0, 40, 0]} rotation={[0.6, (i * Math.PI * 2) / 6, 0.3]}>
            <mesh position={[0, 0, -10]}>
              <coneGeometry args={[3, 20, 4]} />
              <meshStandardMaterial color={0x2e7d32} roughness={0.8} side={THREE.DoubleSide} />
            </mesh>
          </group>
        ))}
      </group>

      {/* Treasure chest */}
      <mesh position={[-w * 0.2, 7, d * 0.1]}>
        <boxGeometry args={[8, 6, 6]} />
        <meshStandardMaterial color={0x8d6e63} roughness={0.7} />
      </mesh>
      {/* Chest lid accent */}
      <mesh position={[-w * 0.2, 10.5, d * 0.1]}>
        <boxGeometry args={[9, 1.5, 7]} />
        <meshStandardMaterial color={0xffd700} metalness={0.6} roughness={0.3} />
      </mesh>

      {/* Label */}
      <Text
        position={[0, 60, 0]}
        fontSize={8}
        color="white"
        anchorX="center"
        anchorY="bottom"
        outlineWidth={0.8}
        outlineColor="black"
      >
        Treasure Island
      </Text>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Building dispatcher
// ---------------------------------------------------------------------------
function BuildingMesh({ zone }: { zone: BuildingZone }) {
  const style = BUILDING_STYLES[zone.id];
  if (!style) return null;

  switch (style.type) {
    case 'money-tree':
      return <MoneyTreeBuilding zone={zone} />;
    case 'rainbow-pool':
      return <RainbowPoolBuilding zone={zone} />;
    case 'wishing-well':
      return <WishingWellBuilding zone={zone} />;
    case 'treasure-island':
      return <TreasureIslandBuilding zone={zone} />;
    case 'standard':
    default:
      return <StandardBuilding zone={zone} style={style} />;
  }
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
