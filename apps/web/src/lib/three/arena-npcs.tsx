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
  // Lobster shared geometry
  claw: new THREE.BoxGeometry(1.2, 0.4, 0.7),
  clawArm: new THREE.CylinderGeometry(0.25, 0.35, 1.8, 6),
  antenna: new THREE.CylinderGeometry(0.05, 0.08, 3, 4),
  eyeStalk: new THREE.CylinderGeometry(0.12, 0.18, 1, 6),
  eye: new THREE.SphereGeometry(0.35, 12, 12),
  tailSegment: new THREE.BoxGeometry(1.8, 0.7, 1.2),
  tailFan: new THREE.ConeGeometry(1.2, 1.5, 6),
  leg: new THREE.CylinderGeometry(0.08, 0.12, 1.5, 4),
  shell: new THREE.SphereGeometry(2, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
  // Combat
  swordBlade: new THREE.BoxGeometry(0.15, 3.5, 0.5),
  swordHandle: new THREE.BoxGeometry(0.2, 0.8, 0.8),
  hpBarBg: new THREE.BoxGeometry(5, 0.35, 0.35),
  hpBarFill: new THREE.BoxGeometry(5, 0.35, 0.35),
  glowRing: new THREE.TorusGeometry(2.5, 0.25, 8, 32),
  bubble: new THREE.SphereGeometry(0.6, 12, 12),
  bubbleTail: new THREE.ConeGeometry(0.3, 0.6, 4),
};

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

// All NPC species are lobster variants. Base lobster features shared by all.
function BaseLobsterFeatures({ accentColor }: { accentColor: number }) {
  return (
    <group>
      {/* Eye stalks + eyes */}
      {[-1, 1].map((side) => (
        <group key={`eye-${side}`} position={[side * 0.9, 3.8, 1.2]}>
          <mesh geometry={sharedGeo.eyeStalk}>
            <meshStandardMaterial color={accentColor} />
          </mesh>
          <mesh geometry={sharedGeo.eye} position={[0, 0.7, 0]}>
            <meshBasicMaterial color={0xffffff} />
          </mesh>
          <mesh position={[side * 0.05, 0.7, 0.25]}>
            <sphereGeometry args={[0.18, 6, 6]} />
            <meshBasicMaterial color={0x111111} />
          </mesh>
        </group>
      ))}
      {/* Antennae */}
      {[-1, 1].map((side) => (
        <mesh key={`ant-${side}`} geometry={sharedGeo.antenna} position={[side * 0.5, 4.2, 1.5]} rotation={[-0.4, side * 0.3, side * 0.3]}>
          <meshStandardMaterial color={accentColor} />
        </mesh>
      ))}
      {/* Tail segments */}
      {[0, 1].map((i) => (
        <mesh key={`tail-${i}`} geometry={sharedGeo.tailSegment} position={[0, -1.5 - i * 0.8, -1.5 - i * 1]} scale={[1 - i * 0.15, 1, 1]}>
          <meshStandardMaterial color={accentColor} />
        </mesh>
      ))}
      {/* Tail fan */}
      <mesh geometry={sharedGeo.tailFan} position={[0, -2.5, -3.5]} rotation={[0.4, 0, 0]}>
        <meshStandardMaterial color={accentColor} />
      </mesh>
      {/* Legs (3 pairs) */}
      {[-1, 1].map((side) =>
        [0, 1, 2].map((i) => (
          <mesh key={`leg-${side}-${i}`} geometry={sharedGeo.leg} position={[side * 1.6, -0.5, -i * 0.9]} rotation={[0, 0, side * 0.5]}>
            <meshStandardMaterial color={accentColor} />
          </mesh>
        ))
      )}
    </group>
  );
}

// Reef Lobster (cat) — delicate coral claws
function CatFeatures() {
  return (
    <group>
      <BaseLobsterFeatures accentColor={0xff6347} />
      {[-1, 1].map((side) => (
        <group key={`claw-${side}`} position={[side * 2.2, 1, 1]}>
          <mesh geometry={sharedGeo.clawArm} rotation={[0, 0, side * 0.3]}>
            <meshStandardMaterial color={0xff7f50} />
          </mesh>
          <mesh geometry={sharedGeo.claw} position={[side * 0.6, -0.3, 0.4]}>
            <meshStandardMaterial color={0xff6347} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// Abyssal Lobster (dragon) — bioluminescent claws + glow spots
function DragonFeatures() {
  return (
    <group>
      <BaseLobsterFeatures accentColor={0x1a237e} />
      {[-1, 1].map((side) => (
        <group key={`claw-${side}`} position={[side * 2.5, 1.2, 1]}>
          <mesh geometry={sharedGeo.clawArm} rotation={[0, 0, side * 0.4]}>
            <meshStandardMaterial color={0x283593} />
          </mesh>
          <mesh geometry={sharedGeo.claw} position={[side * 0.7, -0.2, 0.4]} scale={[1.3, 1, 1.2]}>
            <meshStandardMaterial color={0x1a237e} emissive={0x00e5ff} emissiveIntensity={0.3} />
          </mesh>
        </group>
      ))}
      {/* Bioluminescent spots */}
      {[[-0.5, 1.5, 1.3], [0.5, 0.8, 1.3], [0, -0.5, 1.3]].map((pos, i) => (
        <mesh key={`glow-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[0.15, 6, 6]} />
          <meshStandardMaterial color={0x00e5ff} emissive={0x00e5ff} emissiveIntensity={0.8} />
        </mesh>
      ))}
    </group>
  );
}

// Spiny Lobster (fox) — long antennae, no large claws
function FoxFeatures() {
  return (
    <group>
      <BaseLobsterFeatures accentColor={0xff8c00} />
      {/* Extra-long antennae */}
      {[-1, 1].map((side) => (
        <mesh key={`long-ant-${side}`} position={[side * 0.4, 4.5, 2]} rotation={[-0.6, side * 0.5, side * 0.2]}>
          <cylinderGeometry args={[0.04, 0.06, 5, 4]} />
          <meshStandardMaterial color={0xffa726} />
        </mesh>
      ))}
      {/* Small spiny legs instead of big claws */}
      {[-1, 1].map((side) => (
        <mesh key={`spine-${side}`} geometry={sharedGeo.clawArm} position={[side * 2, 0.8, 0.8]} rotation={[0, 0, side * 0.5]}>
          <meshStandardMaterial color={0xff8c00} />
        </mesh>
      ))}
    </group>
  );
}

// Hermit Lobster (owl) — carries a shell, large wise eyes
function OwlFeatures() {
  return (
    <group>
      <BaseLobsterFeatures accentColor={0x8d6e63} />
      {/* Shell on back */}
      <mesh geometry={sharedGeo.shell} position={[0, 0.5, -1.2]} rotation={[Math.PI / 5, 0, 0]}>
        <meshStandardMaterial color={0xa1887f} />
      </mesh>
      {/* Small claws */}
      {[-1, 1].map((side) => (
        <group key={`claw-${side}`} position={[side * 2, 0.8, 0.8]}>
          <mesh geometry={sharedGeo.clawArm} rotation={[0, 0, side * 0.3]}>
            <meshStandardMaterial color={0x8d6e63} />
          </mesh>
          <mesh geometry={sharedGeo.claw} position={[side * 0.5, -0.2, 0.3]} scale={[0.8, 0.8, 0.8]}>
            <meshStandardMaterial color={0x795548} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// Crusher Lobster (wolf) — massive crushing claws
function WolfFeatures() {
  return (
    <group>
      <BaseLobsterFeatures accentColor={0xb71c1c} />
      {[-1, 1].map((side) => (
        <group key={`claw-${side}`} position={[side * 2.8, 1, 1.2]}>
          <mesh geometry={sharedGeo.clawArm} rotation={[0, 0, side * 0.35]} scale={[1.3, 1, 1.3]}>
            <meshStandardMaterial color={0xc62828} />
          </mesh>
          <mesh geometry={sharedGeo.claw} position={[side * 0.8, -0.2, 0.5]} scale={[1.8, 1.5, 1.5]}>
            <meshStandardMaterial color={0xb71c1c} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

// Bubble Lobster (bunny) — small, playful with bubble particles
function BunnyFeatures() {
  return (
    <group>
      <BaseLobsterFeatures accentColor={0xff80ab} />
      {[-1, 1].map((side) => (
        <group key={`claw-${side}`} position={[side * 2, 0.8, 0.8]}>
          <mesh geometry={sharedGeo.clawArm} rotation={[0, 0, side * 0.3]}>
            <meshStandardMaterial color={0xf48fb1} />
          </mesh>
          <mesh geometry={sharedGeo.claw} position={[side * 0.5, -0.2, 0.3]} scale={[0.9, 0.9, 0.9]}>
            <meshStandardMaterial color={0xff80ab} />
          </mesh>
        </group>
      ))}
      {/* Decorative bubbles floating above */}
      {[[0.8, 5, 0.5], [-0.5, 5.5, -0.3], [0.2, 5.8, 0.8]].map((pos, i) => (
        <mesh key={`bubble-${i}`} position={pos as [number, number, number]}>
          <sphereGeometry args={[0.2 + i * 0.05, 8, 8]} />
          <meshStandardMaterial color={0xffffff} transparent opacity={0.4} />
        </mesh>
      ))}
    </group>
  );
}

// Mantis Lobster (phoenix) — rainbow striking appendages with glow
function PhoenixFeatures() {
  return (
    <group>
      <BaseLobsterFeatures accentColor={0x00e676} />
      {[-1, 1].map((side) => (
        <group key={`strike-${side}`} position={[side * 2.5, 1.5, 1.2]}>
          <mesh geometry={sharedGeo.clawArm} rotation={[0, 0, side * 0.4]} scale={[1.1, 1, 1.1]}>
            <meshStandardMaterial color={0x76ff03} emissive={0x00e676} emissiveIntensity={0.3} />
          </mesh>
          <mesh geometry={sharedGeo.claw} position={[side * 0.6, -0.3, 0.4]} scale={[1.1, 0.8, 1]}>
            <meshStandardMaterial color={0x00e676} emissive={0x00e676} emissiveIntensity={0.2} />
          </mesh>
        </group>
      ))}
      {/* Rainbow accent bands on body */}
      {[0xff0000, 0xff9800, 0xffeb3b, 0x4caf50, 0x2196f3].map((c, i) => (
        <mesh key={`band-${i}`} position={[0, 1.5 - i * 0.6, 1.55]}>
          <boxGeometry args={[2.5, 0.15, 0.1]} />
          <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.2} />
        </mesh>
      ))}
    </group>
  );
}

// Iron Lobster (turtle) — heavily armored carapace plates
function TurtleFeatures() {
  return (
    <group>
      <BaseLobsterFeatures accentColor={0x455a64} />
      {/* Heavy armor shell on back */}
      <mesh geometry={sharedGeo.shell} position={[0, 0.8, -0.8]} rotation={[Math.PI / 6, 0, 0]} scale={[1.2, 1, 1.2]}>
        <meshStandardMaterial color={0x37474f} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* Armored claws */}
      {[-1, 1].map((side) => (
        <group key={`claw-${side}`} position={[side * 2.3, 1, 1]}>
          <mesh geometry={sharedGeo.clawArm} rotation={[0, 0, side * 0.35]}>
            <meshStandardMaterial color={0x546e7a} metalness={0.4} roughness={0.4} />
          </mesh>
          <mesh geometry={sharedGeo.claw} position={[side * 0.7, -0.2, 0.4]} scale={[1.4, 1.2, 1.2]}>
            <meshStandardMaterial color={0x455a64} metalness={0.5} roughness={0.35} />
          </mesh>
        </group>
      ))}
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
