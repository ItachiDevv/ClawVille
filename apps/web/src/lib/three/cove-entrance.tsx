'use client';

/**
 * CoveEntrance — prominent glowing portal/tunnel at the +X (town-facing, east) base
 * of the cove pyramid. Gives players a VISIBLE walk-in doorway.
 *
 * Second-pass visual upgrade (cove-fix-pass2-2026-06-20):
 *   - Torus arch: radius 90 → 175, tube 14 → 26 — prominent doorway scale.
 *   - Arch center Y = 150: arch spans ~Y=−26 to Y=326 — reads as a real doorway from ground.
 *   - Tunnel: radius 75 → 150, length 140 → 180, BackSide bright inner walls.
 *   - Ground threshold pad: RingGeometry additive cyan disc at Y≈0.
 *   - Larger "ENTER ▸" label: 260×80 wu.
 *   - 2 PointLights unchanged (budget already accounted for).
 *
 * Positioning:
 *   Cove zone center: world (-4160, 0, 0).
 *   Building rotY = π/2 → faces +X (east/town). Half-footprint ≈ 650 wu.
 *   Portal group at world (-3510, 0, 0) = east face of pyramid.
 *   All children positioned relative to this group.
 *
 * Iris Xe invariants (kill-the-build):
 *   - NO drei <Text>/<Billboard> — hard crash. Text baked into CanvasTexture.
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash.
 *   - NO per-frame `new Vector3()`. All scratch is module-scope.
 *   - All geometry and materials are module-scope singletons.
 *   - AdditiveBlending on threshold pad (safe — MeshBasicMaterial, no ShaderMaterial).
 *
 * Point-light budget (unchanged from pass 1):
 *   World3DCanvas: 1 hemi (free) + 2 directional
 *   CoveBeacon:    3 point lights
 *   CoveEntrance:  2 point lights
 *   Total points:  5 — below Iris Xe hard limit of 7.
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { triggerCoveWalkIn } from './arena-buildings';

// ---------------------------------------------------------------------------
// World position
// ---------------------------------------------------------------------------
const COVE_WORLD_X = -9216 + 158 * 32; // -4160 wu
const COVE_WORLD_Z = -9216 + 288 * 32; // 0 wu

// East (+X) face of the cove pyramid.
// Half-footprint: X-dim 1284/2 = 642 wu from center → east face at -4160+642 = -3518.
// We place the group at -3510 (≈ flush with east wall, visually at the doorstep).
const PORTAL_X = COVE_WORLD_X + 650; // -3510 wu

// ---------------------------------------------------------------------------
// Arch/tunnel dimensions (pass 2 — enlarged for prominence)
// ---------------------------------------------------------------------------
const ARCH_RING_RADIUS = 175; // wu — was 90. Prominent doorway-scale torus.
const ARCH_TUBE_RADIUS = 26;  // wu — was 14. Chunky glowing tube.
const ARCH_CENTER_Y    = 150; // wu — arch ring center above ground.
                               //       Arch spans Y = 150-175 = -25 to 150+175 = 325.
                               //       Reads as a real walk-in doorway from Y=0.
const TUNNEL_RADIUS    = 150; // wu — was 75. Matches new arch inner radius.
const TUNNEL_LENGTH    = 180; // wu — was 140. Deeper glowing throat.

// Label plate above arch
const LABEL_W = 260; // wu — was 180
const LABEL_H = 80;  // wu — was 56
const LABEL_ABOVE_ARCH = ARCH_CENTER_Y + ARCH_RING_RADIUS + 50; // = 375 wu — above arch top

// ---------------------------------------------------------------------------
// "ENTER ▸" CanvasTexture — baked once at module load (SSR-guarded).
// ---------------------------------------------------------------------------
function buildEnterTexture(): THREE.CanvasTexture {
  const W = 512, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Dark background
  ctx.fillStyle = '#020d1a';
  ctx.fillRect(0, 0, W, H);

  // Cyan border — double border for impact
  ctx.strokeStyle = '#00ffee';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, W - 8, H - 8);
  ctx.strokeStyle = 'rgba(0,255,238,0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, W - 24, H - 24);

  // Main text — large, glowing
  ctx.shadowColor = '#00ffee';
  ctx.shadowBlur = 20;
  ctx.font = 'bold 64px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00ffe7';
  ctx.fillText('ENTER ▸', W / 2, 86);

  // Bright center pass
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('ENTER ▸', W / 2, 86);

  ctx.shadowBlur = 0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Module-scope geometry and materials — never recreated per render.
// ---------------------------------------------------------------------------

// Main arch torus. Default torus ring-plane is XY, hole faces +Z.
// Rotate 90° around Z in JSX → hole faces +X (toward town).
const _archGeo = new THREE.TorusGeometry(ARCH_RING_RADIUS, ARCH_TUBE_RADIUS, 20, 64);
const _archMat = new THREE.MeshBasicMaterial({
  color: 0x00ffee,
  toneMapped: false, // stay bright under underwater tone mapping
});

// Inner glow ring — slightly larger, pulsing transparent overlay.
const _archGlowGeo = new THREE.TorusGeometry(ARCH_RING_RADIUS + 14, 10, 12, 64);
const _archGlowMat = new THREE.MeshBasicMaterial({
  color: 0x00ccff,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false,
});

// Outer halo ring — even larger, very faint
const _archHaloGeo = new THREE.TorusGeometry(ARCH_RING_RADIUS + 35, 8, 8, 64);
const _archHaloMat = new THREE.MeshBasicMaterial({
  color: 0x0044aa,
  transparent: true,
  opacity: 0.2,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
});

// Open-ended tunnel barrel. Cylinder axis is +Y; rotate 90° around Z → axis aligns with +X.
// BackSide: player approaching from +X sees the glowing inner walls.
const _tunnelGeo = new THREE.CylinderGeometry(
  TUNNEL_RADIUS, TUNNEL_RADIUS, TUNNEL_LENGTH,
  48,   // radialSegments — smoother at this scale
  1,
  true, // openEnded
);
const _tunnelMat = new THREE.MeshBasicMaterial({
  color: 0x00aacc,
  transparent: true,
  opacity: 0.60,
  depthWrite: false,
  side: THREE.BackSide,
  toneMapped: false,
});

// Ground threshold pad — flat ring/disc at Y≈0 glowing under the arch.
// RingGeometry(innerRadius, outerRadius, thetaSegments) — flat in XZ by default (normal +Y).
// No rotation needed; lies flat on the ground.
const _padGeo = new THREE.RingGeometry(30, ARCH_RING_RADIUS, 48);
const _padMat = new THREE.MeshBasicMaterial({
  color: 0x00ffee,
  transparent: true,
  opacity: 0.25,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide, // visible from below too
  toneMapped: false,
});

// "ENTER ▸" label plate above arch
const _labelGeo  = new THREE.PlaneGeometry(LABEL_W, LABEL_H);
const _labelMat  = new THREE.MeshBasicMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});
if (typeof document !== 'undefined') {
  _labelMat.map = buildEnterTexture();
}

// Label backing
const _labelBackGeo = new THREE.BoxGeometry(LABEL_W + 14, LABEL_H + 14, 3);
const _labelBackMat = new THREE.MeshBasicMaterial({ color: 0x01080f });

// ---------------------------------------------------------------------------
// CoveEntrance component
// ---------------------------------------------------------------------------
export default function CoveEntrance() {
  // labelRef: Y position driven by useFrame float
  const labelRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;

    // Pulse inner glow ring opacity — module-scope material, no alloc
    _archGlowMat.opacity = 0.25 + 0.22 * Math.sin(t * 1.6);

    // Pulse outer halo even more slowly
    _archHaloMat.opacity = 0.10 + 0.12 * Math.sin(t * 0.9 + 1.0);

    // Pulse threshold pad
    _padMat.opacity = 0.18 + 0.12 * Math.sin(t * 2.0);

    // Gentle vertical float on label (±5 wu)
    if (labelRef.current) {
      labelRef.current.position.y = LABEL_ABOVE_ARCH + Math.sin(t * 0.85) * 5;
    }
  });

  return (
    <group
      position={[PORTAL_X, 0, COVE_WORLD_Z]}
      name="cove-entrance"
      userData={{ perfChunk: 'cove-entrance' }}
    >
      {/* Ground threshold pad — flat additive ring glowing on the ground under the arch.
          RingGeometry is flat in XZ by default (no rotation needed). */}
      <mesh
        geometry={_padGeo}
        material={_padMat}
        position={[0, 2, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      />

      {/* Main archway torus.
          TorusGeometry default: ring-plane is XY, hole faces +Z.
          rotate 90° around Y → ring-plane becomes YZ, hole faces +X (toward town).
          (rotation.z would keep the hole on +Z and show a thin sliver from +X approach.)
          Center at Y = ARCH_CENTER_Y = 150 so the arch base is near Y=0.
          Arch spans Y = 150-175 = -25 (underground) to 150+175 = 325. */}
      <mesh
        geometry={_archGeo}
        material={_archMat}
        rotation={[0, Math.PI / 2, 0]}
        position={[0, ARCH_CENTER_Y, 0]}
      />

      {/* Inner glow ring — pulsing via useFrame opacity. Same Y-rotation fix. */}
      <mesh
        geometry={_archGlowGeo}
        material={_archGlowMat}
        rotation={[0, Math.PI / 2, 0]}
        position={[0, ARCH_CENTER_Y, 0]}
      />

      {/* Outer halo ring. Same Y-rotation fix. */}
      <mesh
        geometry={_archHaloGeo}
        material={_archHaloMat}
        rotation={[0, Math.PI / 2, 0]}
        position={[0, ARCH_CENTER_Y, 0]}
      />

      {/* Open-ended tunnel barrel.
          CylinderGeometry axis is +Y; rotate 90° around Z → axis aligns with +X.
          This is CORRECT for a cylinder (Z-rotation tilts the barrel axis into +X).
          Center at ARCH_CENTER_Y = 150. BackSide = player sees glowing inner walls. */}
      <mesh
        geometry={_tunnelGeo}
        material={_tunnelMat}
        rotation={[0, 0, Math.PI / 2]}
        position={[0, ARCH_CENTER_Y, 0]}
      />

      {/* "ENTER ▸" label plate — above the arch.
          Label faces +X (same rotation as the arch group).
          Position X offset: slightly east of group center for visibility.
          Y driven by useFrame float. */}
      <mesh
        geometry={_labelBackGeo}
        material={_labelBackMat}
        rotation={[0, Math.PI / 2, 0]}
        position={[0, LABEL_ABOVE_ARCH, 0]}
      />
      <mesh
        ref={labelRef}
        geometry={_labelGeo}
        material={_labelMat}
        rotation={[0, Math.PI / 2, 0]}
        position={[2, LABEL_ABOVE_ARCH, 0]}
      />

      {/* Invisible raycastable click target — covers the arch opening.
          Using colorWrite:false (not visible:false — visible:false removes from raycast tree).
          240×340×240 wu box centered on the arch mouth. Clicking here fires triggerCoveWalkIn.
          onPointerOver/Out: cursor pointer feedback for discoverability. */}
      <mesh
        position={[0, ARCH_CENTER_Y, 0]}
        onClick={(e) => { e.stopPropagation(); triggerCoveWalkIn(); }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      >
        <boxGeometry args={[240, 340, 240]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>

      {/* Portal glow point lights — 2 total, budget unchanged (total scene = 5 point lights).
          Positioned at arch center height, east of the group origin (toward town). */}
      <pointLight
        color={0x00ddff}
        intensity={2.5}
        distance={700}
        decay={2}
        position={[80, ARCH_CENTER_Y, 0]}
      />
      <pointLight
        color={0xaa00ff}
        intensity={1.4}
        distance={500}
        decay={2}
        position={[-60, ARCH_CENTER_Y, 0]}
      />
    </group>
  );
}
