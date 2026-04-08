'use client';

import { useMemo, useRef, Suspense } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GLB model buildings with terrain raycasting
// Each building sits on the actual terrain surface
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

function zoneCenter(zone: BuildingZone): [number, number, number] {
  const cx = OFFSET_X + (zone.x + zone.width / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  return [cx, 0, cz];
}

// Shared raycaster for buildings (one-time placement)
const _buildRaycaster = new THREE.Raycaster();
const _buildRayOrigin = new THREE.Vector3();
const _buildRayDir = new THREE.Vector3(0, -1, 0);

// Map each building ID to a GLB model + display config
const BUILDING_MODELS: Record<string, { model: string; scale: number; yOffset: number; rotY?: number }> = {
  'cron-hub':          { model: '/models/building-lighthouse.glb', scale: 14, yOffset: 2 },
  'webhook-gateway':   { model: '/models/krusty-krab.glb', scale: 18, yOffset: 2 },
  'memory-vault':      { model: '/models/squidward-house.glb', scale: 14, yOffset: 2 },
  'skill-forge':       { model: '/models/chum-bucket.glb', scale: 16, yOffset: 2 },
  'channel-bridge':    { model: '/models/building-shipwreck.glb', scale: 22, yOffset: 5 },
  'tool-workshop':     { model: '/models/building-submarine.glb', scale: 20, yOffset: 10, rotY: -0.3 },
  'canvas-studio':     { model: '/models/pineapple-house.glb', scale: 14, yOffset: 2 },
  'voice-tower':       { model: '/models/building-tower2.glb', scale: 25, yOffset: 2 },
  'security-fortress': { model: '/models/patricks-rock.glb', scale: 14, yOffset: 2 },
  'config-citadel':    { model: '/models/building-seashell.glb', scale: 20, yOffset: 8 },
};

// Preload all models
Object.values(BUILDING_MODELS).forEach(({ model }) => {
  useGLTF.preload(model);
});

function GLBBuilding({ zone }: { zone: BuildingZone }) {
  const config = BUILDING_MODELS[zone.id];
  if (!config) return null;

  const [cx, , cz] = zoneCenter(zone);
  const { scene } = useGLTF(config.model);
  const { scene: threeScene } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const placed = useRef(false);

  const cloned = useMemo(() => scene.clone(true), [scene]);

  // Raycast once after terrain loads to find surface height
  useFrame(() => {
    if (placed.current || !groupRef.current) return;

    _buildRayOrigin.set(cx, 200, cz);
    _buildRaycaster.set(_buildRayOrigin, _buildRayDir);
    _buildRaycaster.far = 400;

    const intersects = _buildRaycaster.intersectObjects(threeScene.children, true);
    for (const hit of intersects) {
      if (hit.point.y < 50) {
        groupRef.current.position.y = hit.point.y + config.yOffset;
        placed.current = true;
        return;
      }
    }
    // Fallback if no terrain hit yet (terrain still loading)
    groupRef.current.position.y = config.yOffset;
  });

  return (
    <group ref={groupRef} position={[cx, config.yOffset, cz]} rotation={[0, config.rotY ?? 0, 0]}>
      <primitive object={cloned} scale={config.scale} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default function ArenaBuildings() {
  return (
    <Suspense fallback={null}>
      <group>
        {buildingZones.map((zone) => (
          <GLBBuilding key={zone.id} zone={zone} />
        ))}
      </group>
    </Suspense>
  );
}
