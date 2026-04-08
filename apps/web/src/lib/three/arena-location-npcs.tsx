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
// Location NPCs — SpongeBob characters stationed at their canonical buildings
// Each character is an AI agent that teaches skills from their building's
// knowledge base. They ARE the agents — not decoration.
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

// Raycaster for terrain Y
const _locRaycaster = new THREE.Raycaster();
_locRaycaster.layers.set(TERRAIN_LAYER);
const _locRayOrigin = new THREE.Vector3();
const _locRayDir = new THREE.Vector3(0, -1, 0);

// Character → Building mapping (SpongeBob themed)
const LOCATION_NPCS: Record<string, {
  name: string;
  model: string;
  scale: number;
  yOffset: number;
  offsetX: number;
  offsetZ: number;
  rotY?: number;
}> = {
  'canvas-studio':     { name: 'SpongeBob',  model: '/models/characters/spongebob.glb', scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'security-fortress': { name: 'Patrick',     model: '/models/characters/patrick.glb',   scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'memory-vault':      { name: 'Squidward',   model: '/models/characters/squidward.glb', scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'webhook-gateway':   { name: 'Mr. Krabs',   model: '/models/characters/mr-krabs.glb',  scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'skill-forge':       { name: 'Plankton',    model: '/models/characters/plankton.glb',  scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'cron-hub':          { name: 'Gary',         model: '/models/characters/gary.glb',      scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'channel-bridge':    { name: 'Sandy',        model: '/models/characters/sandy.glb',     scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'tool-workshop':     { name: 'Karen',        model: '/models/characters/karen.glb',     scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'voice-tower':       { name: 'Mrs. Puff',    model: '/models/characters/mrs-puff.glb',  scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
  'config-citadel':    { name: 'Larry',        model: '/models/characters/sandy.glb',     scale: 0.5, yOffset: 0,  offsetX: 2, offsetZ: 2 },
};

// Preload all character models
const preloaded = new Set<string>();
Object.values(LOCATION_NPCS).forEach(({ model }) => {
  if (!preloaded.has(model)) {
    useGLTF.preload(model);
    preloaded.add(model);
  }
});

function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  _locRayOrigin.set(x, 200, z);
  _locRaycaster.set(_locRayOrigin, _locRayDir);
  _locRaycaster.layers.set(TERRAIN_LAYER);
  _locRaycaster.far = 400;
  const hits = _locRaycaster.intersectObjects(scene.children, true);
  return hits.length > 0 ? hits[0].point.y : -2;
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
  const { scene } = useGLTF(config.model);
  const terrainY = useRef(-15);
  const placed = useRef(false);

  const cloned = useMemo(() => scene.clone(true), [scene]);

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
    groupRef.current.position.set(worldX, terrainY.current + config.yOffset + 2 + bob, worldZ);
    groupRef.current.rotation.y = config.rotY ?? Math.PI;
  });

  return (
    <group ref={groupRef} scale={[config.scale, config.scale, config.scale]}>
      <primitive object={cloned} />
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export — renders one character NPC per building zone
// ---------------------------------------------------------------------------
export default function ArenaLocationNpcs() {
  const npcs = useMemo(() => {
    return buildingZones.map((zone) => {
      const config = LOCATION_NPCS[zone.id];
      if (!config) return null;
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
