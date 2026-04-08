'use client';

import { useRef, useMemo, memo, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
} from '@/lib/pixi/tilemap-data';
import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';

// ---------------------------------------------------------------------------
// Location NPCs — one themed lobster stationed at each building entrance
// Uses the lobster GLB with strong color tinting per building theme
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;
const NPC_SCALE = 6;

// Raycaster for terrain Y
const _locRaycaster = new THREE.Raycaster();
_locRaycaster.layers.set(TERRAIN_LAYER);
const _locRayOrigin = new THREE.Vector3();
const _locRayDir = new THREE.Vector3(0, -1, 0);

useGLTF.preload('/models/lobster.glb');

// Each building gets a themed NPC with distinct color + name
const LOCATION_NPCS: Record<string, { name: string; color: number; offsetX: number; offsetZ: number }> = {
  'cron-hub':          { name: 'Chronos',    color: 0xffd700, offsetX: 2, offsetZ: 2 },   // gold — time keeper
  'webhook-gateway':   { name: 'Flipper',    color: 0xff6b35, offsetX: 2, offsetZ: 2 },   // orange — fry cook
  'memory-vault':      { name: 'Archivius',  color: 0x6a5acd, offsetX: 2, offsetZ: 2 },   // slate blue — scholar
  'skill-forge':       { name: 'Cinder',     color: 0x22dd22, offsetX: 2, offsetZ: 2 },   // green — mad scientist
  'channel-bridge':    { name: 'Barnacle',   color: 0x8b4513, offsetX: 2, offsetZ: 2 },   // brown — pirate
  'tool-workshop':     { name: 'Wrench',     color: 0xaaaaaa, offsetX: 2, offsetZ: 2 },   // silver — mechanic
  'canvas-studio':     { name: 'Palette',    color: 0xff69b4, offsetX: 2, offsetZ: 2 },   // hot pink — artist
  'voice-tower':       { name: 'Echo',       color: 0x00bfff, offsetX: 2, offsetZ: 2 },   // sky blue — bard
  'security-fortress': { name: 'Shield',     color: 0xcc2222, offsetX: 2, offsetZ: 2 },   // dark red — guard
  'config-citadel':    { name: 'Sage',       color: 0x9932cc, offsetX: 2, offsetZ: 2 },   // purple — wizard
};

function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  _locRayOrigin.set(x, 200, z);
  _locRaycaster.set(_locRayOrigin, _locRayDir);
  _locRaycaster.layers.set(TERRAIN_LAYER);
  _locRaycaster.far = 400;
  const hits = _locRaycaster.intersectObjects(scene.children, true);
  return hits.length > 0 ? hits[0].point.y : -15;
}

const LocationNpc = memo(function LocationNpc({
  zoneId,
  worldX,
  worldZ,
}: {
  zoneId: string;
  worldX: number;
  worldZ: number;
}) {
  const config = LOCATION_NPCS[zoneId];
  if (!config) return null;

  const groupRef = useRef<THREE.Group>(null);
  const { scene: threeScene } = useThree();
  const { scene } = useGLTF('/models/lobster.glb');
  const terrainY = useRef(-15);
  const placed = useRef(false);

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    const color = new THREE.Color(config.color);
    c.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          mat.color.lerp(color, 0.8);
          mat.emissive = color.clone();
          mat.emissiveIntensity = 0.3;
          mesh.material = mat;
        }
      }
    });
    return c;
  }, [scene, config.color]);

  // Place on terrain + idle bob animation
  useFrame(({ clock }) => {
    if (!groupRef.current) return;

    if (!placed.current) {
      const y = getTerrainY(worldX, worldZ, threeScene);
      if (y > -100) {
        terrainY.current = y;
        placed.current = true;
      }
    }

    const bob = Math.sin(clock.elapsedTime * 1.5) * 0.5;
    groupRef.current.position.set(worldX, terrainY.current + 2 + bob, worldZ);
    // Face toward building center (rotate 180 to face outward)
    groupRef.current.rotation.y = Math.PI;
  });

  return (
    <group ref={groupRef} scale={[NPC_SCALE, NPC_SCALE, NPC_SCALE]}>
      <primitive object={cloned} />
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export — renders one NPC per building zone
// ---------------------------------------------------------------------------
export default function ArenaLocationNpcs() {
  const npcs = useMemo(() => {
    return buildingZones.map((zone) => {
      const config = LOCATION_NPCS[zone.id];
      if (!config) return null;
      // Position NPC slightly in front of building (offset by tiles)
      const cx = OFFSET_X + (zone.x + zone.width / 2 + config.offsetX) * TILE_SIZE;
      const cz = OFFSET_Z + (zone.y + zone.height + config.offsetZ) * TILE_SIZE;
      return { zoneId: zone.id, worldX: cx, worldZ: cz };
    }).filter(Boolean) as { zoneId: string; worldX: number; worldZ: number }[];
  }, []);

  return (
    <Suspense fallback={null}>
      <group>
        {npcs.map((npc) => (
          <LocationNpc key={npc.zoneId} {...npc} />
        ))}
      </group>
    </Suspense>
  );
}
