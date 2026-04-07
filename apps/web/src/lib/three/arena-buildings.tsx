'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GPU-SAFE buildings — 2 meshes per building max (body + roof)
// Total: ~20 draw calls for all 10 buildings
// Intel Iris Xe can handle this easily
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

// Each building: unique bright color + emissive glow
const BUILDING_STYLES: Record<string, { body: number; roof: number; emissive: number; height: number }> = {
  'cron-hub':            { body: 0x2dd4b4, roof: 0xffa07a, emissive: 0x00e5ff, height: 40 },
  'webhook-gateway':     { body: 0xff8a65, roof: 0xef6c00, emissive: 0xff9800, height: 35 },
  'memory-vault':        { body: 0x5b9aaa, roof: 0x4488aa, emissive: 0x7c4dff, height: 45 },
  'skill-forge':         { body: 0x6a4040, roof: 0x6a5050, emissive: 0xff5722, height: 38 },
  'channel-bridge':      { body: 0xff7043, roof: 0xff5722, emissive: 0xff7043, height: 30 },
  'tool-workshop':       { body: 0x7d5a47, roof: 0x5a7a8a, emissive: 0x00bcd4, height: 36 },
  'canvas-studio':       { body: 0x3a2d5a, roof: 0x4a3868, emissive: 0x69f0ae, height: 38 },
  'voice-tower':         { body: 0x2d6a5a, roof: 0x00a88a, emissive: 0x00e5ff, height: 55 },
  'security-fortress':   { body: 0x5080aa, roof: 0x6088a8, emissive: 0x42a5f5, height: 42 },
  'config-citadel':      { body: 0xffab91, roof: 0xfff3e0, emissive: 0xffab40, height: 50 },
};

// Shared geometries — created once, reused by all buildings
const sharedRoofGeo = new THREE.ConeGeometry(1, 1, 6);

function SimpleBuilding({ zone }: { zone: BuildingZone }) {
  const style = BUILDING_STYLES[zone.id] ?? { body: 0x888888, roof: 0xaaaaaa, emissive: 0x888888, height: 30 };

  const cx = OFFSET_X + (zone.x + zone.width / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  const w = zone.width * TILE_SIZE * 0.6;
  const d = zone.height * TILE_SIZE * 0.6;
  const h = style.height;

  // Use cylinder for towers (voice-tower, config-citadel), box for others
  const isTower = zone.id === 'voice-tower' || zone.id === 'config-citadel';
  const isArch = zone.id === 'webhook-gateway' || zone.id === 'channel-bridge';
  const radius = Math.min(w, d) * 0.4;

  return (
    <group position={[cx, 0, cz]}>
      {/* Main body — 1 mesh */}
      {isTower ? (
        <mesh position={[0, h / 2, 0]} castShadow>
          <cylinderGeometry args={[radius * 0.7, radius, h, 8]} />
          <meshStandardMaterial color={style.body} roughness={0.7} emissive={style.emissive} emissiveIntensity={0.15} />
        </mesh>
      ) : (
        <mesh position={[0, h / 2, 0]} castShadow>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color={style.body} roughness={0.7} emissive={style.emissive} emissiveIntensity={0.15} />
        </mesh>
      )}

      {/* Roof — 1 mesh */}
      {isArch ? (
        // Arch shape for gateway/bridge
        <mesh position={[0, h + 4, 0]}>
          <torusGeometry args={[w * 0.4, 3, 6, 12, Math.PI]} />
          <meshStandardMaterial color={style.roof} roughness={0.5} emissive={style.emissive} emissiveIntensity={0.2} />
        </mesh>
      ) : isTower ? (
        <mesh position={[0, h + 5, 0]}>
          <sphereGeometry args={[radius * 0.8, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
          <meshStandardMaterial color={style.roof} roughness={0.4} emissive={style.emissive} emissiveIntensity={0.25} />
        </mesh>
      ) : (
        <mesh position={[0, h, 0]} scale={[w * 0.55, h * 0.3, d * 0.55]}>
          <coneGeometry args={[1, 1, 6]} />
          <meshStandardMaterial color={style.roof} roughness={0.6} emissive={style.emissive} emissiveIntensity={0.2} />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main export — ~20 meshes total (2 per building × 10 buildings)
// ---------------------------------------------------------------------------
export default function ArenaBuildings() {
  return (
    <group>
      {buildingZones.map((zone) => (
        <SimpleBuilding key={zone.id} zone={zone} />
      ))}
    </group>
  );
}
