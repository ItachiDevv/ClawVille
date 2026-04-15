'use client';

import { useRef, useMemo, memo, Suspense, useEffect, type ReactElement } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Html } from '@react-three/drei';
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

// Target height in world units for all character NPCs — visible next to 160-unit buildings
const CHARACTER_HEIGHT = 20;

const _locRaycaster = new THREE.Raycaster();
_locRaycaster.layers.set(TERRAIN_LAYER);
const _locRayOrigin = new THREE.Vector3();
const _locRayDir = new THREE.Vector3(0, -1, 0);

const LOCATION_NPCS: Record<string, {
  name: string;
  model: string;
}> = {
  'canvas-studio':     { name: 'SpongeBob',  model: '/models/characters/spongebob.glb' },
  'security-fortress': { name: 'Patrick',     model: '/models/characters/patrick.glb'   },
  'memory-vault':      { name: 'Squidward',   model: '/models/characters/squidward.glb' },
  'webhook-gateway':   { name: 'Mr. Krabs',   model: '/models/characters/mr-krabs.glb'  },
  'skill-forge':       { name: 'Plankton',    model: '/models/characters/plankton.glb'  },
  'cron-hub':          { name: 'Gary',         model: '/models/characters/gary.glb'      },
  'channel-bridge':    { name: 'Sandy',        model: '/models/characters/sandy.glb'     },
  'tool-workshop':     { name: 'Karen',        model: '/models/characters/karen.glb'     },
  'voice-tower':       { name: 'Mrs. Puff',    model: '/models/characters/mrs-puff.glb'  },
  'config-citadel':    { name: 'Larry',        model: '/models/lobster.glb'              },
};

// Village center in tile space — NPCs stand between their building and this point.
// The 160×160 tile grid has its center at tile (80, 80).
// worldX = -2560 + 80*32 = 0, worldZ = -2560 + 80*32 = 0 — symmetric square map.
const VILLAGE_CENTER_TILE_X = 80;
const VILLAGE_CENTER_TILE_Z = 80; // tile Y maps to world Z

/** Compute NPC world position and facing angle for a given building zone.
 *
 *  Position: building_center_tile + normalize(toward_village_center) * NPC_INSET_TILES (4.0),
 *            converted to world space.
 *  Facing: SpongeBob character GLBs face +Z at rotation.y=0.
 *          atan2(dx, dz) rotates the +Z-forward model to face toward village center.
 *          No +PI flip needed (unlike lobster.glb which faces -Z). */
function computeNpcPlacement(zone: { x: number; y: number; width: number; height: number }): {
  worldX: number;
  worldZ: number;
  facingRotY: number;
} {
  // Building center in tile space
  const bcx = zone.x + zone.width  / 2;
  const bcz = zone.y + zone.height / 2; // tile Y = world Z axis

  // Direction from building center toward village center (tile space)
  const dx = VILLAGE_CENTER_TILE_X - bcx;
  const dz = VILLAGE_CENTER_TILE_Z - bcz;
  const len = Math.sqrt(dx * dx + dz * dz);

  // NPC stands 4 tiles inside from the building center, toward the village center
  const NPC_INSET_TILES = 4.0;
  let npcTileX = bcx;
  let npcTileZ = bcz;
  if (len > 0.001) {
    npcTileX = bcx + (dx / len) * NPC_INSET_TILES;
    npcTileZ = bcz + (dz / len) * NPC_INSET_TILES;
  }

  const worldX = OFFSET_X + npcTileX * TILE_SIZE;
  const worldZ = OFFSET_Z + npcTileZ * TILE_SIZE;

  // Facing toward village center from NPC position.
  // The model faces +Z by default. atan2(dirX, dirZ) rotates the
  // +Z-forward model to face along (dirX, dirZ) toward center.
  const facingRotY = Math.atan2(dx, dz);

  return { worldX, worldZ, facingRotY };
}

// Character model preloads are deferred — see DeferredNpcPreloads exported below.
// useGLTF() inside LocationNpc will Suspense-throw if the cache isn't warm yet;
// the ArenaLocationNpcs Suspense fallback={null} wrapper absorbs that safely.

/** Measure bounding box and return scale so the model's Y-height matches targetHeight.
 *  Uses size.y (height) not maxDim so wide/deep models aren't shrunk below target. */
function computeNormalizedScale(scene: THREE.Object3D, targetHeight: number): number {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  // Use Y dimension (height) for normalization; fall back to max if Y is degenerate
  const h = size.y > 0.001 ? size.y : Math.max(size.x, size.y, size.z);
  if (h === 0) return 1;
  return targetHeight / h;
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
  facingRotY,
}: {
  zoneId: string;
  worldX: number;
  worldZ: number;
  facingRotY: number;
}) {
  const config = LOCATION_NPCS[zoneId];
  if (!config) return null;

  const groupRef = useRef<THREE.Group>(null);
  const animGroupRef = useRef<THREE.Group>(null);
  const { scene: threeScene } = useThree();
  const { scene } = useGLTF(config.model);
  const terrainY = useRef(-2);
  const placed = useRef(false);
  // idToSeed returns a float (0..10). Convert to integer so (frame + seed) % N
  // uses integer arithmetic — float modulo with strict === 0 never fires.
  const seed = useMemo(() => Math.round(idToSeed(zoneId)), [zoneId]);

  // Clone and compute normalized scale
  const { cloned, npcScale } = useMemo(() => {
    const c = scene.clone(true);
    const s = computeNormalizedScale(c, CHARACTER_HEIGHT);
    return { cloned: c, npcScale: s };
  }, [scene]);

  // Dispose cloned geometry + materials on unmount (navigation away / hot-reload)
  useEffect(() => {
    return () => {
      cloned.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
          else mesh.material?.dispose();
        }
      });
    };
  }, [cloned]);

  useFrame(({ clock }, delta) => {
    if (!groupRef.current) return;

    // Re-raycast terrain Y periodically (not just once) to handle late terrain loading
    // and dune geometry. Check every ~20 frames.
    // Use (frame + seed) % 20 to stagger raycasts across the 10 NPCs — without
    // the seed all 10 NPCs hit the same frame tick, spiking CPU every ~333ms.
    const frame = Math.floor(clock.elapsedTime * 60);
    if (!placed.current || (frame + seed) % 20 === 0) {
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
        delta: Math.min(delta, 0.1),
        direction: 'idle',
        seed,
      });
    }
  });

  return (
    <group ref={groupRef}>
      {/* Scaled + rotated model sub-group */}
      <group scale={[npcScale, npcScale, npcScale]} rotation={[0, facingRotY, 0]}>
        <group ref={animGroupRef}>
          <primitive object={cloned} />
        </group>
      </group>
      {/* Name label — OUTSIDE scaled group so position is in world units.
          CHARACTER_HEIGHT (20) = model world height; +5 = clearance above head. */}
      <Html
        position={[0, CHARACTER_HEIGHT + 5, 0]}
        center
        distanceFactor={400}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        <div
          style={{
            background: 'rgba(8, 20, 38, 0.78)',
            border: '1px solid rgba(100, 200, 255, 0.25)',
            borderRadius: 6,
            padding: '2px 8px',
            color: '#fff',
            fontWeight: 700,
            fontSize: 11,
            whiteSpace: 'nowrap',
            userSelect: 'none',
            letterSpacing: '0.03em',
          }}
        >
          {config.name}
        </div>
      </Html>
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
      const { worldX, worldZ, facingRotY } = computeNpcPlacement(zone);
      return { zoneId: zone.id, worldX, worldZ, facingRotY };
    }).filter(Boolean) as { zoneId: string; worldX: number; worldZ: number; facingRotY: number }[];
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
