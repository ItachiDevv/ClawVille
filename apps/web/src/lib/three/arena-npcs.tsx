'use client';

import { useRef, memo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';

// ---------------------------------------------------------------------------
// GPU-SAFE NPC renderer — 3 meshes per NPC max (body + eyes + hp bar)
// With 3 demo NPCs = 9 total draw calls
// Original had ~30 meshes per NPC = 90 draw calls for 3 NPCs
// ---------------------------------------------------------------------------

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
const LERP_SPEED = 5;

function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

const DIR_ROTATION: Record<string, number> = {
  down: 0, left: Math.PI / 2, up: Math.PI, right: -Math.PI / 2, idle: 0,
};

// Shared geometry — created once
const bodyGeo = new THREE.CapsuleGeometry(2, 4, 6, 12);
const eyeGeo = new THREE.SphereGeometry(0.5, 6, 6);
const hpBgGeo = new THREE.BoxGeometry(5, 0.4, 0.4);
const hpFillGeo = new THREE.BoxGeometry(5, 0.4, 0.4);
const matHpBg = new THREE.MeshBasicMaterial({ color: 0x333333 });

function hpColor(ratio: number): THREE.Color {
  if (ratio > 0.5) return new THREE.Color().setRGB(1 - (ratio - 0.5) * 2, 1, 0);
  return new THREE.Color().setRGB(1, ratio * 2, 0);
}

// ---------------------------------------------------------------------------
// Simple NPC mesh — body capsule + 2 eyes + HP bar = 4 meshes
// ---------------------------------------------------------------------------
const SimpleNpcMesh = memo(function SimpleNpcMesh({ npc }: { npc: NpcSpriteState }) {
  const groupRef = useRef<THREE.Group>(null!);
  const hpFillRef = useRef<THREE.Mesh>(null!);
  const hpMatRef = useRef<THREE.MeshBasicMaterial>(null!);
  const npcRef = useRef(npc);
  npcRef.current = npc;

  const targetPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  const currentRotY = useRef(0);
  const bodyColor = new THREE.Color(npc.color);

  useFrame((_, delta) => {
    const d = npcRef.current;
    const group = groupRef.current;
    if (!group) return;

    const dt = Math.min(delta, 0.1);

    // Update target
    targetPos.current.set(d.x - HALF_W, 0, d.y - HALF_H);

    // Lerp position
    currentPos.current.lerp(targetPos.current, 1 - Math.exp(-LERP_SPEED * dt));
    group.position.x = currentPos.current.x;
    group.position.z = currentPos.current.z;

    // Bob
    const isMoving = d.direction !== 'idle' && !d.isDead;
    group.position.y = isMoving ? Math.sin(Date.now() * 0.005) * 0.5 : 0;

    // Rotation
    const targetRot = DIR_ROTATION[d.direction] ?? 0;
    currentRotY.current += (targetRot - currentRotY.current) * Math.min(1, 8 * dt);
    group.rotation.y = currentRotY.current;

    // HP bar
    if (hpFillRef.current && hpMatRef.current) {
      const ratio = d.maxHp > 0 ? d.hp / d.maxHp : 1;
      hpFillRef.current.scale.x = Math.max(0.001, ratio);
      hpFillRef.current.position.x = -(1 - ratio) * 2.5;
      hpMatRef.current.color.copy(hpColor(ratio));
    }
  });

  return (
    <group ref={groupRef} scale={[2, 2, 2]}>
      {/* Body — 1 mesh */}
      <mesh geometry={bodyGeo} castShadow>
        <meshStandardMaterial color={bodyColor} roughness={0.6} emissive={bodyColor} emissiveIntensity={0.15} />
      </mesh>

      {/* Eyes — 2 meshes */}
      <mesh geometry={eyeGeo} position={[-0.7, 3, 1.5]}>
        <meshBasicMaterial color={0xffffff} />
      </mesh>
      <mesh geometry={eyeGeo} position={[0.7, 3, 1.5]}>
        <meshBasicMaterial color={0xffffff} />
      </mesh>

      {/* HP bar bg — 1 mesh */}
      <mesh geometry={hpBgGeo} material={matHpBg} position={[0, 6, 0]} />

      {/* HP bar fill — 1 mesh */}
      <mesh ref={hpFillRef} geometry={hpFillGeo} position={[0, 6, 0.01]}>
        <meshBasicMaterial ref={hpMatRef} color={0x00ff00} />
      </mesh>
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main export — renders all NPCs with minimal draw calls
// ---------------------------------------------------------------------------
export default function ArenaNpcs() {
  const npcs = useNpcStore((s) => s.npcs);

  return (
    <group>
      {npcs.map((npc) => (
        <SimpleNpcMesh key={npc.id} npc={npc} />
      ))}
    </group>
  );
}
