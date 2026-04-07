'use client';

import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
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
// Preload all building models
// ---------------------------------------------------------------------------
const BUILDING_MODELS: Record<string, string> = {
  'cron-hub': '/models/building-shell.glb',
  'webhook-gateway': '/models/building-anchor.glb',
  'memory-vault': '/models/building-cave.glb',
  'skill-forge': '/models/building-barrel.glb',
  'channel-bridge': '/models/building-lighthouse.glb',
  'tool-workshop': '/models/building-shipwreck.glb',
  'canvas-studio': '/models/building-lantern.glb',
  'voice-tower': '/models/building-tower2.glb',
  'security-fortress': '/models/building-seashell.glb',
  'config-citadel': '/models/building-submarine.glb',
};

// Preload all
Object.values(BUILDING_MODELS).forEach((path) => useGLTF.preload(path));

// Scale per model (tuned so buildings look good relative to lobsters)
const BUILDING_SCALES: Record<string, number> = {
  'cron-hub': 8,
  'webhook-gateway': 12,
  'memory-vault': 3,
  'skill-forge': 6,
  'channel-bridge': 4,
  'tool-workshop': 4,
  'canvas-studio': 10,
  'voice-tower': 5,
  'security-fortress': 2,
  'config-citadel': 4,
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
// Floating label — dark glass sign with category subtitle
// ---------------------------------------------------------------------------
function FloatingLabel({ text, subtitle, y }: { text: string; subtitle?: string; y: number }) {
  return (
    <group position={[0, y, 0]}>
      {/* Kelp stalk post */}
      <mesh position={[0, -8, 0]}>
        <cylinderGeometry args={[0.7, 1, 14, 8]} />
        <meshStandardMaterial color={0x2e7d32} roughness={0.75} />
      </mesh>
      <Billboard follow lockX={false} lockY={false} lockZ={false}>
        <group>
          {/* Dark glass sign background */}
          <mesh scale={[2.1, subtitle ? 1.5 : 1.18, 1]}>
            <circleGeometry args={[10.5, 32]} />
            <meshBasicMaterial color={0x0a1628} transparent opacity={0.9} depthTest={false} />
          </mesh>
          {/* Cyan border ring */}
          <mesh scale={[2.2, subtitle ? 1.55 : 1.22, 1]}>
            <ringGeometry args={[10.2, 10.8, 32]} />
            <meshBasicMaterial color={0x00e5ff} transparent opacity={0.4} depthTest={false} />
          </mesh>
          {/* Building name */}
          <Text
            position={[0, subtitle ? 2 : 0.05, 0.5]}
            fontSize={3.6}
            color="#00e5ff"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.2}
            outlineColor="#0a1628"
            maxWidth={30}
          >
            {text}
          </Text>
          {/* Category subtitle */}
          {subtitle && (
            <Text
              position={[0, -2.8, 0.5]}
              fontSize={2.2}
              color="#ffffff"
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.15}
              outlineColor="#0a1628"
              maxWidth={28}
            >
              {subtitle}
            </Text>
          )}
        </group>
      </Billboard>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Single building — loads GLB model
// ---------------------------------------------------------------------------
function BuildingModel({ zone }: { zone: BuildingZone }) {
  const modelPath = BUILDING_MODELS[zone.id];
  if (!modelPath) return null;

  const { scene } = useGLTF(modelPath);
  const cloned = useMemo(() => scene.clone(true), [scene]);
  const [cx, , cz] = zoneCenter(zone);
  const scale = BUILDING_SCALES[zone.id] ?? 4;
  const theme = BUILDING_OPENCLAW_THEMES[zone.id];
  const label = theme?.label ?? zone.id;
  const category = theme?.category;

  return (
    <group position={[cx, 0, cz]}>
      {/* GLB model */}
      <group scale={scale} position={[0, 0, 0]}>
        <primitive object={cloned} />
      </group>

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
// Main component — renders all buildings
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
