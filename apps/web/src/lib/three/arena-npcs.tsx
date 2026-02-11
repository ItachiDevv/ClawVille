'use client';

import { useRef, useMemo, memo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Billboard } from '@react-three/drei';
import * as THREE from 'three';
import { useNpcStore, type NpcSpriteState } from '@/stores/npc';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 800;
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;

const LERP_SPEED = 5;
const BOB_SPEED = 5;
const BOB_AMPLITUDE = 0.3;
const SWORD_SWING_SPEED = 8;
const GLOW_PULSE_SPEED = 3;

// Direction -> Y rotation (radians). Idle defaults to facing camera (0).
const DIR_ROTATION: Record<NpcSpriteState['direction'], number> = {
  down: 0,
  left: Math.PI / 2,
  up: Math.PI,
  right: -Math.PI / 2,
  idle: 0,
};

// HP bar color stops
function hpColor(ratio: number): THREE.Color {
  if (ratio > 0.5) {
    // green -> yellow
    const t = (ratio - 0.5) * 2;
    return new THREE.Color().setRGB(1 - t, 1, 0);
  }
  // yellow -> red
  const t = ratio * 2;
  return new THREE.Color().setRGB(1, t, 0);
}

/** Convert map pixel coords to Three.js world coords */
function mapToWorld(px: number, py: number): [number, number, number] {
  return [px - HALF_W, 0, py - HALF_H];
}

// ---------------------------------------------------------------------------
// Shared geometries & materials (created once, reused by all NPCs)
// ---------------------------------------------------------------------------

const sharedGeo = {
  capsule: new THREE.CapsuleGeometry(1.5, 4, 8, 16),
  ear: new THREE.ConeGeometry(0.6, 1.8, 4),
  horn: new THREE.ConeGeometry(0.3, 1.2, 6),
  wingTriangle: new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(-2.5, 2, 0),
    new THREE.Vector3(-1, -0.5, 0),
  ]),
  tail: new THREE.ConeGeometry(0.8, 2.5, 8),
  snout: new THREE.ConeGeometry(0.5, 1.5, 8),
  bunnyEar: new THREE.CylinderGeometry(0.3, 0.4, 3, 8),
  eye: new THREE.SphereGeometry(0.5, 12, 12),
  shell: new THREE.SphereGeometry(2.2, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
  wingPlane: new THREE.PlaneGeometry(2.5, 3),
  swordBlade: new THREE.BoxGeometry(0.15, 3.5, 0.5),
  swordHandle: new THREE.BoxGeometry(0.2, 0.8, 0.8),
  hpBarBg: new THREE.BoxGeometry(5, 0.35, 0.35),
  hpBarFill: new THREE.BoxGeometry(5, 0.35, 0.35),
  glowRing: new THREE.TorusGeometry(2.5, 0.25, 8, 32),
  bubble: new THREE.SphereGeometry(0.6, 12, 12),
  bubbleTail: new THREE.ConeGeometry(0.3, 0.6, 4),
};

// Pre-compute the wing triangle face
sharedGeo.wingTriangle.computeVertexNormals();

// Shared materials (will be cloned per-NPC only when colour differs)
const matWhite = new THREE.MeshStandardMaterial({ color: 0xffffff });
const matBlack = new THREE.MeshStandardMaterial({ color: 0x222222 });
const matSilver = new THREE.MeshStandardMaterial({ color: 0xcccccc });
const matBrown = new THREE.MeshStandardMaterial({ color: 0x8b5e3c });
const matHpBg = new THREE.MeshBasicMaterial({ color: 0x333333 });
const matBubble = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.85,
});

// ---------------------------------------------------------------------------
// Species feature sub-components (pure geometry, no state)
// ---------------------------------------------------------------------------

function CatFeatures() {
  return (
    <group>
      {/* Left ear */}
      <mesh geometry={sharedGeo.ear} position={[-1, 4.5, 0]} rotation={[0, 0, -0.3]}>
        <meshStandardMaterial color={0x888888} />
      </mesh>
      {/* Right ear */}
      <mesh geometry={sharedGeo.ear} position={[1, 4.5, 0]} rotation={[0, 0, 0.3]}>
        <meshStandardMaterial color={0x888888} />
      </mesh>
    </group>
  );
}

function DragonFeatures() {
  return (
    <group>
      {/* Horn */}
      <mesh geometry={sharedGeo.horn} position={[0, 5, 0]}>
        <meshStandardMaterial color={0xffd700} />
      </mesh>
      {/* Left wing */}
      <mesh
        geometry={sharedGeo.wingTriangle}
        position={[-1.5, 2, -1]}
        rotation={[0, -0.3, 0]}
      >
        <meshStandardMaterial color={0x665599} side={THREE.DoubleSide} />
      </mesh>
      {/* Right wing (mirrored) */}
      <mesh
        geometry={sharedGeo.wingTriangle}
        position={[1.5, 2, -1]}
        rotation={[0, 0.3, 0]}
        scale={[-1, 1, 1]}
      >
        <meshStandardMaterial color={0x665599} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function FoxFeatures() {
  return (
    <group>
      {/* Pointed ears */}
      <mesh geometry={sharedGeo.ear} position={[-1, 4.5, 0]} rotation={[0, 0, -0.2]}>
        <meshStandardMaterial color={0xff8844} />
      </mesh>
      <mesh geometry={sharedGeo.ear} position={[1, 4.5, 0]} rotation={[0, 0, 0.2]}>
        <meshStandardMaterial color={0xff8844} />
      </mesh>
      {/* Bushy tail */}
      <mesh geometry={sharedGeo.tail} position={[0, -0.5, -2]} rotation={[0.8, 0, 0]}>
        <meshStandardMaterial color={0xff6600} />
      </mesh>
    </group>
  );
}

function OwlFeatures() {
  return (
    <group>
      {/* Big eyes */}
      <mesh geometry={sharedGeo.eye} position={[-0.7, 2.5, 1.4]}>
        <meshStandardMaterial color={0xffff00} emissive={0x666600} />
      </mesh>
      <mesh geometry={sharedGeo.eye} position={[0.7, 2.5, 1.4]}>
        <meshStandardMaterial color={0xffff00} emissive={0x666600} />
      </mesh>
      {/* Pupils */}
      <mesh position={[-0.7, 2.5, 1.85]} scale={[0.45, 0.45, 0.1]}>
        <sphereGeometry args={[0.5, 8, 8]} />
        <meshBasicMaterial color={0x000000} />
      </mesh>
      <mesh position={[0.7, 2.5, 1.85]} scale={[0.45, 0.45, 0.1]}>
        <sphereGeometry args={[0.5, 8, 8]} />
        <meshBasicMaterial color={0x000000} />
      </mesh>
    </group>
  );
}

function WolfFeatures() {
  return (
    <group>
      {/* Angular ears */}
      <mesh geometry={sharedGeo.ear} position={[-1.2, 4.5, 0]} rotation={[0, 0, -0.15]}>
        <meshStandardMaterial color={0x666666} />
      </mesh>
      <mesh geometry={sharedGeo.ear} position={[1.2, 4.5, 0]} rotation={[0, 0, 0.15]}>
        <meshStandardMaterial color={0x666666} />
      </mesh>
      {/* Snout */}
      <mesh
        geometry={sharedGeo.snout}
        position={[0, 1.8, 1.8]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <meshStandardMaterial color={0x999999} />
      </mesh>
    </group>
  );
}

function BunnyFeatures() {
  return (
    <group>
      {/* Tall floppy ears */}
      <mesh geometry={sharedGeo.bunnyEar} position={[-0.7, 5.2, 0]} rotation={[0, 0, -0.15]}>
        <meshStandardMaterial color={0xffaacc} />
      </mesh>
      <mesh geometry={sharedGeo.bunnyEar} position={[0.7, 5.2, 0]} rotation={[0, 0, 0.15]}>
        <meshStandardMaterial color={0xffaacc} />
      </mesh>
    </group>
  );
}

function PhoenixFeatures() {
  return (
    <group>
      {/* Wing planes */}
      <mesh
        geometry={sharedGeo.wingPlane}
        position={[-2, 1.5, -0.5]}
        rotation={[0, -0.4, 0.3]}
      >
        <meshStandardMaterial
          color={0xff4400}
          emissive={0xff2200}
          emissiveIntensity={0.4}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh
        geometry={sharedGeo.wingPlane}
        position={[2, 1.5, -0.5]}
        rotation={[0, 0.4, -0.3]}
      >
        <meshStandardMaterial
          color={0xff4400}
          emissive={0xff2200}
          emissiveIntensity={0.4}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

function TurtleFeatures() {
  return (
    <group>
      {/* Dome shell on back */}
      <mesh
        geometry={sharedGeo.shell}
        position={[0, 0.5, -1]}
        rotation={[Math.PI / 6, 0, 0]}
      >
        <meshStandardMaterial color={0x336633} />
      </mesh>
    </group>
  );
}

const speciesComponents: Record<string, React.FC> = {
  cat: CatFeatures,
  dragon: DragonFeatures,
  fox: FoxFeatures,
  owl: OwlFeatures,
  wolf: WolfFeatures,
  bunny: BunnyFeatures,
  phoenix: PhoenixFeatures,
  turtle: TurtleFeatures,
};

// ---------------------------------------------------------------------------
// Single NPC component
// ---------------------------------------------------------------------------

interface NpcMeshProps {
  npc: NpcSpriteState;
}

const NpcMesh = memo(function NpcMesh({ npc }: NpcMeshProps) {
  const groupRef = useRef<THREE.Group>(null!);
  const swordRef = useRef<THREE.Group>(null!);
  const hpFillRef = useRef<THREE.Mesh>(null!);
  const hpFillMatRef = useRef<THREE.MeshBasicMaterial>(null!);
  const glowRef = useRef<THREE.Mesh>(null!);
  const bodyMatRef = useRef<THREE.MeshStandardMaterial>(null!);

  // Cache the NPC data in a ref so useFrame can access without reading the store
  const npcDataRef = useRef(npc);
  npcDataRef.current = npc;

  // Target world position (updated from npc data each render)
  const targetPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));
  targetPos.current.set(npc.x - HALF_W, 0, npc.y - HALF_H);

  // Current interpolated position
  const currentPos = useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)));

  // Current facing rotation
  const currentRotY = useRef(DIR_ROTATION[npc.direction]);

  // Body color as THREE.Color
  const bodyColor = useMemo(() => new THREE.Color(npc.color), [npc.color]);

  // Species feature component
  const SpeciesComp = speciesComponents[npc.species] ?? null;

  // HP ratio for bar sizing
  const hpRatio = npc.maxHp > 0 ? npc.hp / npc.maxHp : 1;

  useFrame((state, delta) => {
    const d = npcDataRef.current;
    const group = groupRef.current;
    if (!group) return;

    const dt = Math.min(delta, 0.1); // clamp delta to avoid jumps
    const elapsed = state.clock.elapsedTime;

    // --- Position lerp ---
    currentPos.current.lerp(targetPos.current, 1 - Math.exp(-LERP_SPEED * dt));
    group.position.x = currentPos.current.x;
    group.position.z = currentPos.current.z;

    // --- Walking bob (only when moving) ---
    const isMoving = d.direction !== 'idle' && !d.isDead;
    const bob = isMoving ? Math.sin(elapsed * BOB_SPEED) * BOB_AMPLITUDE : 0;
    group.position.y = bob;

    // --- Facing direction rotation (smooth) ---
    const targetRot = DIR_ROTATION[d.direction];
    currentRotY.current += (targetRot - currentRotY.current) * Math.min(1, 8 * dt);
    group.rotation.y = currentRotY.current;

    // --- Death state: tilt on Z, semi-transparent ---
    if (d.isDead) {
      group.rotation.z += (Math.PI / 2 - group.rotation.z) * Math.min(1, 4 * dt);
      if (bodyMatRef.current) {
        bodyMatRef.current.opacity += (0.4 - bodyMatRef.current.opacity) * Math.min(1, 4 * dt);
      }
    } else {
      group.rotation.z *= 1 - Math.min(1, 8 * dt);
      if (bodyMatRef.current) {
        bodyMatRef.current.opacity += (1 - bodyMatRef.current.opacity) * Math.min(1, 4 * dt);
      }
    }

    // --- Sword swing ---
    if (swordRef.current) {
      if (d.inCombat && d.hasSword) {
        swordRef.current.rotation.z = Math.sin(elapsed * SWORD_SWING_SPEED) * 0.8;
      } else {
        swordRef.current.rotation.z *= 1 - Math.min(1, 6 * dt);
      }
    }

    // --- HP bar update ---
    if (hpFillRef.current && hpFillMatRef.current) {
      const ratio = d.maxHp > 0 ? d.hp / d.maxHp : 1;
      hpFillRef.current.scale.x = Math.max(0.001, ratio);
      hpFillRef.current.position.x = -(1 - ratio) * 2.5;
      const col = hpColor(ratio);
      hpFillMatRef.current.color.copy(col);
    }

    // --- OpenClaw glow pulse ---
    if (glowRef.current) {
      if (d.isOpenClaw) {
        glowRef.current.visible = true;
        const pulse = 0.7 + Math.sin(elapsed * GLOW_PULSE_SPEED) * 0.3;
        glowRef.current.scale.setScalar(pulse);
      } else {
        glowRef.current.visible = false;
      }
    }
  });

  const labelText = npc.isOpenClaw ? `[OC] ${npc.name}` : npc.name;

  return (
    <group ref={groupRef}>
      {/* Body capsule */}
      <mesh geometry={sharedGeo.capsule} castShadow>
        <meshStandardMaterial
          ref={bodyMatRef}
          color={bodyColor}
          transparent
          opacity={npc.isDead ? 0.4 : 1}
        />
      </mesh>

      {/* Species-specific features */}
      {SpeciesComp && <SpeciesComp />}

      {/* Sword (when hasSword) */}
      {npc.hasSword && (
        <group ref={swordRef} position={[2.2, 1, 0]}>
          <mesh geometry={sharedGeo.swordBlade} position={[0, 1.8, 0]} material={matSilver} />
          <mesh geometry={sharedGeo.swordHandle} position={[0, -0.1, 0]} material={matBrown} />
        </group>
      )}

      {/* HP bar background */}
      <mesh
        geometry={sharedGeo.hpBarBg}
        material={matHpBg}
        position={[0, 6.5, 0]}
      />

      {/* HP bar fill */}
      <mesh
        ref={hpFillRef}
        geometry={sharedGeo.hpBarFill}
        position={[-(1 - hpRatio) * 2.5, 6.5, 0.01]}
        scale={[Math.max(0.001, hpRatio), 1, 1]}
      >
        <meshBasicMaterial ref={hpFillMatRef} color={hpColor(hpRatio)} />
      </mesh>

      {/* Name label */}
      <Billboard position={[0, 7.3, 0]}>
        <Text
          fontSize={1}
          color="white"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.08}
          outlineColor="#000000"
        >
          {labelText}
        </Text>
      </Billboard>

      {/* OpenClaw glow ring */}
      <mesh
        ref={glowRef}
        geometry={sharedGeo.glowRing}
        position={[0, -1.8, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        visible={npc.isOpenClaw}
      >
        <meshStandardMaterial
          color={0x00ffff}
          emissive={0x00ffff}
          emissiveIntensity={1.5}
          transparent
          opacity={0.7}
        />
      </mesh>

      {/* Speech bubble indicator (when in conversation) */}
      {npc.inConversation && (
        <group position={[0, 8.5, 0]}>
          <mesh geometry={sharedGeo.bubble} material={matBubble} />
          {/* Three small dots inside the bubble */}
          <mesh position={[-0.25, 0, 0.55]} scale={[0.12, 0.12, 0.12]}>
            <sphereGeometry args={[1, 6, 6]} />
            <meshBasicMaterial color={0x666666} />
          </mesh>
          <mesh position={[0, 0, 0.55]} scale={[0.12, 0.12, 0.12]}>
            <sphereGeometry args={[1, 6, 6]} />
            <meshBasicMaterial color={0x666666} />
          </mesh>
          <mesh position={[0.25, 0, 0.55]} scale={[0.12, 0.12, 0.12]}>
            <sphereGeometry args={[1, 6, 6]} />
            <meshBasicMaterial color={0x666666} />
          </mesh>
          {/* Bubble tail */}
          <mesh
            geometry={sharedGeo.bubbleTail}
            position={[0, -0.7, 0]}
            rotation={[0, 0, Math.PI]}
            material={matBubble}
          />
        </group>
      )}
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main exported component - renders all NPCs
// ---------------------------------------------------------------------------

export default function ArenaNpcs() {
  const npcs = useNpcStore((s) => s.npcs);

  return (
    <group>
      {npcs.map((npc) => (
        <NpcMesh key={npc.id} npc={npc} />
      ))}
    </group>
  );
}
