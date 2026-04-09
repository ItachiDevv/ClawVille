'use client';

import { useRef, useMemo, memo, Suspense } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';
import { applyWalkAnimation, applyIdleAnimation, idToSeed } from '@/lib/three/procedural-animation';
import { LobsterAnimator, resolveAnimState } from '@/lib/three/lobster-animations';
import { discoverLobsterParts } from '@/lib/three/lobster-parts';

// ---------------------------------------------------------------------------
// GLB-based NPC renderer with terrain raycasting
// NPCs walk on the actual terrain surface instead of a static Y level
// ---------------------------------------------------------------------------

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const LERP_SPEED = 5;
const NPC_SCALE = 8;

useGLTF.preload('/models/lobster.glb');

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

const DIR_ROTATION: Record<string, number> = {
  down: 0, left: Math.PI / 2, up: Math.PI, right: -Math.PI / 2, idle: 0,
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

// ---------------------------------------------------------------------------
// Single NPC using GLB model with terrain following
// ---------------------------------------------------------------------------
const GLBNpcMesh = memo(function GLBNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const animGroupRef = useRef<THREE.Group>(null!);
  const npcRef = useRef(npc);
  npcRef.current = npc;
  const { scene: threeScene } = useThree();
  const seed = useMemo(() => idToSeed(npc.id), [npc.id]);

  const targetPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentRotY = useRef(0);
  const currentTerrainY = useRef(0);

  const { scene } = useGLTF('/models/lobster.glb');

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    const color = new THREE.Color(npc.color);
    c.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          mat.color.lerp(color, 0.7);
          mat.emissive = color.clone();
          mat.emissiveIntensity = 0.25;
          mesh.material = mat;
        }
      }
    });
    return c;
  }, [scene, npc.color]);

  // Discover lobster parts and create animator
  const animator = useMemo(() => {
    const refs = discoverLobsterParts(cloned);
    return new LobsterAnimator(refs);
  }, [cloned]);

  useFrame(({ clock }, delta) => {
    const d = npcRef.current;
    const group = groupRef.current;
    const animGroup = animGroupRef.current;
    if (!group || !animGroup) return;

    const dt = Math.min(delta, 0.1);
    const elapsed = clock.elapsedTime;

    // Update target XZ position
    targetPos.current.set(d.x - HALF_W, 0, d.y - HALF_H);

    // Lerp XZ position
    currentPos.current.x += (targetPos.current.x - currentPos.current.x) * (1 - Math.exp(-LERP_SPEED * dt));
    currentPos.current.z += (targetPos.current.z - currentPos.current.z) * (1 - Math.exp(-LERP_SPEED * dt));

    group.position.x = currentPos.current.x;
    group.position.z = currentPos.current.z;

    // Raycast to find terrain surface Y (every 3rd frame to save perf)
    const frame = Math.floor(Date.now() / 50);
    if (frame % 3 === 0) {
      const terrainY = getTerrainY(group.position.x, group.position.z, threeScene);
      currentTerrainY.current += (terrainY - currentTerrainY.current) * 0.3;
    }

    // Base bob on top of terrain height
    const isMoving = d.direction !== 'idle' && !d.isDead;
    const bob = isMoving ? Math.sin(Date.now() * 0.005) * 0.6 : 0;
    group.position.y = currentTerrainY.current + 2 + bob;

    // Direction rotation
    const targetRot = DIR_ROTATION[d.direction] ?? 0;
    currentRotY.current += (targetRot - currentRotY.current) * Math.min(1, 8 * dt);
    group.rotation.y = currentRotY.current;

    // Articulated lobster animation (claws, legs, tail, eyes, antennae)
    const animState = resolveAnimState({
      isDead: d.isDead,
      inCombat: d.inCombat,
      combatAction: d.combatAction,
      direction: d.direction,
      inConversation: d.inConversation,
    });
    animator.update(dt, elapsed, animState, d.direction);

    // Secondary layer: procedural squash/stretch/tilt on outer animGroup
    const procState = {
      group: animGroup,
      isMoving,
      elapsed,
      delta: dt,
      direction: d.direction,
      seed,
    };
    if (isMoving) {
      applyWalkAnimation(procState);
    } else {
      applyIdleAnimation(procState);
    }
  });

  return (
    <group ref={groupRef} scale={[NPC_SCALE, NPC_SCALE, NPC_SCALE]}>
      <group ref={animGroupRef}>
        <primitive object={cloned} />
      </group>
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
