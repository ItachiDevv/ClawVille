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
 *   Cove zone: id='cove', tile center cx=158, cy=288.
 *   worldX = -9216 + 158*32 = -4160
 *   worldZ = -9216 + 288*32 = 0
 *   The sign floats at Y≈900 (above the 1300 wu building), ring at Y≈650.
 *
 * Iris Xe invariants (kill-the-build):
 *   - NO drei <Text> / <Billboard> — both crash Iris Xe. Text is baked into a
 *     CanvasTexture and applied via MeshBasicMaterial.
 *   - NO InstancedMesh + ShaderMaterial — silent WebGPU crash.
 *   - NO per-frame `new Vector3()` — GC thrash. All scratch objects module-scope.
 *   - NO new allocations inside useFrame — only ref reads and primitive math.
 *
 * town-ux-2026-06-19
 */

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// World position of the cove beacon.
// Tile center cx=158, cy=288 (576×576 tile grid).
// Offset: HALF_MAP = 9216 wu.
// ---------------------------------------------------------------------------
const BEACON_WORLD_X = -9216 + 158 * 32; // -4160 wu
const BEACON_WORLD_Z = -9216 + 288 * 32; // 0 wu
const SIGN_Y       = 870;  // height above terrain — clear of building top
const RING_Y       = 620;  // glow ring base
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
const _marqueeGeo  = new THREE.PlaneGeometry(320, 80);
const _marqueeMat  = new THREE.MeshBasicMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
});
if (typeof document !== 'undefined') {
  _marqueeMat.map = buildMarqueeTexture();
}

// Board backing (dark panel behind the sign)
const _boardGeo  = new THREE.BoxGeometry(336, 96, 4);
const _boardMat  = new THREE.MeshBasicMaterial({ color: 0x03050f });

// Support pole
const _poleGeo  = new THREE.CylinderGeometry(4, 6, 400, 6);
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
      {/* Support pole — static, no animation */}
      <mesh
        geometry={_poleGeo}
        material={_poleMat}
        position={[0, RING_Y - 80, 0]}
      />

      {/* Marquee sign board */}
      <group>
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

      {/* Rotating glow ring */}
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

      {/* Atmosphere lights — kept very soft so they don't overpower the scene.
          Three.js point lights are per-fragment on WebGPU so 3 max.
          distance=1200 keeps them from bleeding to the next building slot
          (slots are ~2600 wu apart at ring R=4160). */}
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
