'use client';

/**
 * BumperShellsArena.tsx
 *
 * PERF FIX 2026-04-24: import from 'three' (not 'three/webgpu') — R3F Canvas
 * uses WebGLRenderer. Two-THREE-instances crash = GPU context loss.
 * See gotchas/two-three-instances-nodemat-webgl-crash.md
 *
 * Also removed: 4 rim accent point lights (each was a full lighting pass per
 * fragment), danger ring downgraded to MeshBasicMaterial (zero lighting cost),
 * stars reduced 300→60.
 *
 * Draw calls: 7
 *   platform (1) + tile overlay (1) + rim torus (1) + bumper wall (1) +
 *   danger ring (1) + void backdrop (1) + starfield (1)
 *   [4 rim point lights REMOVED — were causing GPU context loss on Iris Xe]
 *
 * Iris Xe invariants:
 *   - import from 'three' (plain WebGLRenderer) — NOT 'three/webgpu'.
 *   - MeshStandardMaterial for lit surfaces; MeshBasicMaterial for unlit.
 *   - NO ShaderMaterial, NO castShadow (shadow pipeline disabled).
 *   - matrixAutoUpdate=false on every static mesh after mount.
 *   - No per-frame allocations — module-scope elapsed only.
 */

import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
// PERF FIX 2026-04-24: import from 'three' not 'three/webgpu'.
// R3F Canvas uses WebGLRenderer (plain 'three'). Mixing two THREE instances
// causes per-frame NodeMaterial.vertexShader crash → GPU context loss.
// See gotchas/two-three-instances-nodemat-webgl-crash.md
import * as THREE from 'three';
import {
  ARENA_RADIUS,
  ARENA_HEIGHT,
  ARENA_RADIAL_SEGMENTS,
  RIM_TUBE_RADIUS,
  RIM_RADIAL_SEGMENTS,
  RIM_TUBULAR_SEGMENTS,
  BUMPER_WALL_TUBE_RADIUS,
  BUMPER_WALL_HEIGHT,
  VOID_BACKDROP_Y,
  VOID_BACKDROP_SIZE,
  STAR_COUNT,
  STAR_RADIUS,
  STAR_Y_MIN,
  STAR_Y_MAX,
} from './bumper-shells-config';

// ─── Module-scope scratch ──────────────────────────────────────────────────
let _arenaElapsed = 0;

// ─── Geometry singletons (module scope) ───────────────────────────────────

const platformGeo = new THREE.CylinderGeometry(
  ARENA_RADIUS,
  ARENA_RADIUS * 0.96, // slight bevel at base
  ARENA_HEIGHT,
  ARENA_RADIAL_SEGMENTS,
  2,
);

const tileOverlayGeo = new THREE.PlaneGeometry(
  ARENA_RADIUS * 2,
  ARENA_RADIUS * 2,
  12,  // was 20×20; 12×12 saves ~375 verts at no perceptible quality loss
  12,
);

const rimGeo = new THREE.TorusGeometry(
  ARENA_RADIUS,
  RIM_TUBE_RADIUS,
  RIM_RADIAL_SEGMENTS,
  RIM_TUBULAR_SEGMENTS,
);

const bumperWallGeo = new THREE.TorusGeometry(
  ARENA_RADIUS - BUMPER_WALL_TUBE_RADIUS * 0.5,
  BUMPER_WALL_TUBE_RADIUS,
  8,   // was 12; slight facet at chase cam distance is invisible
  RIM_TUBULAR_SEGMENTS,
);

const dangerGeo = new THREE.CylinderGeometry(
  ARENA_RADIUS,
  ARENA_RADIUS,
  6,
  ARENA_RADIAL_SEGMENTS,
  1,
  false,
);

const voidGeo = new THREE.PlaneGeometry(VOID_BACKDROP_SIZE, VOID_BACKDROP_SIZE);

// Starfield: deterministic placement, no Math.random() at module scope (reproducible)
const starGeo = (() => {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const angle = (i / STAR_COUNT) * Math.PI * 2 + i * 2.399;
    const r = STAR_RADIUS * (0.25 + (((i * 6271) % 1000) / 1000) * 0.75);
    pos[i * 3 + 0] = Math.cos(angle) * r;
    pos[i * 3 + 1] = STAR_Y_MIN + (((i * 3491) % 1000) / 1000) * (STAR_Y_MAX - STAR_Y_MIN);
    pos[i * 3 + 2] = Math.sin(angle) * r;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return geo;
})();

// ─── Materials ─────────────────────────────────────────────────────────────

const platformMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#0d2235'),
  roughness: 0.9,
  metalness: 0.05,
});

const tileOverlayMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#122840'),
  roughness: 0.95,
  metalness: 0.0,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});

const rimMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color('#00ccff'),
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  opacity: 0.8,
});

const bumperWallMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color('#3a4a5a'),
  roughness: 0.3,
  metalness: 0.8,
  emissive: new THREE.Color('#001a33'),
  emissiveIntensity: 0.3,
});

// PERF FIX: MeshBasicMaterial — zero lighting cost vs. MeshStandardMaterial
// which requires a full PBR evaluation per fragment. Danger zone is additive
// so it still reads as "glowing red" without needing emissiveIntensity.
const dangerMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color('#cc0000'),
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

const voidMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color('#010205'),
  side: THREE.DoubleSide,
});

const starMat = new THREE.PointsMaterial({
  color: new THREE.Color('#cce0ff'),
  size: 3.5,
  sizeAttenuation: true,
  transparent: true,
  opacity: 0.7,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

export default function BumperShellsArena() {
  const platformRef = useRef<THREE.Mesh>(null);
  const tileRef     = useRef<THREE.Mesh>(null);
  const rimRef      = useRef<THREE.Mesh>(null);
  const bumperRef   = useRef<THREE.Mesh>(null);
  const dangerRef   = useRef<THREE.Mesh>(null);
  const voidRef     = useRef<THREE.Mesh>(null);
  const starsRef    = useRef<THREE.Points>(null);

  // Freeze all static matrices once after mount
  useEffect(() => {
    const objs: Array<THREE.Object3D | null> = [
      platformRef.current, tileRef.current, rimRef.current,
      bumperRef.current, dangerRef.current, voidRef.current, starsRef.current,
    ];
    for (const o of objs) {
      if (!o) continue;
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    }
  }, []);

  // Rim pulse + danger throb — only opacity mutations on BasicMaterial, no allocs
  useFrame((_, delta) => {
    _arenaElapsed += delta;

    const rim = rimRef.current;
    if (rim) {
      (rim.material as THREE.MeshBasicMaterial).opacity =
        Math.sin(_arenaElapsed * 2.2) * 0.25 + 0.65;
    }

    const danger = dangerRef.current;
    if (danger) {
      // MeshBasicMaterial: pulse opacity instead of emissiveIntensity
      (danger.material as THREE.MeshBasicMaterial).opacity =
        Math.sin(_arenaElapsed * 3.5) * 0.2 + 0.5;
    }
  });

  const discTopY = ARENA_HEIGHT / 2;

  return (
    <group>
      {/* Platform disc with beveled base — no shadows (shadow pipeline disabled) */}
      <mesh
        ref={platformRef}
        geometry={platformGeo}
        material={platformMat}
        castShadow={false}
        receiveShadow={false}
        frustumCulled={false}
      />

      {/* Tile overlay on top of disc */}
      <mesh
        ref={tileRef}
        geometry={tileOverlayGeo}
        material={tileOverlayMat}
        position={[0, discTopY + 0.5, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled={false}
      />

      {/* Rim glow torus — additive cyan, pulsing */}
      <mesh
        ref={rimRef}
        geometry={rimGeo}
        material={rimMat}
        position={[0, discTopY, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        frustumCulled={false}
      />

      {/* Bumper wall — metallic guardrail, no shadow */}
      <mesh
        ref={bumperRef}
        geometry={bumperWallGeo}
        material={bumperWallMat}
        position={[0, discTopY + BUMPER_WALL_HEIGHT * 0.5, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled={false}
      />

      {/* Danger zone ring — outer 15%, additive red pulse via MeshBasicMaterial */}
      <mesh
        ref={dangerRef}
        geometry={dangerGeo}
        material={dangerMat}
        position={[0, discTopY + 2, 0]}
        frustumCulled={false}
      />

      {/* Void backdrop far below */}
      <mesh
        ref={voidRef}
        geometry={voidGeo}
        material={voidMat}
        position={[0, VOID_BACKDROP_Y, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        frustumCulled={false}
      />

      {/* Starfield — 60 scattered points below the disc, 1 draw call (was 300) */}
      <points
        ref={starsRef}
        geometry={starGeo}
        material={starMat}
        frustumCulled={false}
      />
    </group>
  );
}
