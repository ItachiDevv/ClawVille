'use client';

/**
 * CoveBeacon — animated "THE COVE" neon marquee sign + glow ring above the
 * cove building.
 *
 * Design:
 *   - Flat CanvasTexture plane with neon-sign text (NO drei Text — Iris Xe crash).
 *   - Slow-rotating ring of MeshBasicMaterial planes (light-column effect) below
 *     the sign board — pure geometry, no ShaderMaterial (WebGPU crash guard).
 *   - Three PointLights (soft magenta/cyan/gold) for a casino-glow atmosphere.
 *   - All geometry and materials are module-scope singletons — never recreated
 *     per render. useFrame uses only primitive refs, zero per-frame allocations.
 *
 * Positioning:
 *   Cove zone world position is FIXED at worldX=-4160, worldZ=0 wu.
 *   These are world-absolute values (R=130t building ring, 130 tiles west of origin).
 *   The old tile-index form (-9216+158*32) was relative to the 576-tile grid center
 *   (288); after the 576→704 grow the center shifted to 352 so those indices are
 *   stale — the world-absolute constants below are grow-proof.
 *
 *   The cove GLB (cove-exterior-opt1.glb) is a near-cube:
 *     raw bbox ≈ 50.78 × 49.52 × 51.42 native units, max dim 51.42.
 *     targetMaxDim=1300 → scale≈25.28 → rendered 1284(x) × 1252(y) × 1300(z) wu.
 *     Building floor at world Y≈-2, APEX at world Y≈1250.
 *   Therefore all beacon geometry MUST be above Y=1250 to avoid pyramid occlusion.
 *
 *   SIGN_Y = 1480: marquee board center 230 wu above apex (1480 - 1250 = 230). ✓
 *   RING_Y = 1300: glow ring 50 wu above apex (1300 - 1250 = 50). ✓
 *   Point lights follow RING_Y offsets so they also stay above the pyramid.
 *
 * Iris Xe invariants (kill-the-build):
 *   - NO drei <Text> / <Billboard> — both crash Iris Xe. Text is baked into a
 *     CanvasTexture and applied via MeshBasicMaterial.
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash.
 *   - NO per-frame `new Vector3()` — GC thrash. All scratch objects module-scope.
 *   - NO new allocations inside useFrame — only ref reads and primitive math.
 *
 * town-ux-2026-06-20 (beacon raised above pyramid + portal entrance)
 */

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// World position of the cove beacon — world-absolute, grow-proof.
// Cove zone center: R=130t building ring, 130 tiles west of origin = -4160wu.
// Do NOT re-express as -MAP_WIDTH/2 + tile*TILE_SIZE: the tile index (158) was
// relative to the 576-tile grid center (288); after the 576→704 grow that form
// would compute -11264 + 5056 = -6208wu (wrong). The world position is fixed.
// ---------------------------------------------------------------------------
const BEACON_WORLD_X = -4160; // wu — world-absolute; cove zone, 130 tiles W of origin
const BEACON_WORLD_Z = 0;     // wu — world-absolute; cove zone center-Z

// Cove pyramid dimensions (verified from GLB bbox + arena-buildings.tsx config):
//   targetMaxDim=1300, raw bbox max dim 51.42 → scale≈25.28
//   Rendered: ~1284(x) × 1252(y) × 1300(z) wu. Building floor Y≈-2, APEX Y≈1250.
// All geometry below must sit ABOVE Y=1250 to avoid occlusion by the pyramid walls.
//
// SIGN_Y=1480: marquee board center 230 wu above apex → visibly floating above tip.
// RING_Y=1330: glow ring 80 wu above apex → ring bottom (1330-90=1240) stays above apex 1250. ✓
// Point lights re-derived from RING_Y so they follow if these values change.
const COVE_APEX_Y  = 1250; // world-space apex of the cove pyramid
const SIGN_Y       = 1480; // marquee board Y — 230 wu above apex (was 870, occluded)
const RING_Y       = 1330; // glow ring Y  —  80 wu above apex (was 1300→1250 bottom-ring dips at radius 90)
const RING_RADIUS  = 90;   // wu
const RING_COUNT   = 10;   // spokes in the light ring

// ---------------------------------------------------------------------------
// CanvasTexture for the neon marquee board — baked once at module load.
// ---------------------------------------------------------------------------
function buildMarqueeTexture(): THREE.CanvasTexture {
  const W = 512, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Background — deep indigo, matches casino atmosphere
  ctx.fillStyle = '#05071a';
  ctx.fillRect(0, 0, W, H);

  // Neon border
  ctx.strokeStyle = '#f0a500';
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, W - 8, H - 8);

  // Neon inner glow (second pass, thinner)
  ctx.strokeStyle = 'rgba(255,200,50,0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, W - 20, H - 20);

  // Corner diamonds
  for (const [cx, cy] of [[16, 16], [W - 16, 16], [16, H - 16], [W - 16, H - 16]] as [number,number][]) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#f0a500';
    ctx.fillRect(-5, -5, 10, 10);
    ctx.restore();
  }

  // Subtitle
  ctx.font = 'bold 14px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(180,220,255,0.8)';
  ctx.fillText('✦  PREDICTIVE GAMING  ✦', W / 2, 28);

  // Main neon text — cyan glow
  ctx.shadowColor = '#00ffee';
  ctx.shadowBlur = 18;
  ctx.font = 'bold 52px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00ffe7';
  ctx.fillText('THE COVE', W / 2, 90);

  // Second pass for brighter center (stronger glow)
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('THE COVE', W / 2, 90);

  ctx.shadowBlur = 0;

  // Bottom tagline
  ctx.font = '12px Arial, sans-serif';
  ctx.fillStyle = 'rgba(180,220,255,0.65)';
  ctx.fillText('🎰  CLAWTOKEN STAKES  🎰', W / 2, H - 10);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Module-scope geometry and materials — never recreated per render.
// ---------------------------------------------------------------------------
// Board scaled up ~2.1× total for visibility from ~2600 wu approach distance.
// IMPORTANT: sign and board have rotation.y = π/2 in JSX so the readable face
// points +X (toward town). A +Z-facing plane is an invisible sliver from +X.
//   Width: 665 wu (was 320, then 512). Height: 169 wu (was 80, then 130).
const _marqueeGeo  = new THREE.PlaneGeometry(665, 169);
const _marqueeMat  = new THREE.MeshBasicMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});
if (typeof document !== 'undefined') {
  _marqueeMat.map = buildMarqueeTexture();
}

// Board backing — matches enlarged sign
const _boardGeo  = new THREE.BoxGeometry(681, 185, 4);
const _boardMat  = new THREE.MeshBasicMaterial({ color: 0x03050f });

// ---------------------------------------------------------------------------
// Vertical light beam — tall glowing cylinder rising from apex into sky.
// Omni-directional: no facing problem, visible from across the map.
// AdditiveBlending: layered over the sky without alpha-sorting issues.
// MUST be module-scope (not recreated per render).
// Beam spans Y=1250 (apex) to Y=2750, center at Y=2000, height=1500.
// ---------------------------------------------------------------------------
const _beamGeo = new THREE.CylinderGeometry(
  35, 35, 1500,
  12,  // radialSegments (low poly — sky cylinder, not close-up)
  1,   // heightSegments
  true, // openEnded — no caps
);
const _beamMat = new THREE.MeshBasicMaterial({
  color: 0x00ffff,
  transparent: true,
  opacity: 0.45,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false, // stay bright under underwater tone mapping
});

// Wider fainter halo beam
const _beamHaloGeo = new THREE.CylinderGeometry(
  80, 80, 1500,
  12,
  1,
  true,
);
const _beamHaloMat = new THREE.MeshBasicMaterial({
  color: 0x0088ff,
  transparent: true,
  opacity: 0.18,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false,
});

// Support pole — extended from ground (Y=0) to well above RING_Y.
// Pole height = RING_Y + 120 = 1420, centered at Y = 710.
// The pole group.position.y offsets place it at (RING_Y + 120) / 2 above Y=0.
// We derive height at module scope using the constants.
const _POLE_HEIGHT = RING_Y + 120; // 1420 wu — ground to above ring
const _poleGeo  = new THREE.CylinderGeometry(4, 8, _POLE_HEIGHT, 6);
const _poleMat  = new THREE.MeshBasicMaterial({ color: 0x2a2050 });

// Glow ring spokes — thin flat planes, no ShaderMaterial
const _spokeGeo = new THREE.PlaneGeometry(6, 120);
const _spokeMat = new THREE.MeshBasicMaterial({
  color: 0xff55aa,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
  side: THREE.DoubleSide,
});

// ---------------------------------------------------------------------------
// CoveBeacon component
// ---------------------------------------------------------------------------
export default function CoveBeacon() {
  const ringRef = useRef<THREE.Group>(null);
  const signRef = useRef<THREE.Mesh>(null);

  // Pre-compute spoke positions once (no per-frame alloc).
  const spokeAngles = useMemo(
    () => Array.from({ length: RING_COUNT }, (_, i) => (i / RING_COUNT) * Math.PI * 2),
    [],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;

    // Rotate the glow ring slowly.
    if (ringRef.current) {
      ringRef.current.rotation.y = t * 0.18;
    }

    // Gentle vertical float on the sign board (±8 wu).
    if (signRef.current) {
      signRef.current.position.y = SIGN_Y + Math.sin(t * 0.7) * 8;
    }

    // Pulse the spoke opacity (module-scope material ref, no alloc).
    _spokeMat.opacity = 0.25 + 0.15 * Math.sin(t * 1.4);
  });

  return (
    <group
      position={[BEACON_WORLD_X, 0, BEACON_WORLD_Z]}
      name="cove-beacon"
      userData={{ perfChunk: 'cove-beacon' }}
    >
      {/* Support pole — tall pylon from ground (Y≈0) to above RING_Y.
          Pole center Y = _POLE_HEIGHT / 2 so the base sits at world Y=0.
          At 1420 wu height this reads as a tall lit pylon from ~4160 wu camera distance. */}
      <mesh
        geometry={_poleGeo}
        material={_poleMat}
        position={[0, _POLE_HEIGHT / 2, 0]}
      />

      {/* Marquee sign board.
          Default PlaneGeometry faces +Z; rotating 90° around Y makes it face +X (toward town).
          Without this rotation the sign is edge-on from the town approach — invisible sliver.
          Board width: 665 wu. Height: 169 wu (2.1× original).
          useFrame float: position.y = SIGN_Y + sin(t)*8 — reassigned each frame on signRef. */}
      <group rotation={[0, Math.PI / 2, 0]}>
        <mesh
          geometry={_boardGeo}
          material={_boardMat}
          position={[0, SIGN_Y, 0]}
        />
        <mesh
          ref={signRef}
          geometry={_marqueeGeo}
          material={_marqueeMat}
          position={[0, SIGN_Y, 3]}
        />
      </group>

      {/* Vertical sky beam — tall glowing cylinders rising from apex (~Y=1250) into sky.
          Omni-directional: visible from all approach angles, no facing problem.
          Spans Y=1250 to Y=2750, center at Y=2000. AdditiveBlending (no alpha sort).
          Two cylinders: narrow bright core (r=35) + wide faint halo (r=80). */}
      <mesh
        geometry={_beamGeo}
        material={_beamMat}
        position={[0, 2000, 0]}
      />
      <mesh
        geometry={_beamHaloGeo}
        material={_beamHaloMat}
        position={[0, 2000, 0]}
      />

      {/* Rotating glow ring — now 50 wu above pyramid apex (1300 - 1250 = 50).
          Apex is at ~Y=1250; RING_Y=1300 clears it. */}
      <group ref={ringRef} position={[0, RING_Y, 0]}>
        {spokeAngles.map((angle, i) => (
          <mesh
            key={i}
            geometry={_spokeGeo}
            material={_spokeMat}
            position={[
              Math.cos(angle) * RING_RADIUS,
              0,
              Math.sin(angle) * RING_RADIUS,
            ]}
            rotation={[0, -angle, 0]}
          />
        ))}
      </group>

      {/* Atmosphere lights — all positions derived from RING_Y so they move with constants.
          3 point lights total (unchanged from prior version — staying in budget).
          distance limits prevent bleeding to adjacent building slots (~2600 wu away). */}
      <pointLight
        color={0xff44cc}
        intensity={1.8}
        distance={1200}
        decay={2}
        position={[0, RING_Y + 80, 0]}
      />
      <pointLight
        color={0x00ccff}
        intensity={1.2}
        distance={800}
        decay={2}
        position={[80, RING_Y - 40, 80]}
      />
      <pointLight
        color={0xffaa00}
        intensity={0.9}
        distance={600}
        decay={2}
        position={[-80, RING_Y - 40, -80]}
      />
    </group>
  );
}
