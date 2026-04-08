'use client';

import { useRef, useMemo, memo, Suspense } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';

// ---------------------------------------------------------------------------
// GLB-based NPC renderer — lobster.glb model = 1-2 draw calls per NPC
// Original had ~30 meshes per NPC = 90 draw calls for 3 NPCs
// Now: 5 NPCs × ~2 draw calls = ~10 total
// ---------------------------------------------------------------------------

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const LERP_SPEED = 5;
const NPC_SCALE = 4;

// Preload the model once
useGLTF.preload('/models/lobster.glb');

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

const DIR_ROTATION: Record<string, number> = {
  down: 0, left: Math.PI / 2, up: Math.PI, right: -Math.PI / 2, idle: 0,
};

// Cached vectors — no per-frame allocation
const _targetVec = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Single NPC using GLB model
// ---------------------------------------------------------------------------
const GLBNpcMesh = memo(function GLBNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const npcRef = useRef(npc);
  npcRef.current = npc;

  const targetPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentRotY = useRef(0);

  const { scene } = useGLTF('/models/lobster.glb');

  // Clone per NPC and tint with species color
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    const color = new THREE.Color(npc.color);
    c.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material) {
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          // Tint the model with NPC's species color
          mat.color.lerp(color, 0.5);
          mat.emissive = color;
          mat.emissiveIntensity = 0.1;
          mesh.material = mat;
        }
      }
    });
    return c;
  }, [scene, npc.color]);

  useFrame((_, delta) => {
    const d = npcRef.current;
    const group = groupRef.current;
    if (!group) return;

    const dt = Math.min(delta, 0.1);

    // Update target position (y=5 keeps NPCs above terrain surface)
    targetPos.current.set(d.x - HALF_W, 5, d.y - HALF_H);

    // Lerp position (no allocation — reuses currentPos ref)
    currentPos.current.lerp(targetPos.current, 1 - Math.exp(-LERP_SPEED * dt));
    group.position.x = currentPos.current.x;
    group.position.z = currentPos.current.z;

    // Walking bob (base at 5, bob ±0.8)
    const isMoving = d.direction !== 'idle' && !d.isDead;
    group.position.y = 5 + (isMoving ? Math.sin(Date.now() * 0.005) * 0.8 : 0);

    // Rotation
    const targetRot = DIR_ROTATION[d.direction] ?? 0;
    currentRotY.current += (targetRot - currentRotY.current) * Math.min(1, 8 * dt);
    group.rotation.y = currentRotY.current;
  });

  return (
    <group ref={groupRef} scale={[NPC_SCALE, NPC_SCALE, NPC_SCALE]}>
      <primitive object={cloned} />
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
