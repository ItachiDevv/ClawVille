'use client';

/**
 * BazaarPedestals — world-surface anchor for the Skill Bazaar modal.
 *
 * 3 glowing cylindrical pedestals arranged in a semicircle in the village
 * center, north and left of dead center (further out on the 80x80 map).
 *
 * Each pedestal:
 *   - CylinderGeometry base with rarity-tinted TSL MeshBasicNodeMaterial
 *   - A floating icosahedron item silhouette above the top (rotates slowly)
 *   - AdditiveBlending on both so they add light without darkening surroundings
 *
 * Clicking ANY pedestal: useGameStore().openBazaar()
 *
 * Draw calls: 3 bases + 3 floating items = 6
 * GPU constraints: TSL only, no GLSL, no Text/Billboard, no InstancedMesh+ShaderMaterial
 */

import { useRef, useMemo, memo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { color, float, sin, time, mix } from 'three/tsl';
import { useGameStore } from '@/stores/game';

// ---------------------------------------------------------------------------
// World position — village center, further left and north for expanded map.
// Was (-30, -50); moved to (-50, -60) to spread town objects on 80x80 map.
// ---------------------------------------------------------------------------
const FORGE_CENTER_X = -50;
const FORGE_FRONT_Z  = -60; // north of dead center
const BASE_Y         = -2;

// ---------------------------------------------------------------------------
// Module-scope scratch (avoid per-frame allocation)
// ---------------------------------------------------------------------------
const _pedestalRotScratch = new THREE.Euler();

// ---------------------------------------------------------------------------
// Rarity colors from rarity.ts
// ---------------------------------------------------------------------------
const RARITY_HEX = {
  common:    0x9ca3af,
  rare:      0x3b82f6,
  epic:      0xa855f7,
} as const;

// Brighter emissive versions for additive glow
const GLOW_HEX = {
  common:    0xd1d5db,
  rare:      0x60a5fa,
  epic:      0xc084fc,
} as const;

// ---------------------------------------------------------------------------
// Pedestal definitions — 3 positions in a semicircle
// ---------------------------------------------------------------------------
interface PedestalDef {
  offsetX: number; // relative to FORGE_CENTER_X
  rarity: keyof typeof RARITY_HEX;
  phaseOffset: number; // for independent pulse timing
  itemRotSpeed: number;
}

const PEDESTALS: PedestalDef[] = [
  { offsetX: -28, rarity: 'common', phaseOffset: 0.0,  itemRotSpeed: 0.8 },
  { offsetX:   0, rarity: 'epic',   phaseOffset: 1.1,  itemRotSpeed: 1.2 },
  { offsetX:  28, rarity: 'rare',   phaseOffset: 2.2,  itemRotSpeed: 0.9 },
];

// ---------------------------------------------------------------------------
// Single pedestal + floating item
// ---------------------------------------------------------------------------
function Pedestal({ def }: { def: PedestalDef }) {
  const floatRef = useRef<THREE.Mesh>(null!);

  // Base cylinder material — emissive TSL, additive blending
  const baseMat = useMemo(() => {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pulse = sin(
      time.mul(float(1.6)).add(float(def.phaseOffset))
    ).mul(float(0.2)).add(float(0.8));
    mat.colorNode = color(GLOW_HEX[def.rarity]).mul(float(0.4)).mul(pulse);
    mat.opacity = 0.7;
    return mat;
  }, [def.rarity, def.phaseOffset]);

  // Solid base (not additive — keeps the physical look)
  const solidBaseMat = useMemo(() => {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = color(0x0a1e35);
    return mat;
  }, []);

  // Floating item material — full additive glow
  const itemMat = useMemo(() => {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pulse = sin(
      time.mul(float(2.2)).add(float(def.phaseOffset + 0.5))
    ).mul(float(0.35)).add(float(0.65));
    mat.colorNode = color(RARITY_HEX[def.rarity]).mul(pulse);
    mat.opacity = 0.85;
    return mat;
  }, [def.rarity, def.phaseOffset]);

  // Top glow disc material
  const topGlowMat = useMemo(() => {
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const pulse = sin(
      time.mul(float(1.4)).add(float(def.phaseOffset))
    ).mul(float(0.3)).add(float(0.7));
    mat.colorNode = color(GLOW_HEX[def.rarity]).mul(pulse);
    mat.opacity = 0.4;
    return mat;
  }, [def.rarity, def.phaseOffset]);

  useFrame(({ clock }) => {
    if (!floatRef.current) return;
    // Float item: bob up/down and spin
    const t = clock.elapsedTime;
    floatRef.current.rotation.y = t * def.itemRotSpeed;
    floatRef.current.position.y = 18 + Math.sin(t * 1.8 + def.phaseOffset) * 1.2;
  });

  const worldX = FORGE_CENTER_X + def.offsetX;

  return (
    <group
      position={[worldX, BASE_Y, FORGE_FRONT_Z]}
      onClick={(e) => {
        e.stopPropagation();
        useGameStore.getState().openBazaar();
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
      {/* Solid dark base cylinder */}
      <mesh position={[0, 5, 0]} material={solidBaseMat}>
        <cylinderGeometry args={[4, 5, 10, 16, 1]} />
      </mesh>

      {/* Emissive glow overlay (additive) — slightly larger, sits on top */}
      <mesh position={[0, 5.1, 0]} material={baseMat}>
        <cylinderGeometry args={[4.1, 5.1, 10.2, 16, 1]} />
      </mesh>

      {/* Top glow disc */}
      <mesh position={[0, 10.5, 0]} rotation={[Math.PI / 2, 0, 0]} material={topGlowMat}>
        <circleGeometry args={[4.5, 24]} />
      </mesh>

      {/* Floating item silhouette */}
      <mesh ref={floatRef} position={[0, 18, 0]} material={itemMat}>
        <icosahedronGeometry args={[3, 0]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
const BazaarPedestalsInner = memo(function BazaarPedestalsInner() {
  return (
    <group>
      {PEDESTALS.map((def, i) => (
        <Pedestal key={i} def={def} />
      ))}
    </group>
  );
});

export default function BazaarPedestals() {
  return <BazaarPedestalsInner />;
}
