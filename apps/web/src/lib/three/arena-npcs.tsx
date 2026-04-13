'use client';

import { useRef, useMemo, memo, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Html } from '@react-three/drei';
import * as THREE from 'three';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';
import { applyWalkAnimation, applyIdleAnimation, idToSeed } from '@/lib/three/procedural-animation';
import { LobsterAnimator, resolveAnimState } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';
import {
  createCharacterAnimator,
  applyColorTint,
  type CharacterAnimator,
  MODEL_KEY_TO_TYPE,
} from '@/lib/three/character-animations';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// GLB-based NPC renderer with terrain raycasting
// NPCs walk on the actual terrain surface instead of a static Y level
// ---------------------------------------------------------------------------

const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const LERP_SPEED = 5;
const NPC_SCALE = 8;

useGLTF.preload('/models/lobster.glb');

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

// Lobster GLB faces +Z natively (rotation.y=0 → head toward +Z).
// To face world direction (worldVx, worldVz): θ = atan2(worldVx, worldVz)
const DIR_ROTATION: Record<string, number> = {
  down: 0, left: -Math.PI / 2, up: Math.PI, right: Math.PI / 2, idle: 0,
};

import { TERRAIN_LAYER } from '@/lib/three/arena-terrain';

// Shared raycaster — set to only hit layer 1 (terrain)
const _raycaster = new THREE.Raycaster();
_raycaster.layers.set(TERRAIN_LAYER);
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3(0, -1, 0);

/** Raycast down from (x, z) to find terrain surface Y */
function getTerrainY(x: number, z: number, scene: THREE.Scene): number {
  _rayOrigin.set(x, 200, z);
  _raycaster.set(_rayOrigin, _rayDir);
  // Re-apply layer after set() (set() resets layers)
  _raycaster.layers.set(TERRAIN_LAYER);
  _raycaster.far = 400;

  const intersects = _raycaster.intersectObjects(scene.children, true);
  if (intersects.length > 0) {
    return intersects[0].point.y;
  }
  return -2; // flat sand floor
}

// Map species strings to GLB paths + model keys for the new character system
const SPECIES_MODEL: Record<string, { path: string; key: string }> = {
  lobster:       { path: '/models/lobster.glb',                    key: 'lobster' },
  crayfish:      { path: '/models/crayfish.glb',                   key: 'crayfish' },
  sweet_crab:    { path: '/models/sweet_crab_sketchfabweekly.glb', key: 'sweet_crab' },
  lobster_plush: { path: '/models/lobster_plush.glb',              key: 'lobster_plush' },
  hermitcrab:    { path: '/models/hermitcrab.glb',                 key: 'hermitcrab' },
  chihiro:       { path: '/models/spirited_away_senchihiro.glb',   key: 'chihiro' },
  priestess:     { path: '/models/young_priestess.glb',            key: 'priestess' },
  chibi_goku:    { path: '/models/chibi_goku.glb',                 key: 'chibi_goku' },
  jellyfish:     { path: '/models/jellyfish.glb',                  key: 'jellyfish' },
  octopus:       { path: '/models/octopus_toy.glb',                key: 'octopus' },
  seahorse:      { path: '/models/sea_horse.glb',                  key: 'seahorse' },
};
const DEFAULT_SPECIES = SPECIES_MODEL.lobster;

// ---------------------------------------------------------------------------
// Single NPC using GLB model with terrain following
// ---------------------------------------------------------------------------
const GLBNpcMesh = memo(function GLBNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const animGroupRef = useRef<THREE.Group>(null!);
  const npcRef = useRef(npc);
  npcRef.current = npc;
  const { scene: threeScene } = useThree();
  // idToSeed returns a float (0..10). Convert to integer so (frame + seed) % N
  // uses integer arithmetic — float modulo with strict === 0 never fires.
  const seed = useMemo(() => Math.round(idToSeed(npc.id)), [npc.id]);

  const targetPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentRotY = useRef(0);
  const currentTerrainY = useRef(0);

  const speciesInfo = SPECIES_MODEL[npc.species] ?? DEFAULT_SPECIES;
  const { scene } = useGLTF(speciesInfo.path);

  // Determine which animation system to use
  const useNewSystem = speciesInfo.key !== 'lobster' && speciesInfo.key !== 'crayfish';

  const { cloned, lobsterAnimator, charAnimator } = useMemo(() => {
    const c = scene.clone(true);
    const tint = new THREE.Color(npc.color);
    applyColorTint(c, tint, 0.7, 0.25);

    if (useNewSystem) {
      const anim = createCharacterAnimator(speciesInfo.key, c);
      return {
        cloned: c,
        lobsterAnimator: null as LobsterAnimator | null,
        charAnimator: anim as CharacterAnimator,
      };
    } else {
      const parts = discoverLobsterParts(c);
      const anim  = new LobsterAnimator(parts);
      return {
        cloned: c,
        lobsterAnimator: anim,
        charAnimator: null as CharacterAnimator | null,
      };
    }
  }, [scene, npc.color, speciesInfo.key, useNewSystem]);

  useFrame(({ clock }, delta) => {
    const d = npcRef.current;
    const group = groupRef.current;
    const animGroup = animGroupRef.current;
    if (!group || !animGroup) return;

    const dt = Math.min(delta, 0.1);

    // Update target XZ position
    targetPos.current.set(d.x - HALF_W, 0, d.y - HALF_H);

    // Lerp XZ position
    currentPos.current.x += (targetPos.current.x - currentPos.current.x) * (1 - Math.exp(-LERP_SPEED * dt));
    currentPos.current.z += (targetPos.current.z - currentPos.current.z) * (1 - Math.exp(-LERP_SPEED * dt));

    group.position.x = currentPos.current.x;
    group.position.z = currentPos.current.z;

    // Raycast to find terrain surface Y (every 3rd frame to save perf).
    // Use (frame + seed) % 3 to stagger across NPCs — prevents all NPCs from
    // raycasting on the same frame tick (which would spike the CPU every 150ms).
    const frame = Math.floor(Date.now() / 50);
    if ((frame + seed) % 3 === 0) {
      const terrainY = getTerrainY(group.position.x, group.position.z, threeScene);
      currentTerrainY.current += (terrainY - currentTerrainY.current) * 0.3;
    }

    // Base bob on top of terrain height
    const isMoving = d.direction !== 'idle' && !d.isDead;
    const bob = isMoving ? Math.sin(Date.now() * 0.005) * 0.6 : 0;
    group.position.y = currentTerrainY.current + 2 + bob;

    // Direction rotation — use smooth facingAngle when set (possessed NPC),
    // otherwise snap to cardinal DIR_ROTATION (autonomous wander NPCs).
    const targetRot = d.facingAngle != null ? d.facingAngle : (DIR_ROTATION[d.direction] ?? 0);
    // Shortest-path lerp (handle wrapping around ±PI)
    let diff = targetRot - currentRotY.current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    currentRotY.current += diff * Math.min(1, 8 * dt);
    group.rotation.y = currentRotY.current;

    if (useNewSystem && charAnimator) {
      // Universal character animation system — handles all secondary motion internally
      charAnimator.update(animGroup, clock.elapsedTime, dt, isMoving);
    } else if (lobsterAnimator) {
      // Legacy lobster skeletal animation
      const suggestedState = resolveAnimState({
        isDead: d.isDead,
        inCombat: false,
        combatAction: null,
        direction: d.direction,
        inConversation: false,
      });
      lobsterAnimator.update(dt, clock.elapsedTime, suggestedState, d.direction);

      // Procedural group-level squash/stretch/tilt
      const animStateData = {
        group: animGroup,
        isMoving,
        elapsed: clock.elapsedTime,
        delta: dt,
        direction: d.direction,
        seed,
      };
      if (isMoving) {
        applyWalkAnimation(animStateData);
      } else {
        applyIdleAnimation(animStateData);
      }
    }
  });

  return (
    <group ref={groupRef}>
      {/* Scaled model sub-group */}
      <group scale={[NPC_SCALE, NPC_SCALE, NPC_SCALE]}>
        <group ref={animGroupRef}>
          <primitive object={cloned} />
        </group>
      </group>
      {/* Name label — OUTSIDE scaled group so position is in world units.
          NPC models are ~8-16 world units tall (NPC_SCALE=8); 18 = safe above tallest species. */}
      <Html
        position={[0, 18, 0]}
        center
        distanceFactor={300}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[10, 100]}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'rgba(8, 20, 38, 0.78)',
            border: '1px solid rgba(100, 200, 255, 0.25)',
            borderRadius: 6,
            padding: '2px 8px',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          }}
        >
          <span
            style={{
              color: '#fff',
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: '0.03em',
            }}
          >
            {npc.name}
          </span>
          {npc.isOpenClaw && (
            <span
              style={{
                background: 'rgba(16, 185, 129, 0.85)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 9,
                borderRadius: 4,
                padding: '1px 4px',
                letterSpacing: '0.04em',
              }}
            >
              OpenClaw
            </span>
          )}
        </div>
      </Html>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export default function ArenaNpcs() {
  const npcs = useNpcStore((s) => s.npcs);

  return (
    <Suspense fallback={null}>
      <group>
        {npcs.map((npc) => (
          <GLBNpcMesh key={npc.id} npc={npc} />
        ))}
      </group>
    </Suspense>
  );
}
