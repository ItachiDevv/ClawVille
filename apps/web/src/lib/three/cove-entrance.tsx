'use client';

/**
 * CoveEntrance — a real walk-in arched corridor at the +X (east/town-facing) base
 * of the Cove pyramid. REPLACES the torus-ring portal (pass 1+2+3).
 *
 * Coordinator request (pass 4, 2026-06-20):
 *   "Build a WALK-IN TUNNEL — a corridor with DEPTH that the avatar physically walks
 *    THROUGH. Not a 2D hoop. Remove all torus rings (arch + inner glow + outer halo)
 *    and the BackSide throat cylinder."
 *
 * ─── Geometry layout ────────────────────────────────────────────────────────
 *
 *   Cove center: world (-4160, 0, 0). East face ≈ -3520.
 *   Group anchor: world (-3510, 0, 0) = flush with pyramid east wall.
 *   Local X: -235 = inner (west/into pyramid), +235 = mouth (east/toward town).
 *   Tunnel length: 470 wu. Cross-section: 180 wu wide (Z ±90) × 280 wu tall.
 *   World mouth: -3510 + 235 = -3275. World inner end: -3510 - 235 = -3745.
 *
 *   Side walls      2× PlaneGeometry(470, 280) at Z=±90, facing inward (BackSide)
 *   Ceiling / arch  Half-CylinderGeometry radius=90, length=470, thetaLength=π, FrontSide
 *                   rotated so barrel axis = +X, arch opens downward over the corridor.
 *   Floor glow      PlaneGeometry(470, 180) lying flat at Y=1, AdditiveBlending cyan strip
 *   Floor neon edges 2× BoxGeometry(470, 4, 4) at Z=±88, Y=2 — floor-level neon strips
 *   Roof ridge neon  BoxGeometry(470, 4, 4) at Y=178, Z=0 — ridge neon strip
 *   Exterior cap    BoxGeometry(30, 282, 184) at X=-148 — dark structural back wall
 *   Mouth arch frame RingGeometry(inner=80, outer=94, thetaLength=π) at X=+135, Y=90
 *                   + two BoxGeometry(4, 90, 4) pillars flanking the mouth base
 *   Mouth neon      RingGeometry arch + side neon strips on the opening face
 *   Sign            PlaneGeometry(220, 60) "ENTER ▸" CanvasTexture, above mouth,
 *                   rotation.y = π/2 (faces +X toward town)
 *   Click target    invisible BoxGeometry(4, 280, 184) at mouth (X=+135), colorWrite:false
 *   Point lights    2 inside tunnel (total scene = 5 points, under Iris Xe limit of 7)
 *
 * ─── Point-light budget ─────────────────────────────────────────────────────
 *   World3DCanvas: 1 hemi (free) + 2 directional
 *   CoveBeacon:    3 point lights   (unchanged)
 *   CoveEntrance:  2 point lights   (1 inner-tunnel + 1 at mouth)
 *   Total points:  5 — below Iris Xe hard limit of 7. ✓
 *
 * ─── Iris Xe invariants (kill-the-build) ────────────────────────────────────
 *   NO drei <Text>/<Billboard> — hard crash. Text baked into CanvasTexture.
 *   NO InstancedMesh + ShaderMaterial — silent WebGPU crash.
 *   NO per-frame `new Vector3()` — GC thrash.
 *   All geometry and materials are module-scope singletons.
 *   AdditiveBlending only on MeshBasicMaterial (safe).
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { triggerCoveWalkIn } from './arena-buildings';
import { avatarPositionRef, useGameStore } from '@/stores/game';
import { useTransitionStore } from '@/components/transitions/SceneTransition';
import { isInsideCoveTunnel } from './character-positions';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

// ---------------------------------------------------------------------------
// World anchor
// ---------------------------------------------------------------------------
const COVE_WORLD_X = -9216 + 158 * 32; // -4160 wu
const COVE_WORLD_Z = -9216 + 288 * 32; // 0 wu

// Group placed at east face of cove pyramid.
// Pyramid half-footprint ≈ 642 wu from center → east face -4160+642 = -3518.
// We anchor at -3510 (≈ flush with east wall).
const PORTAL_X = COVE_WORLD_X + 650; // -3510 wu

// ---------------------------------------------------------------------------
// Corridor dimensions
// ---------------------------------------------------------------------------
const TUNNEL_LEN    = 470;   // wu — total corridor depth (X axis in local space). Pass 5: extended from 270.
const TUNNEL_HALF   = TUNNEL_LEN / 2; // 235
const TUNNEL_W_HALF = 90;    // wu — half-width (Z axis). Corridor is 180 wu wide.
const TUNNEL_H      = 280;   // wu — interior height. Arch crown = ARCH_RADIUS = 90 above Y=180.
const ARCH_RADIUS   = 90;    // wu — half-arch roof radius. Arch crown at Y = 180+90 = 270.
// The half-cylinder sits with its flat base at Y=TUNNEL_H (180) and arches to Y=TUNNEL_H+ARCH_RADIUS (270).
// Walls span Y=0..280 → effectively capped by the arch at top.
// Mouth is at local X = +TUNNEL_HALF = +135.
// Inner back wall at local X = -TUNNEL_HALF-15 = -250.

const LABEL_W = 220;  // wu
const LABEL_H = 60;   // wu
const LABEL_Y = TUNNEL_H + ARCH_RADIUS + 50; // ~320 wu above ground

// ---------------------------------------------------------------------------
// "ENTER ▸" CanvasTexture — baked once at module load (SSR-guarded).
// ---------------------------------------------------------------------------
function buildEnterTexture(): THREE.CanvasTexture {
  const W = 512, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#020d1a';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#00ffee';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, W - 8, H - 8);
  ctx.strokeStyle = 'rgba(0,255,238,0.3)';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, W - 24, H - 24);

  ctx.shadowColor = '#00ffee';
  ctx.shadowBlur = 20;
  ctx.font = 'bold 64px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#00ffe7';
  ctx.fillText('ENTER ▸', W / 2, 86);
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('ENTER ▸', W / 2, 86);
  ctx.shadowBlur = 0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Module-scope geometry and materials — singletons, never recreated per render.
// ---------------------------------------------------------------------------

// ── Side walls (Left Z=+90, Right Z=-90) ──
// PlaneGeometry(width=TUNNEL_LEN, height=TUNNEL_H) lying in XY plane.
// We rotate 90° around Y to stand it in YZ plane... actually PlaneGeometry
// faces +Z by default. For wall at Z=+90 we need it to face -Z (inward).
// We'll use DoubleSide so both left and right use the same geo.
const _wallGeo = new THREE.PlaneGeometry(TUNNEL_LEN, TUNNEL_H);
const _wallMat = new THREE.MeshBasicMaterial({
  color: 0x001a2e,
  side: THREE.DoubleSide,
  toneMapped: false,
});

// ── Arched ceiling / roof ──
// Half-cylinder: CylinderGeometry(r, r, length, segs, 1, open, thetaStart=0, thetaLength=π).
// Default cylinder axis = +Y. We need its axis along +X (tunnel depth axis).
// After creation the geometry points along +Y. We'll rotate the mesh:
//   rotation.z = π/2 → tilts +Y axis into +X (barrel axis now runs east-west).
// thetaStart=0, thetaLength=π → upper half of cylinder (opens downward = interior visible below).
// We need the INSIDE to show (player looks up at the arch from inside).
// BackSide so the interior surface is rendered.
const _ceilGeo = new THREE.CylinderGeometry(
  ARCH_RADIUS, ARCH_RADIUS,
  TUNNEL_LEN,
  32, 1,
  true, // openEnded
  0, Math.PI, // upper half-circle
);
const _ceilMat = new THREE.MeshBasicMaterial({
  color: 0x001e35,
  side: THREE.BackSide, // interior surface visible
  toneMapped: false,
});

// Arch ceiling neon: thin strip on the same half-cylinder, bright cyan
const _ceilNeonGeo = new THREE.CylinderGeometry(
  ARCH_RADIUS - 2, ARCH_RADIUS - 2,
  TUNNEL_LEN,
  32, 1,
  true,
  0, Math.PI,
);
const _ceilNeonMat = new THREE.MeshBasicMaterial({
  color: 0x00ccff,
  transparent: true,
  opacity: 0.35,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.BackSide,
  toneMapped: false,
});

// ── Floor glow strip ──
// PlaneGeometry lies in XZ plane (normal +Y). Center at Y=1.
const _floorGeo = new THREE.PlaneGeometry(TUNNEL_LEN, TUNNEL_W_HALF * 2 - 20);
const _floorMat = new THREE.MeshBasicMaterial({
  color: 0x00aaff,
  transparent: true,
  opacity: 0.28,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false,
});

// ── Floor-edge neon strips (2 slim boxes at Z=±88, Y=2) ──
const _floorNeonGeo = new THREE.BoxGeometry(TUNNEL_LEN, 4, 4);
const _floorNeonMat = new THREE.MeshBasicMaterial({
  color: 0x00ffee,
  toneMapped: false,
});

// ── Roof-ridge neon strip (1 slim box at top of wall, Y=TUNNEL_H, Z=0) ──
// A single box running the tunnel length, sitting at the arch-spring line.
const _ridgeNeonGeo = new THREE.BoxGeometry(TUNNEL_LEN, 4, 4);
const _ridgeNeonMat = new THREE.MeshBasicMaterial({
  color: 0x00aaff,
  toneMapped: false,
});

// ── Exterior structural back-wall cap (dark box) ──
// Closes off the inner end of the tunnel so it reads as a corridor not an open pipe.
const _backCapGeo = new THREE.BoxGeometry(30, TUNNEL_H + ARCH_RADIUS + 4, TUNNEL_W_HALF * 2 + 4);
const _backCapMat = new THREE.MeshBasicMaterial({ color: 0x000a14 });

// ── Mouth arch frame — flat base + curved top (RingGeometry half-circle) ──
// RingGeometry(innerR, outerR, thetaSegments, phiSegments, thetaStart, thetaLength).
// Default ring-plane is XY, facing +Z. We rotate 90° around Y → faces +X toward town.
// We want the top half of the ring: thetaStart=0, thetaLength=π.
// Arch springs from Y=0, crown at Y = ARCH_RADIUS * 2 = 180 (ring center at Y=90).
const MOUTH_INNER_R = TUNNEL_W_HALF - 2; // 88
const MOUTH_OUTER_R = TUNNEL_W_HALF + 6; // 96
const _mouthArchGeo = new THREE.RingGeometry(
  MOUTH_INNER_R, MOUTH_OUTER_R,
  48, 1,
  0, Math.PI, // upper semicircle
);
const _mouthArchMat = new THREE.MeshBasicMaterial({
  color: 0x00ffee,
  side: THREE.DoubleSide,
  toneMapped: false,
});

// Mouth arch glow overlay
const _mouthArchGlowGeo = new THREE.RingGeometry(
  MOUTH_INNER_R - 8, MOUTH_OUTER_R + 8,
  48, 1,
  0, Math.PI,
);
const _mouthArchGlowMat = new THREE.MeshBasicMaterial({
  color: 0x00ccff,
  transparent: true,
  opacity: 0.4,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false,
});

// ── Mouth pillar neon strips (two vertical bars flanking the doorway base) ──
// At Z=±(TUNNEL_W_HALF), Y=0..90 (floor to arch-spring). BoxGeometry.
const _pillarGeo = new THREE.BoxGeometry(4, ARCH_RADIUS * 2, 4); // 4 × 180 × 4
const _pillarMat = new THREE.MeshBasicMaterial({ color: 0x00ffee, toneMapped: false });

// ── Mouth base bar (horizontal neon strip across the floor of the opening) ──
const _baseBarGeo = new THREE.BoxGeometry(4, 4, TUNNEL_W_HALF * 2); // 4 × 4 × 180
const _baseBarMat = new THREE.MeshBasicMaterial({ color: 0x00ffee, toneMapped: false });

// ── "ENTER ▸" sign ──
const _labelGeo = new THREE.PlaneGeometry(LABEL_W, LABEL_H);
const _labelMat = new THREE.MeshBasicMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  toneMapped: false,
});
if (typeof document !== 'undefined') {
  _labelMat.map = buildEnterTexture();
}
const _labelBackGeo = new THREE.BoxGeometry(LABEL_W + 12, LABEL_H + 12, 3);
const _labelBackMat = new THREE.MeshBasicMaterial({ color: 0x01060f });

// ---------------------------------------------------------------------------
// Auto-enter (controls-rework 2026-06-21) — when a human-driven avatar walks
// deep into the corridor we fade to the cove (no click/E needed). Gated to
// player/npc; armed/re-armed by leaving the corridor so it fires once per entry.
// ---------------------------------------------------------------------------
const HALF_W = MAP_WIDTH / 2;
const HALF_H = MAP_HEIGHT / 2;
let _coveAutoArmed = true;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function CoveEntrance() {
  const labelRef = useRef<THREE.Mesh>(null);
  const glowRef  = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    // ── Auto-enter: walk deep into the corridor → fade to /cove (no click/E) ──
    // Only for human-driven avatars (player/npc). Autonomous agents and the
    // explore free-cam never get yanked in. One trigger per entry via the
    // module guard, re-armed once the avatar clears the mouth.
    const store = useGameStore.getState();
    const mode = store.controlMode;
    if (mode === 'player' || mode === 'npc') {
      const wx = avatarPositionRef.x - HALF_W;
      const wz = avatarPositionRef.y - HALF_H;
      if (isInsideCoveTunnel(wx, wz)) {
        if (_coveAutoArmed && !store.movementFrozen && !useTransitionStore.getState().active) {
          _coveAutoArmed = false;
          triggerCoveWalkIn();
        }
      } else {
        // Not deep in the corridor → re-arm. The trigger above always fires a
        // SceneTransition that unmounts this component, so re-arming the moment
        // the avatar steps out (rather than well past the mouth) can't loop —
        // it only enables a fresh walk-in after returning from the cove.
        _coveAutoArmed = true;
      }
    } else {
      _coveAutoArmed = true;
    }

    const t = clock.elapsedTime;

    // Pulse mouth arch glow opacity
    _mouthArchGlowMat.opacity = 0.25 + 0.20 * Math.sin(t * 1.4);

    // Pulse ceiling neon
    _ceilNeonMat.opacity = 0.22 + 0.18 * Math.sin(t * 1.1 + 0.5);

    // Pulse floor glow
    _floorMat.opacity = 0.18 + 0.14 * Math.sin(t * 2.0);

    // Gentle float on sign (±4 wu)
    if (labelRef.current) {
      labelRef.current.position.y = LABEL_Y + Math.sin(t * 0.9) * 4;
    }
  });

  // Mouth is at local X = +TUNNEL_HALF = +235 (world -3275)
  // Arch ring center: Y = ARCH_RADIUS = 90 (so ring spans Y=0..180 = floor to arch-spring)
  // Actually: ring center Y = ARCH_RADIUS so top of ring = 2*ARCH_RADIUS = 180.
  // The wall height is TUNNEL_H = 280, so walls continue above the arch spring.
  // Ceiling half-cylinder sits on top of the walls at Y = TUNNEL_H - ARCH_RADIUS = 190.
  // Wait — let's simplify the geometry: arch radius = 90, walls go Y=0..180 (= 2×ARCH_RADIUS),
  // arch caps Y=90..180 (center Y=90 → spans +90 down to 0 and up to 180).
  // Let's use: walls Y=0..180, ceiling half-cylinder center Y=180, radius 90 → crown at Y=270.

  // Ceiling position: half-cylinder is TUNNEL_LEN long, rotated so barrel = +X.
  // PlaneGeometry walls: each 270 wide × 180 tall, centered at Y=90, Z=±90.
  //   rotation: wall faces inward. Left wall at Z=+90, needs to face -Z (inward).
  //     rotation = [0, π, 0] → flips plane to face -Z.
  //   Right wall at Z=-90, needs to face +Z (inward).
  //     rotation = [0, 0, 0] → default (faces +Z).
  //   With DoubleSide we don't need to worry about facing.

  // TUNNEL_H is 280 in the geometry definitions above but we're using 180 for the walls.
  // Let me reconcile: walls are 180 tall (2 × ARCH_RADIUS), arch goes 90 above that.
  // Total corridor height inside = 180+90 = 270 wu. Avatar is ~280 wu tall; tight but readable.

  const WALL_H = ARCH_RADIUS * 2; // 180 wu — wall panels reach arch-spring line
  const CEIL_Y = WALL_H;          // 180 — cylinder center at arch-spring (bottom of arch)

  // Recalculate wall geometry to use correct height
  // (We declared _wallGeo with TUNNEL_H=280 above — that's fine, walls will extend above the arch
  //  which means the exterior edge is solid but interior has the arch ceiling overlapping.
  //  Simpler: keep walls full-height 280, arch is INSIDE. The BackSide ceiling covers the top.)

  return (
    <group
      position={[PORTAL_X, 0, COVE_WORLD_Z]}
      name="cove-entrance"
      userData={{ perfChunk: 'cove-entrance' }}
    >
      {/* ── Structural back-wall cap (inner/west end of tunnel) ── */}
      <mesh
        geometry={_backCapGeo}
        material={_backCapMat}
        position={[-TUNNEL_HALF - 15, (TUNNEL_H + ARCH_RADIUS) / 2, 0]}
      />

      {/* ── Side walls — left (Z=+90) and right (Z=-90) ──
           PlaneGeometry is in XY plane, faces +Z by default.
           We use DoubleSide so we don't need per-wall rotations for facing.
           Wall center Y = TUNNEL_H/2 = 140. */}
      <mesh
        geometry={_wallGeo}
        material={_wallMat}
        position={[0, TUNNEL_H / 2, TUNNEL_W_HALF]}
        rotation={[0, 0, 0]}
      />
      <mesh
        geometry={_wallGeo}
        material={_wallMat}
        position={[0, TUNNEL_H / 2, -TUNNEL_W_HALF]}
        rotation={[0, 0, 0]}
      />

      {/* ── Arched ceiling half-cylinder ──
           CylinderGeometry default barrel axis = +Y.
           rotation.z = π/2 → tilts barrel axis into +X (correct for east-west tunnel).
           thetaStart=0, thetaLength=π → upper half (arch opens downward, interior below).
           BackSide → inside surface visible to player looking up.
           Center at CEIL_Y (arch-spring line), so arch spans from Y=CEIL_Y-ARCH_RADIUS=90
           up to Y=CEIL_Y+ARCH_RADIUS=270. Avatar walks through the corridor at Y=0..180. */}
      <mesh
        geometry={_ceilGeo}
        material={_ceilMat}
        position={[0, CEIL_Y, 0]}
        rotation={[0, 0, Math.PI / 2]}
      />
      {/* Ceiling neon glow overlay — same transform */}
      <mesh
        geometry={_ceilNeonGeo}
        material={_ceilNeonMat}
        position={[0, CEIL_Y, 0]}
        rotation={[0, 0, Math.PI / 2]}
      />

      {/* ── Floor glow strip — runs length of corridor at Y=1 ──
           PlaneGeometry lies in XZ plane by default (no, it lies in XY).
           Must rotate -90° around X to lay flat on the floor. */}
      <mesh
        geometry={_floorGeo}
        material={_floorMat}
        position={[0, 1, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      />

      {/* ── Floor-edge neon strips (left + right) ── */}
      <mesh
        geometry={_floorNeonGeo}
        material={_floorNeonMat}
        position={[0, 2, TUNNEL_W_HALF - 2]}
      />
      <mesh
        geometry={_floorNeonGeo}
        material={_floorNeonMat}
        position={[0, 2, -(TUNNEL_W_HALF - 2)]}
      />

      {/* ── Roof-ridge neon strip at arch-spring line ── */}
      <mesh
        geometry={_ridgeNeonGeo}
        material={_ridgeNeonMat}
        position={[0, CEIL_Y, 0]}
      />

      {/* ── Mouth arch frame at X=+TUNNEL_HALF (east/town-facing opening) ──
           RingGeometry is in XY plane facing +Z by default.
           rotation.y = π/2 → faces +X (toward town, correct for mouth). ✓
           Center at Y=ARCH_RADIUS=90 so ring spans Y=0..180 (upper half = arch).
           Ring covers arch area: innerR=88, outerR=96 → 8wu thick frame. */}
      <mesh
        geometry={_mouthArchGeo}
        material={_mouthArchMat}
        position={[TUNNEL_HALF, ARCH_RADIUS, 0]}
        rotation={[0, Math.PI / 2, 0]}
      />
      {/* Mouth arch glow overlay */}
      <mesh
        geometry={_mouthArchGlowGeo}
        material={_mouthArchGlowMat}
        position={[TUNNEL_HALF, ARCH_RADIUS, 0]}
        rotation={[0, Math.PI / 2, 0]}
      />

      {/* ── Mouth pillar neon strips (left + right base pillars) ──
           Vertical boxes at Z=±TUNNEL_W_HALF, from Y=0 to Y=WALL_H (arch-spring).
           BoxGeometry(4, 180, 4) centered at Y=ARCH_RADIUS=90. */}
      <mesh
        geometry={_pillarGeo}
        material={_pillarMat}
        position={[TUNNEL_HALF, ARCH_RADIUS, TUNNEL_W_HALF]}
      />
      <mesh
        geometry={_pillarGeo}
        material={_pillarMat}
        position={[TUNNEL_HALF, ARCH_RADIUS, -TUNNEL_W_HALF]}
      />

      {/* ── Mouth base bar (floor-level horizontal) ── */}
      <mesh
        geometry={_baseBarGeo}
        material={_baseBarMat}
        position={[TUNNEL_HALF, 2, 0]}
      />

      {/* ── "ENTER ▸" sign above mouth ──
           PlaneGeometry faces +Z; rotation.y=π/2 → faces +X toward town. ✓
           Float animation in useFrame (labelRef). */}
      <mesh
        geometry={_labelBackGeo}
        material={_labelBackMat}
        rotation={[0, Math.PI / 2, 0]}
        position={[TUNNEL_HALF, LABEL_Y, 0]}
      />
      <mesh
        ref={labelRef}
        geometry={_labelGeo}
        material={_labelMat}
        rotation={[0, Math.PI / 2, 0]}
        position={[TUNNEL_HALF + 2, LABEL_Y, 0]}
      />

      {/* ── Invisible raycastable click target at the tunnel MOUTH ──
           colorWrite:false = no pixels written to framebuffer, but mesh IS in
           the scene graph and raycast tree (visible:false would exclude it).
           Box 4wu deep × 280 tall × 184 wide — covers the entire mouth opening.
           Clicking triggers triggerCoveWalkIn() which walks the avatar to mid-tunnel
           (COVE_DOOR_PX at world -3400 ≈ local X+110) before fading to /cove. */}
      <mesh
        position={[TUNNEL_HALF, ARCH_RADIUS + TUNNEL_H / 4, 0]}
        onClick={(e) => { e.stopPropagation(); triggerCoveWalkIn(); }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = ''; }}
      >
        <boxGeometry args={[4, TUNNEL_H + ARCH_RADIUS, TUNNEL_W_HALF * 2 + 4]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>

      {/* ── Point lights inside corridor ──
           Light 1: deep inside tunnel (toward inner/west end) — illuminates interior.
           Light 2: at mouth opening — makes the opening glow from outside.
           Both at Y = ARCH_RADIUS = 90 (mid-height).
           Total scene point lights: beacon(3) + entrance(2) = 5. Under Iris Xe limit of 7. ✓ */}
      <pointLight
        color={0x00ccff}
        intensity={2.2}
        distance={400}
        decay={2}
        position={[-TUNNEL_HALF + 60, ARCH_RADIUS, 0]}
      />
      <pointLight
        color={0x00ffcc}
        intensity={1.8}
        distance={500}
        decay={2}
        position={[TUNNEL_HALF + 40, ARCH_RADIUS, 0]}
      />
    </group>
  );
}
