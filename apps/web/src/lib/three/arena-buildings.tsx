'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GPU-OPTIMIZED buildings using mergeGeometries
// Each building = 1 merged mesh (body + details baked in) + 1 accent mesh
// Total: ~20 draw calls for 10 buildings (was 222 in original)
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

function zoneCenter(zone: BuildingZone): [number, number, number] {
  const cx = OFFSET_X + (zone.x + zone.width / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  return [cx, 0, cz];
}

/** Helper: create geometry positioned at (x,y,z) */
function posGeo(geo: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = geo.clone();
  g.translate(x, y, z);
  return g;
}

/** Helper: create geometry positioned and scaled */
function transGeo(geo: THREE.BufferGeometry, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const g = geo.clone();
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

// ---------------------------------------------------------------------------
// Building geometry builders — each returns merged BufferGeometry
// All detail is baked into 1 geometry = 1 draw call
// ---------------------------------------------------------------------------

function buildCronHub(w: number, d: number): THREE.BufferGeometry {
  // Tide Clock Grotto: conch tower with clock face
  const parts: THREE.BufferGeometry[] = [];
  // Base
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.5, 24, w * 0.5), 0, 12, 0));
  // Tower
  parts.push(transGeo(new THREE.CylinderGeometry(w * 0.18, w * 0.22, 28, 8), 0, 38, 0));
  // Spiral top
  parts.push(transGeo(new THREE.ConeGeometry(w * 0.22, 16, 8), 0, 58, 0));
  // Pearl finial
  parts.push(transGeo(new THREE.SphereGeometry(2.5, 8, 8), 0, 67, 0));
  // Clock face
  parts.push(transGeo(new THREE.CircleGeometry(8, 16), 0, 42, -w * 0.2));
  // Entrance
  parts.push(transGeo(new THREE.BoxGeometry(8, 14, 1.5), 0, 7, -w * 0.24));
  return mergeGeometries(parts, false)!;
}

function buildWebhookGateway(w: number, d: number): THREE.BufferGeometry {
  // Current Gateway: coral arch with pillars
  const parts: THREE.BufferGeometry[] = [];
  // Left pillar
  parts.push(transGeo(new THREE.CylinderGeometry(4, 6, 44, 8), -w * 0.22, 22, 0));
  // Right pillar
  parts.push(transGeo(new THREE.CylinderGeometry(4, 6, 44, 8), w * 0.22, 22, 0));
  // Arch top
  parts.push(transGeo(new THREE.TorusGeometry(w * 0.22, 5, 6, 12, Math.PI), 0, 46, 0));
  // Keystone pearl
  parts.push(transGeo(new THREE.SphereGeometry(5, 8, 8), 0, 52, 0));
  // Base platform
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.7, 2, d * 0.5), 0, 1, 0));
  return mergeGeometries(parts, false)!;
}

function buildMemoryVault(w: number, d: number): THREE.BufferGeometry {
  // Abyssal Vault: nautilus dome on rock base
  const parts: THREE.BufferGeometry[] = [];
  // Rock base
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.7, 28, d * 0.65), 0, 14, 0));
  // Nautilus dome
  parts.push(transGeo(new THREE.SphereGeometry(w * 0.38, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 30, 0));
  // Hatch door
  parts.push(transGeo(new THREE.BoxGeometry(14, 20, 2), 0, 12, -d * 0.34));
  // Wheel lock
  parts.push(transGeo(new THREE.TorusGeometry(4, 0.8, 6, 12), 0, 14, -d * 0.36));
  // Columns
  parts.push(transGeo(new THREE.CylinderGeometry(3, 3.5, 28, 6), -w * 0.3, 14, -d * 0.34));
  parts.push(transGeo(new THREE.CylinderGeometry(3, 3.5, 28, 6), w * 0.3, 14, -d * 0.34));
  return mergeGeometries(parts, false)!;
}

function buildSkillForge(w: number, d: number): THREE.BufferGeometry {
  // Hydrothermal Forge: volcanic vent with chimney
  const parts: THREE.BufferGeometry[] = [];
  // Main structure
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.6, 32, d * 0.55), 0, 16, 0));
  // Chimney
  parts.push(transGeo(new THREE.CylinderGeometry(3, 5, 16, 6), w * 0.12, 40, d * 0.1));
  // Pitched roof
  parts.push(transGeo(new THREE.ConeGeometry(w * 0.35, 14, 6), 0, 39, 0));
  // Vent opening
  parts.push(transGeo(new THREE.BoxGeometry(16, 12, 2), 0, 14, -d * 0.28));
  // Anvil base
  parts.push(transGeo(new THREE.CylinderGeometry(3, 4, 8, 6), -w * 0.25, 4, -d * 0.35));
  // Anvil top
  parts.push(transGeo(new THREE.BoxGeometry(10, 2, 5), -w * 0.25, 9, -d * 0.35));
  return mergeGeometries(parts, false)!;
}

function buildChannelBridge(w: number, d: number): THREE.BufferGeometry {
  // Coral Bridge: bridge deck with towers
  const parts: THREE.BufferGeometry[] = [];
  // Bridge deck
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.8, 3, d * 0.35), 0, 8, 0));
  // Left tower
  parts.push(transGeo(new THREE.CylinderGeometry(4, 5, 48, 8), -w * 0.35, 28, 0));
  // Right tower
  parts.push(transGeo(new THREE.CylinderGeometry(4, 5, 48, 8), w * 0.35, 28, 0));
  // Tower caps
  parts.push(transGeo(new THREE.SphereGeometry(6, 8, 6), -w * 0.35, 54, 0));
  parts.push(transGeo(new THREE.SphereGeometry(6, 8, 6), w * 0.35, 54, 0));
  // Railings
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.78, 1, 0.8), 0, 11, -d * 0.17));
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.78, 1, 0.8), 0, 11, d * 0.17));
  return mergeGeometries(parts, false)!;
}

function buildToolWorkshop(w: number, d: number): THREE.BufferGeometry {
  // Salvage Workshop: shipwreck shed with tools
  const parts: THREE.BufferGeometry[] = [];
  const wallH = 36;
  // Shed body
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.7, wallH * 0.9, d * 0.65), 0, wallH * 0.45, 0));
  // Pitched roof
  parts.push(transGeo(new THREE.ConeGeometry(w * 0.4, 16, 6), 0, wallH + 5, 0));
  // Front panel
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.72, wallH * 0.92, 1), 0, wallH * 0.45, -d * 0.33));
  // Door
  parts.push(transGeo(new THREE.BoxGeometry(10, 16, 1.5), 0, 8, -d * 0.34));
  // Workbench
  parts.push(transGeo(new THREE.BoxGeometry(14, 10, 6), -w * 0.28, 5, -d * 0.38));
  // Porthole
  parts.push(transGeo(new THREE.CircleGeometry(4, 10), -w * 0.18, wallH * 0.5, -d * 0.34));
  return mergeGeometries(parts, false)!;
}

function buildCanvasStudio(w: number, d: number): THREE.BufferGeometry {
  // Biolume Studio: art cave with ink splatters
  const parts: THREE.BufferGeometry[] = [];
  const wallH = 38;
  // Cave body
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.8, wallH * 0.9, d * 0.75), 0, wallH * 0.45, 0));
  // Side grotto
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.3, wallH * 0.5, d * 0.3), w * 0.2, wallH * 0.35, d * 0.2));
  // Rocky roof
  parts.push(transGeo(new THREE.ConeGeometry(w * 0.5, 20, 6), 0, wallH + 7, 0));
  // Entrance
  parts.push(transGeo(new THREE.BoxGeometry(10, 16, 1.5), 0, 8, -d / 2 - 1));
  // Easel legs
  parts.push(transGeo(new THREE.CylinderGeometry(0.6, 0.6, 18, 4), -w * 0.38 - 2, 9, -d / 2 - 8));
  parts.push(transGeo(new THREE.CylinderGeometry(0.6, 0.6, 18, 4), -w * 0.38 + 2, 9, -d / 2 - 8));
  // Canvas
  parts.push(transGeo(new THREE.BoxGeometry(10, 8, 0.5), -w * 0.38, 13, -d / 2 - 9));
  return mergeGeometries(parts, false)!;
}

function buildVoiceTower(w: number): THREE.BufferGeometry {
  // Echo Spire: tall sonar tower
  const parts: THREE.BufferGeometry[] = [];
  // Base
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.45, 20, w * 0.45), 0, 10, 0));
  // Spire
  parts.push(transGeo(new THREE.CylinderGeometry(3, 6, 32, 8), 0, 36, 0));
  // Antenna tusk
  parts.push(transGeo(new THREE.ConeGeometry(1.2, 12, 6), 0, 56, 0));
  // Conch horn
  parts.push(transGeo(new THREE.ConeGeometry(7, 8, 8), 0, 18, -w * 0.24));
  // Coral ring braces
  parts.push(transGeo(new THREE.TorusGeometry(7, 1, 4, 10), 0, 25, 0));
  parts.push(transGeo(new THREE.TorusGeometry(7, 1, 4, 10), 0, 35, 0));
  parts.push(transGeo(new THREE.TorusGeometry(7, 1, 4, 10), 0, 45, 0));
  // Entrance
  parts.push(transGeo(new THREE.BoxGeometry(7, 12, 1.5), 0, 6, -w * 0.23));
  return mergeGeometries(parts, false)!;
}

function buildSecurityFortress(w: number, d: number): THREE.BufferGeometry {
  // Shell Fortress: armored keep with corner towers
  const parts: THREE.BufferGeometry[] = [];
  // Main keep
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.55, 40, d * 0.5), 0, 20, 0));
  // Corner towers (4)
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    parts.push(transGeo(new THREE.CylinderGeometry(6, 7, 48, 6), sx * w * 0.3, 24, sz * d * 0.28));
    // Barnacle caps
    parts.push(transGeo(new THREE.SphereGeometry(7, 6, 4, 0, Math.PI * 2, 0, Math.PI * 0.5), sx * w * 0.3, 49, sz * d * 0.28));
  }
  // Gate
  parts.push(transGeo(new THREE.BoxGeometry(14, 20, 3), 0, 10, -d * 0.26));
  // Walls
  parts.push(transGeo(new THREE.BoxGeometry(3, 28, d * 0.5), -w * 0.3, 14, 0));
  parts.push(transGeo(new THREE.BoxGeometry(3, 28, d * 0.5), w * 0.3, 14, 0));
  return mergeGeometries(parts, false)!;
}

function buildConfigCitadel(w: number, d: number): THREE.BufferGeometry {
  // Nautilus Citadel: spiral command center
  const parts: THREE.BufferGeometry[] = [];
  // Sandy base
  parts.push(transGeo(new THREE.BoxGeometry(w * 0.75, 6, d * 0.7), 0, 3, 0));
  // Nautilus shell body
  parts.push(transGeo(new THREE.CylinderGeometry(w * 0.22, w * 0.28, 36, 10), 0, 24, 0));
  // Command chamber
  parts.push(transGeo(new THREE.CylinderGeometry(w * 0.18, w * 0.22, 10, 10), 0, 46, 0));
  // Pearl dome
  parts.push(transGeo(new THREE.SphereGeometry(w * 0.2, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 53, 0));
  // Spiral spire
  parts.push(transGeo(new THREE.ConeGeometry(2, 10, 6), 0, 62, 0));
  // Coral buttresses
  parts.push(transGeo(new THREE.CylinderGeometry(2, 3, 24, 6), -w * 0.3, 15, 0));
  parts.push(transGeo(new THREE.CylinderGeometry(2, 3, 24, 6), w * 0.3, 15, 0));
  // Entry
  parts.push(transGeo(new THREE.BoxGeometry(10, 14, 1.5), 0, 8, -w * 0.26));
  return mergeGeometries(parts, false)!;
}

// ---------------------------------------------------------------------------
// Building style config
// ---------------------------------------------------------------------------
interface BuildingStyle {
  bodyColor: number;
  accentColor: number;
  emissive: number;
  buildGeo: (w: number, d: number) => THREE.BufferGeometry;
}

const BUILDING_CONFIGS: Record<string, BuildingStyle> = {
  'cron-hub':          { bodyColor: 0x2dd4b4, accentColor: 0xffa07a, emissive: 0x00e5ff, buildGeo: buildCronHub },
  'webhook-gateway':   { bodyColor: 0xff8a65, accentColor: 0xfff3e0, emissive: 0xff9800, buildGeo: buildWebhookGateway },
  'memory-vault':      { bodyColor: 0x5b9aaa, accentColor: 0x00e5ff, emissive: 0x7c4dff, buildGeo: buildMemoryVault },
  'skill-forge':       { bodyColor: 0x6a4040, accentColor: 0xff5722, emissive: 0xff5722, buildGeo: buildSkillForge },
  'channel-bridge':    { bodyColor: 0xff7043, accentColor: 0xff5722, emissive: 0xff7043, buildGeo: buildChannelBridge },
  'tool-workshop':     { bodyColor: 0x7d5a47, accentColor: 0x00bcd4, emissive: 0x00bcd4, buildGeo: buildToolWorkshop },
  'canvas-studio':     { bodyColor: 0x3a2d5a, accentColor: 0x69f0ae, emissive: 0x69f0ae, buildGeo: buildCanvasStudio },
  'voice-tower':       { bodyColor: 0x2d6a5a, accentColor: 0x00e5ff, emissive: 0x00e5ff, buildGeo: (w) => buildVoiceTower(w) },
  'security-fortress': { bodyColor: 0x5080aa, accentColor: 0x42a5f5, emissive: 0x42a5f5, buildGeo: buildSecurityFortress },
  'config-citadel':    { bodyColor: 0xffab91, accentColor: 0xffab40, emissive: 0xffab40, buildGeo: buildConfigCitadel },
};

// ---------------------------------------------------------------------------
// Single merged building component — 1 draw call for body, 1 for accent glow
// ---------------------------------------------------------------------------
function MergedBuilding({ zone }: { zone: BuildingZone }) {
  const config = BUILDING_CONFIGS[zone.id];
  if (!config) return null;

  const [cx, , cz] = zoneCenter(zone);
  const w = zone.width * TILE_SIZE;
  const d = zone.height * TILE_SIZE;

  const mergedGeo = useMemo(() => config.buildGeo(w, d), [w, d, config]);

  return (
    <group position={[cx, 0, cz]}>
      {/* Main building — 1 merged mesh = 1 draw call */}
      <mesh geometry={mergedGeo} castShadow>
        <meshStandardMaterial
          color={config.bodyColor}
          roughness={0.7}
          emissive={config.emissive}
          emissiveIntensity={0.15}
        />
      </mesh>
      {/* Accent glow sphere — cheap visibility beacon, 1 draw call */}
      <mesh position={[0, 8, 0]}>
        <sphereGeometry args={[3, 6, 6]} />
        <meshBasicMaterial color={config.accentColor} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main export — 20 draw calls total (10 buildings × 2 meshes each)
// Original was 222 draw calls
// ---------------------------------------------------------------------------
export default function ArenaBuildings() {
  return (
    <group>
      {buildingZones.map((zone) => (
        <MergedBuilding key={zone.id} zone={zone} />
      ))}
    </group>
  );
}
