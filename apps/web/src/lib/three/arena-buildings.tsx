'use client';

import { useMemo, Suspense } from 'react';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  buildingZones,
  type BuildingZone,
} from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GLB model buildings — each model = 1-2 draw calls (pre-baked geometry)
// Way more detailed than primitives, LESS GPU cost
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

function zoneCenter(zone: BuildingZone): [number, number, number] {
  const cx = OFFSET_X + (zone.x + zone.width / 2) * TILE_SIZE;
  const cz = OFFSET_Z + (zone.y + zone.height / 2) * TILE_SIZE;
  return [cx, 0, cz];
}

// Map each building ID to a GLB model + display config
const BUILDING_MODELS: Record<string, { model: string; scale: number; yOffset: number; rotY?: number }> = {
  'cron-hub':          { model: '/models/building-lighthouse.glb', scale: 14, yOffset: 0 },
  'webhook-gateway':   { model: '/models/building-anchor.glb', scale: 45, yOffset: 12 },
  'memory-vault':      { model: '/models/building-chest.glb', scale: 30, yOffset: 8 },
  'skill-forge':       { model: '/models/building-barrel.glb', scale: 40, yOffset: 8 },
  'channel-bridge':    { model: '/models/building-shipwreck.glb', scale: 22, yOffset: 5 },
  'tool-workshop':     { model: '/models/building-submarine.glb', scale: 20, yOffset: 10, rotY: -0.3 },
  'canvas-studio':     { model: '/models/building-cave.glb', scale: 22, yOffset: 3 },
  'voice-tower':       { model: '/models/building-tower2.glb', scale: 25, yOffset: 0 },
  'security-fortress': { model: '/models/building-shell.glb', scale: 30, yOffset: 8 },
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

  // Clone the scene so each building gets its own instance
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    return c;
  }, [scene]);

  return (
    <group position={[cx, config.yOffset, cz]} rotation={[0, config.rotY ?? 0, 0]}>
      <primitive object={cloned} scale={config.scale} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main export — ~10-20 draw calls for all 10 buildings (GLB models are efficient)
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
