'use client';

import { useRef, useMemo, memo, Suspense, useEffect, type ReactElement } from 'react';
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
import { applyStationaryIdleAnimation, idToSeed } from '@/lib/three/procedural-animation';

// ---------------------------------------------------------------------------
// Location NPCs — SpongeBob characters at their canonical buildings
// Auto-normalized: each GLB is measured and scaled to a target height
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

// Target height in world units for all character NPCs — visible next to 100-unit buildings
const CHARACTER_HEIGHT = 30;

const _locRaycaster = new THREE.Raycaster();
_locRaycaster.layers.set(TERRAIN_LAYER);
const _locRayOrigin = new THREE.Vector3();
const _locRayDir = new THREE.Vector3(0, -1, 0);

const LOCATION_NPCS: Record<string, {
  name: string;
  model: string;
  offsetX: number;
  offsetZ: number;
}> = {
  'canvas-studio':     { name: 'SpongeBob',  model: '/models/characters/spongebob.glb', offsetX: 0, offsetZ: 1 },
  'security-fortress': { name: 'Patrick',     model: '/models/characters/patrick.glb',   offsetX: 0, offsetZ: 1 },
  'memory-vault':      { name: 'Squidward',   model: '/models/characters/squidward.glb', offsetX: 0, offsetZ: 1 },
  'webhook-gateway':   { name: 'Mr. Krabs',   model: '/models/characters/mr-krabs.glb',  offsetX: 0, offsetZ: 1 },
  'skill-forge':       { name: 'Plankton',    model: '/models/characters/plankton.glb',  offsetX: 0, offsetZ: 1 },
  'cron-hub':          { name: 'Gary',         model: '/models/characters/gary.glb',      offsetX: 0, offsetZ: 1 },
  'channel-bridge':    { name: 'Sandy',        model: '/models/characters/sandy.glb',     offsetX: 0, offsetZ: 1 },
  'tool-workshop':     { name: 'Karen',        model: '/models/characters/karen.glb',     offsetX: 0, offsetZ: 1 },
  'voice-tower':       { name: 'Mrs. Puff',    model: '/models/characters/mrs-puff.glb',  offsetX: 0, offsetZ: 1 },
  'config-citadel':    { name: 'Larry',        model: '/models/lobster.glb',              offsetX: 0, offsetZ: 1 },
};

// Character model preloads are deferred — see DeferredNpcPreloads exported below.
// useGLTF() inside LocationNpc will Suspense-throw if the cache isn't warm yet;
// the ArenaLocationNpcs Suspense fallback={null} wrapper absorbs that safely.

/** Measure bounding box and return scale for target height.
 *  Characters use max dimension (no ground planes to worry about). */
function computeNormalizedScale(scene: THREE.Object3D, targetHeight: number): number {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim === 0) return 1;
  return targetHeight / maxDim;
}

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
  const animGroupRef = useRef<THREE.Group>(null);
  const { scene: threeScene } = useThree();
  const { scene } = useGLTF(config.model);
  const terrainY = useRef(-2);
  const placed = useRef(false);
  const seed = useMemo(() => idToSeed(zoneId), [zoneId]);

  // Clone and compute normalized scale
  const { cloned, npcScale } = useMemo(() => {
    const c = scene.clone(true);
    const s = computeNormalizedScale(c, CHARACTER_HEIGHT);
    return { cloned: c, npcScale: s };
  }, [scene]);

  useFrame(({ clock }) => {
    if (!groupRef.current) return;

    // Re-raycast terrain Y periodically (not just once) to handle late terrain loading
    // and dune geometry. Check every ~20 frames.
    const frame = Math.floor(clock.elapsedTime * 60);
    if (!placed.current || frame % 20 === 0) {
      const y = getTerrainY(worldX, worldZ, threeScene);
      if (y > -100) {
        terrainY.current = y;
        placed.current = true;
      }
    }

    // Position well above terrain to prevent sinking into dunes
    const bob = Math.sin(clock.elapsedTime * 1.5 + seed) * 0.5;
    groupRef.current.position.set(worldX, terrainY.current + 6 + bob, worldZ);

    // Procedural idle animation on inner group
    if (animGroupRef.current) {
      applyStationaryIdleAnimation({
        group: animGroupRef.current,
        isMoving: false,
        elapsed: clock.elapsedTime,
        delta: 0.016,
        direction: 'idle',
        seed,
      });
    }
  });

  return (
    <group ref={groupRef} scale={[npcScale, npcScale, npcScale]} rotation={[0, Math.PI, 0]}>
      <group ref={animGroupRef}>
        <primitive object={cloned} />
      </group>
    </group>
  );
});

// ---------------------------------------------------------------------------
// DeferredNpcPreloads
// Render OUTSIDE the Canvas — fires after first paint via requestAnimationFrame.
// All 9 SpongeBob character GLBs + the lobster NPC are loaded here, not at
// module-evaluation time, so they don't compete with buildings + player on the
// initial frame. ArenaLocationNpcs is wrapped in Suspense fallback={null} so
// NPCs render nothing until each model resolves.
// ---------------------------------------------------------------------------
export function DeferredNpcPreloads(): ReactElement | null {
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const seen = new Set<string>();
      Object.values(LOCATION_NPCS).forEach(({ model }) => {
        if (!seen.has(model)) {
          useGLTF.preload(model);
          seen.add(model);
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  return null;
}

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
