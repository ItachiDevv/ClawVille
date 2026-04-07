'use client';

import { Text, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';
import { BUILDING_OPENCLAW_THEMES } from '@legacyapp/shared';

// ---------------------------------------------------------------------------
// Building model paths + scales
// ---------------------------------------------------------------------------
const BUILDING_MODELS: Record<string, { path: string; scale: number }> = {
  'cron-hub': { path: '/models/building-shell.glb', scale: 8 },
  'webhook-gateway': { path: '/models/building-anchor.glb', scale: 12 },
  'memory-vault': { path: '/models/building-cave.glb', scale: 3 },
  'skill-forge': { path: '/models/building-barrel.glb', scale: 6 },
  'channel-bridge': { path: '/models/building-lighthouse.glb', scale: 4 },
  'tool-workshop': { path: '/models/building-shipwreck.glb', scale: 4 },
  'canvas-studio': { path: '/models/building-lantern.glb', scale: 10 },
  'voice-tower': { path: '/models/building-tower2.glb', scale: 5 },
  'security-fortress': { path: '/models/building-seashell.glb', scale: 2 },
  'config-citadel': { path: '/models/building-submarine.glb', scale: 4 },
};

// Procedural building colors (used as fallback)
const BUILDING_COLORS: Record<string, number> = {
  'cron-hub': 0x00bcd4,
  'webhook-gateway': 0x2196f3,
  'memory-vault': 0x9c27b0,
  'skill-forge': 0xff5722,
  'channel-bridge': 0x4caf50,
  'tool-workshop': 0xff9800,
  'canvas-studio': 0xe91e63,
  'voice-tower': 0x3f51b5,
  'security-fortress': 0x607d8b,
  'config-citadel': 0x009688,
};

// ---------------------------------------------------------------------------
// Centering offset
// ---------------------------------------------------------------------------
const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

function zoneCenter(zone: BuildingZone): [number, number, number] {
  const cx = OFFSET_X + (zone.x + zone.width / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  return [cx, 0, cz];
}

// ---------------------------------------------------------------------------
// Floating label
// ---------------------------------------------------------------------------
function FloatingLabel({ text, subtitle, y }: { text: string; subtitle?: string; y: number }) {
  return (
    <group position={[0, y, 0]}>
      <mesh position={[0, -8, 0]}>
        <cylinderGeometry args={[0.7, 1, 14, 8]} />
        <meshStandardMaterial color={0x2e7d32} roughness={0.75} />
      </mesh>
      <Billboard follow lockX={false} lockY={false} lockZ={false}>
        <group>
          <mesh scale={[2.1, subtitle ? 1.5 : 1.18, 1]}>
            <circleGeometry args={[10.5, 32]} />
            <meshBasicMaterial color={0x0a1628} transparent opacity={0.9} depthTest={false} />
          </mesh>
          <mesh scale={[2.2, subtitle ? 1.55 : 1.22, 1]}>
            <ringGeometry args={[10.2, 10.8, 32]} />
            <meshBasicMaterial color={0x00e5ff} transparent opacity={0.4} depthTest={false} />
          </mesh>
          <Text position={[0, subtitle ? 2 : 0.05, 0.5]} fontSize={3.6} color="#00e5ff" anchorX="center" anchorY="middle" outlineWidth={0.2} outlineColor="#0a1628" maxWidth={30}>
            {text}
          </Text>
          {subtitle && (
            <Text position={[0, -2.8, 0.5]} fontSize={2.2} color="#ffffff" anchorX="center" anchorY="middle" outlineWidth={0.15} outlineColor="#0a1628" maxWidth={28}>
              {subtitle}
            </Text>
          )}
        </group>
      </Billboard>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Simple procedural building (always loads, no GLB dependency)
// ---------------------------------------------------------------------------
function ProceduralBuilding({ zone }: { zone: BuildingZone }) {
  const color = BUILDING_COLORS[zone.id] ?? 0x888888;
  const w = zone.width * TILE_SIZE * 0.7;
  const h = 20 + (zone.width * 3);
  const d = zone.height * TILE_SIZE * 0.7;

  return (
    <group>
      {/* Main structure */}
      <mesh position={[0, h / 2, 0]} castShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      {/* Roof */}
      <mesh position={[0, h + 4, 0]}>
        <coneGeometry args={[w * 0.7, 8, 4]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      {/* Glow accent at base */}
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[w + 4, 1, d + 4]} />
        <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.3} transparent opacity={0.4} />
      </mesh>
    </group>
  );
}


function BuildingModel({ zone }: { zone: BuildingZone }) {
  const [cx, , cz] = zoneCenter(zone);
  const theme = BUILDING_OPENCLAW_THEMES[zone.id];
  const label = theme?.label ?? zone.id;
  const category = theme?.category;
  const model = BUILDING_MODELS[zone.id];

  return (
    <group position={[cx, 0, cz]}>
      {/* Procedural buildings — lightweight, no GLB loading */}
      <ProceduralBuilding zone={zone} />

      {/* Glowing base ring */}
      <mesh position={[0, 0.1, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[zone.width * TILE_SIZE * 0.35, zone.width * TILE_SIZE * 0.38, 32]} />
        <meshBasicMaterial color={0x00e5ff} transparent opacity={0.15} />
      </mesh>

      {/* Label */}
      <FloatingLabel text={label} subtitle={category} y={35} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ArenaBuildings() {
  return (
    <group>
      {buildingZones.map((zone) => (
        <BuildingModel key={zone.id} zone={zone} />
      ))}
    </group>
  );
}
