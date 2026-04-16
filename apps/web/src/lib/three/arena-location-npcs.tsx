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
import { applyColorTint } from '@/lib/three/character-animations';

// ---------------------------------------------------------------------------
// Location NPCs — SpongeBob characters at their canonical buildings
// Auto-normalized: each GLB is measured and scaled to a target height
// ---------------------------------------------------------------------------

const OFFSET_X = -MAP_WIDTH / 2;
const OFFSET_Z = -MAP_HEIGHT / 2;

// Target height in world units for character NPCs.
// 140 gives a ~1:5.7 ratio against BUILDING_TARGET_HEIGHT=800 — readable at normal
// camera distance and clearly visible against the 5120-unit sand floor.
// Previous value of 32 (set in the 2026-04-16 proportions pass) was too small;
// measurements showed NPCs rendering at 17-87 world units vs 800-unit buildings.
const CHARACTER_HEIGHT = 140;

const _locRaycaster = new THREE.Raycaster();
_locRaycaster.layers.set(TERRAIN_LAYER);
const _locRayOrigin = new THREE.Vector3();
const _locRayDir = new THREE.Vector3(0, -1, 0);

// Sanity bounds for computeNormalizedScale. Some GLBs have broken bounding boxes
// (e.g. skinned meshes whose bind pose extends far beyond the visible geometry,
// or meshes with helper objects that inflate the bbox). When the computed scale
// falls outside [SCALE_MIN, SCALE_MAX], the scaleOverride value is used instead.
// SCALE_MIN = CHARACTER_HEIGHT / 200  → implies native height > 200 world units
//   after CHARACTER_HEIGHT normalization — bbox is almost certainly inflated.
// SCALE_MAX = CHARACTER_HEIGHT / 0.01 → implies native height < 0.01 — degenerate.
const NPC_SCALE_CLAMP_MIN = CHARACTER_HEIGHT / 200;  // ~0.70 at CHARACTER_HEIGHT=140
const NPC_SCALE_CLAMP_MAX = CHARACTER_HEIGHT / 0.01; // 14000 — degenerate-bbox guard

const LOCATION_NPCS: Record<string, {
  name: string;
  model: string;
  color?: number; // optional hex tint — applied via applyColorTint()
  /** Per-model scale override used when computeNormalizedScale returns a
   *  value outside [NPC_SCALE_CLAMP_MIN, NPC_SCALE_CLAMP_MAX] (broken bbox). */
  scaleOverride?: number;
}> = {
  'canvas-studio':     { name: 'SpongeBob',  model: '/models/characters/spongebob.glb' },
  'security-fortress': { name: 'Patrick',     model: '/models/characters/patrick.glb'   },
  'memory-vault':      { name: 'Squidward',   model: '/models/characters/squidward.glb' },
  'webhook-gateway':   { name: 'Mr. Krabs',   model: '/models/characters/mr-krabs.glb'  },
  'skill-forge':       { name: 'Plankton',    model: '/models/characters/plankton.glb'  },
  'cron-hub':          { name: 'Gary',         model: '/models/characters/gary.glb'      },
  'channel-bridge':    { name: 'Sandy',        model: '/models/characters/sandy.glb'     },
  // Karen: karen.glb had a broken bbox (world height 1940 at CH=32) caused by
  // SkinnedMesh bind-pose inflation. The improved computeNormalizedScale() excludes
  // SkinnedMesh, which should fix the normalization automatically. scaleOverride=93
  // is a fallback activated ONLY if the non-skinned geometry also gives a bad bbox
  // (outside NPC_SCALE_CLAMP bounds). Assumes karen_visual_native_H ≈ 1.5 native units.
  'tool-workshop':     { name: 'Karen',        model: '/models/characters/karen.glb',    scaleOverride: 93 },
  'voice-tower':       { name: 'Mrs. Puff',    model: '/models/characters/mrs-puff.glb'  },
  // TODO: source proper larry.glb asset — currently using lobster_plush as a distinct stand-in.
  // lobster_plush had a broken bbox (world height 331 at CH=32). SkinnedMesh exclusion
  // should fix normalization; scaleOverride=140 is fallback assuming visual_native_H≈1.0.
  'config-citadel':    { name: 'Larry',        model: '/models/lobster_plush.glb', color: 0xff2020, scaleOverride: 140 },
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

// Scratch vectors for computeNormalizedScale — allocated once to avoid GC in useMemo.
const _npcBboxScratch = new THREE.Box3();
const _npcSizeScratch = new THREE.Vector3();
const _npcMeshBox = new THREE.Box3();

/** Measure bounding box and return scale so the model's Y-height matches targetHeight,
 *  plus the local-space min.y of the geometry (pivot offset).
 *
 *  Uses per-geometry vertex traversal restricted to regular Mesh nodes (NOT SkinnedMesh).
 *  This avoids the most common bbox-inflation bug: Box3.setFromObject() on a scene
 *  containing SkinnedMesh uses the bind-pose world matrix, which can extend the
 *  bounding box far beyond the visible geometry. Regular Mesh children (clothes,
 *  props, non-rigged parts) give a reliable geometry extent.
 *
 *  Fall back to full Box3.setFromObject() if no non-skinned geometry is found.
 *  Returns raw computed scale AND the local min.y; caller applies scaleOverride if set.
 *
 *  localMinY: the lowest point of geometry in local space at scale=1.
 *    - 0  → pivot at feet, no correction needed
 *    - < 0 → pivot above feet (geometry extends below origin); multiply by final scale
 *            and subtract from Y position to lift model so feet sit on terrain
 *    - > 0 → pivot below feet (model floating); same correction lowers it */
function computeNormalizedScale(scene: THREE.Object3D, targetHeight: number): { scale: number; localMinY: number } {
  // Ensure world matrices are current on the cloned scene (not yet in a live Three.js
  // scene graph, so updateWorldMatrix won't have been called automatically).
  scene.updateMatrixWorld(true);
  _npcBboxScratch.makeEmpty();

  scene.traverse((child) => {
    // Explicitly exclude SkinnedMesh — its world matrix reflects the bind pose
    // which may inflate the bbox far beyond the visible rest pose.
    if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
      const mesh = child as THREE.Mesh;
      if (!mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      const geoBB = mesh.geometry.boundingBox;
      if (!geoBB) return;
      // Transform geo bbox into world space via mesh's world matrix
      _npcMeshBox.copy(geoBB).applyMatrix4(mesh.matrixWorld);
      _npcBboxScratch.union(_npcMeshBox);
    }
  });

  // If no regular meshes found (all geometry is skinned), fall back to full scene bbox
  if (_npcBboxScratch.isEmpty()) {
    _npcBboxScratch.setFromObject(scene);
  }

  _npcBboxScratch.getSize(_npcSizeScratch);
  const h = _npcSizeScratch.y > 0.001 ? _npcSizeScratch.y : Math.max(_npcSizeScratch.x, _npcSizeScratch.y, _npcSizeScratch.z);
  const localMinY = _npcBboxScratch.isEmpty() ? 0 : _npcBboxScratch.min.y;
  if (h === 0) return { scale: 1, localMinY };
  return { scale: targetHeight / h, localMinY };
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

  // Clone and compute normalized scale; apply optional color tint.
  // scaleOverride is used for characters whose GLB bbox is broken (Karen, Larry):
  //   - Karen: screen/helper geometry inflates bbox → computed scale too small → world height 1940
  //   - Larry (lobster_plush): bbox too tall relative to visual form → computed scale too large
  // If no scaleOverride, the raw computed scale is used unless it falls outside the
  // sanity clamp [NPC_SCALE_CLAMP_MIN, NPC_SCALE_CLAMP_MAX].
  //
  // pivotOffsetY: world-space Y correction so each GLB's feet sit on the terrain.
  //   = localMinY * finalScale
  //   localMinY is the bbox min.y of non-skinned geometry at scale=1 (local space).
  //   - If pivot is at feet (localMinY ≈ 0): no change.
  //   - If pivot is at torso (localMinY < 0): pivotOffsetY is negative; we subtract it
  //     (double negative = add) to raise the model so geometry bottom aligns with terrainY.
  //   Applied each frame as: group.position.y = terrainY + BASE_LIFT + bob - pivotOffsetY
  const { cloned, npcScale, pivotOffsetY } = useMemo(() => {
    const c = scene.clone(true);
    if (config.color != null) {
      applyColorTint(c, new THREE.Color(config.color), 0.7, 0.25);
    }
    const { scale: computed, localMinY } = computeNormalizedScale(c, CHARACTER_HEIGHT);
    // Use computed scale when it's within the sanity bounds, otherwise fall back
    // to scaleOverride (if configured) or clamp to the nearest bound.
    // Note: computeNormalizedScale now excludes SkinnedMesh bind pose from the bbox,
    // which fixes most broken-bbox cases. scaleOverride is a last-resort manual
    // escape hatch for characters where even the non-skinned geometry gives bad results.
    let s: number;
    if (computed >= NPC_SCALE_CLAMP_MIN && computed <= NPC_SCALE_CLAMP_MAX) {
      // Computed scale is within sanity range — use it
      s = computed;
    } else if (config.scaleOverride != null) {
      // Outside sanity range AND override defined — use the override
      s = config.scaleOverride;
    } else {
      // Outside sanity range, no override — clamp to nearest bound as last resort
      s = Math.max(NPC_SCALE_CLAMP_MIN, Math.min(NPC_SCALE_CLAMP_MAX, computed));
    }
    // Pivot offset: feet correction in world units. localMinY is at scale=1;
    // multiply by final scale to get world-space distance below the group origin.
    const offset = localMinY * s;
    return { cloned: c, npcScale: s, pivotOffsetY: offset };
  }, [scene, config.color, config.scaleOverride]);

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

    // Position: terrainY + BASE_LIFT + bob - pivotOffsetY
    // pivotOffsetY = localMinY * npcScale (world-space feet correction):
    //   - pivotOffsetY < 0 → pivot above feet → subtracting a negative raises the model
    //   - pivotOffsetY = 0 → pivot at feet → no change
    //   - pivotOffsetY > 0 → pivot below feet → lowered to prevent floating
    const bob = Math.sin(clock.elapsedTime * 1.5 + seed) * 0.5;
    groupRef.current.position.set(worldX, terrainY.current + 6 + bob - pivotOffsetY, worldZ);

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
          CHARACTER_HEIGHT (140) = target model world height; +10 = clearance above head. */}
      <Html
        position={[0, CHARACTER_HEIGHT + 10, 0]}
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
