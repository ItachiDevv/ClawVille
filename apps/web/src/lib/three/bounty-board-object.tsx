'use client';

/**
 * BountyBoardObject — world-surface anchor for the Bounty Board modal.
 *
 * A physical wooden/coral notice board built from Three.js primitives —
 * a tall flat plank (BoxGeometry) with 3 smaller parchment planes pinned on.
 * Each parchment uses a rarity-tinted TSL MeshBasicNodeMaterial.
 *
 * Placed adjacent to the Quest NPC in the village center,
 * 50 units right of center (now symmetric at 0, 0 on 160x160 square map).
 *
 * Clicking opens useGameStore().openBountyBoard().
 *
 * Draw calls: 1 (plank) + 1 (post) + 3 (parchments) = 5
 * GPU constraints: TSL materials only, no GLSL, no Text/Billboard.
 */

import { useRef, useMemo, memo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { color, float, sin, time, mix } from 'three/tsl';
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// World position — adjacent to Quest NPC in village center
// Moved further right: 50 units right of center on 160x160 symmetric map.
// Was (30, -16); BOARD_Z now 0 because the square map center is symmetric.
// ---------------------------------------------------------------------------
const BOARD_X = 50;
const BOARD_Z = 0;
const BOARD_Y = -2;

// ---------------------------------------------------------------------------
// Rarity colors (from rarity.ts) converted to hex numbers
// ---------------------------------------------------------------------------
const RARITY_COLORS = {
  common:    0x9ca3af,
  rare:      0x3b82f6,
  epic:      0xa855f7,
} as const;

// ---------------------------------------------------------------------------
// Parchment definitions — 3 pinned notes
// Each has a rarity-tinted TSL emissive color
// ---------------------------------------------------------------------------
interface ParchmentDef {
  localX: number;
  localY: number; // relative to board center
  rarityColor: number;
  angle: number;  // slight rotation for organic feel
}

const PARCHMENTS: ParchmentDef[] = [
  { localX: -1.2, localY:  3.5, rarityColor: RARITY_COLORS.rare,   angle: -0.08 },
  { localX:  1.0, localY:  1.5, rarityColor: RARITY_COLORS.epic,   angle:  0.06 },
  { localX: -0.5, localY: -1.0, rarityColor: RARITY_COLORS.common, angle: -0.04 },
];

// ---------------------------------------------------------------------------
// Plank and post materials — warm coral/wood look with TSL
// ---------------------------------------------------------------------------
function createPlankMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = color(0x6b4c2a); // dark woody brown
  return mat;
}

function createPostMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = color(0x4a3520);
  return mat;
}

function createParchmentMaterial(rarityHex: number): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Subtle pulse so parchments appear to shimmer
  const pulse = sin(time.mul(float(1.8))).mul(float(0.12)).add(float(0.88));
  const baseCol = color(rarityHex);
  // Mix rarity color into a parchment cream base
  const cream = color(0xf5e6c8);
  mat.colorNode = mix(cream, baseCol, float(0.35)).mul(pulse);
  mat.opacity = 0.92;
  return mat;
}

// ---------------------------------------------------------------------------
// Parchment plane component
// ---------------------------------------------------------------------------
function Parchment({ def }: { def: ParchmentDef }) {
  const material = useMemo(() => createParchmentMaterial(def.rarityColor), [def.rarityColor]);

  return (
    <mesh
      position={[def.localX, def.localY, 0.16]}
      rotation={[0, 0, def.angle]}
      material={material}
    >
      <planeGeometry args={[2.8, 2.0]} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Full board
// ---------------------------------------------------------------------------
const BountyBoardInner = memo(function BountyBoardInner() {
  const groupRef = useRef<THREE.Group>(null!);

  const plankMat = useMemo(() => createPlankMaterial(), []);
  const postMat  = useMemo(() => createPostMaterial(), []);

  const openBountyBoard = () => useGameStore.getState().openBountyBoard();

  // Gentle sway — the notice board shifts slightly in the "current"
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    groupRef.current.rotation.z = Math.sin(clock.elapsedTime * 0.6 + 1.1) * 0.02;
  });

  return (
    <group
      position={[BOARD_X, BOARD_Y, BOARD_Z]}
      onClick={(e) => {
        e.stopPropagation();
        openBountyBoard();
      }}
      onPointerEnter={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerLeave={(e) => {
        e.stopPropagation();
        document.body.style.cursor = 'auto';
      }}
    >
      {/* Left post */}
      <mesh position={[-5.5, 8, 0]} material={postMat}>
        <boxGeometry args={[1.2, 18, 1.2]} />
      </mesh>
      {/* Right post */}
      <mesh position={[5.5, 8, 0]} material={postMat}>
        <boxGeometry args={[1.2, 18, 1.2]} />
      </mesh>

      {/* Main plank board */}
      <group ref={groupRef}>
        <mesh position={[0, 9, 0]} material={plankMat}>
          <boxGeometry args={[13, 14, 1.0]} />
        </mesh>
        {/* Parchment notes pinned to the board */}
        {PARCHMENTS.map((def, i) => (
          <Parchment key={i} def={def} />
        ))}
      </group>

      {/* Top cross-bar */}
      <mesh position={[0, 17, 0]} material={postMat}>
        <boxGeometry args={[14, 1.5, 1.2]} />
      </mesh>

      {/* Invisible click volume for easier interaction */}
      <mesh visible={false} position={[0, 8, 0]}>
        <boxGeometry args={[16, 20, 4]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
});

export default function BountyBoardObject() {
  return <BountyBoardInner />;
}
