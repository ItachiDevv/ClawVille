'use client';

/**
 * TownDirectorySign — 3-arm directional fingerpost at town centre.
 *
 * Replaces the old inaccurate static PNG (auction/bazaar/marketplace —
 * all paused features) with accurate CanvasTexture-baked arm signs
 * pointing to the three active destinations from the town square.
 *
 * Arm destinations (from the player standing at spawn facing north, the
 * sign being north of them at world Z=-120):
 *   FORWARD / ↑ = Bounty Board   world (0, -1220) — further north
 *   RIGHT   / → = Exchange        world (+1273, -120) — east
 *   LEFT    / ← = Cosmetics       world (-1273, -120) — west
 *
 * All text is baked into CanvasTextures on PlaneGeometry faces.
 * NO drei <Text> / <Billboard> — hard GPU crash on Iris Xe.
 * NO ShaderMaterial — silent WebGPU crash.
 * NO per-frame allocations — component is a pure static mesh, no useFrame.
 *
 * Geometry is built once at module scope and never recreated.
 *
 * town-ux-2026-06-19
 */

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Sign world position
// ---------------------------------------------------------------------------
const SIGN_X = 0;
const SIGN_Y = 0;   // posts rest on sand (sand ≈ Y=-2)
const SIGN_Z = -120;

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------
const POST_RADIUS  = 10;
const POST_HEIGHT  = 420;
const POST_SEGS    = 6;      // hex prism — efficient, distinct from rectangular arms

const ARM_W  = 280;    // length along the arm's local X axis
const ARM_H  = 90;     // plank height
const ARM_D  = 14;     // plank depth
const ARM_Y  = 340;    // height above post base where arms attach

// Point (triangle tip) at the destination end of each arm — gives the
// fingerpost silhouette. Built as a thin box at 60% width + 40% width.
const TIP_W  = ARM_W * 0.25;
const TIP_H  = ARM_H * 0.7;

const WOOD_COLOR = 0x6b3a1f;
const PANEL_COLOR = 0x4a2810;

// ---------------------------------------------------------------------------
// CanvasTexture baking helpers
// ---------------------------------------------------------------------------
const ARM_TEX_W = 512;
const ARM_TEX_H = 128;

function bakeArmTexture(label: string, arrow: '↑' | '→' | '←', color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = ARM_TEX_W;
  canvas.height = ARM_TEX_H;
  const ctx = canvas.getContext('2d')!;

  // Background — dark plank
  ctx.fillStyle = '#2e1508';
  ctx.fillRect(0, 0, ARM_TEX_W, ARM_TEX_H);

  // Carved-wood border
  ctx.strokeStyle = '#7c5230';
  ctx.lineWidth   = 3;
  ctx.strokeRect(3, 3, ARM_TEX_W - 6, ARM_TEX_H - 6);

  // Wood grain lines (subtle)
  ctx.strokeStyle = 'rgba(100,60,20,0.25)';
  ctx.lineWidth = 1;
  for (let y = 16; y < ARM_TEX_H - 8; y += 12) {
    ctx.beginPath();
    ctx.moveTo(8, y);
    ctx.lineTo(ARM_TEX_W - 8, y);
    ctx.stroke();
  }

  // Arrow glyph
  ctx.shadowColor  = color;
  ctx.shadowBlur   = 10;
  ctx.font         = 'bold 42px Arial, sans-serif';
  ctx.textBaseline = 'middle';
  const arrowWidth = 48;

  let arrowX: number;
  let labelX: number;
  if (arrow === '→') {
    // Arrow on the right (pointing east)
    arrowX = ARM_TEX_W - arrowWidth - 12;
    ctx.textAlign = 'left';
    labelX = 16;
  } else if (arrow === '←') {
    // Arrow on the left (pointing west)
    arrowX = 12;
    ctx.textAlign = 'right';
    labelX = ARM_TEX_W - 16;
  } else {
    // Arrow on top-center for ↑ (Bounty Board, pointing north)
    arrowX = ARM_TEX_W / 2 - 24;
    ctx.textAlign = 'center';
    labelX = ARM_TEX_W / 2;
  }

  ctx.fillStyle = color;
  ctx.fillText(arrow, arrowX, ARM_TEX_H / 2);
  ctx.shadowBlur = 0;

  // Label text
  ctx.font         = 'bold 28px Arial, sans-serif';
  ctx.fillStyle    = '#f5e8d0';
  ctx.shadowColor  = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur   = 4;
  if (arrow === '↑') {
    ctx.textAlign = 'center';
    ctx.fillText(label, ARM_TEX_W / 2 + 24, ARM_TEX_H / 2);
  } else if (arrow === '→') {
    ctx.textAlign = 'left';
    ctx.fillText(label, labelX, ARM_TEX_H / 2);
  } else {
    ctx.textAlign = 'right';
    ctx.fillText(label, labelX, ARM_TEX_H / 2);
  }
  ctx.shadowBlur = 0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Module-scope geometry
// ---------------------------------------------------------------------------
function translatedGeo(geo: THREE.BufferGeometry, x: number, y: number, z: number) {
  const g = geo.clone();
  g.clearGroups();
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, z));
  return g;
}

// Central hex post
const _postGeo = new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS * 1.3, POST_HEIGHT, POST_SEGS);
const _capGeo  = new THREE.CylinderGeometry(POST_RADIUS * 1.6, POST_RADIUS, 20, POST_SEGS);

const postMergedGeo = mergeGeometries([
  translatedGeo(_postGeo, 0, POST_HEIGHT / 2, 0),
  translatedGeo(_capGeo,  0, POST_HEIGHT + 8, 0),
]) ?? _postGeo.clone();
postMergedGeo.computeBoundingBox();
postMergedGeo.computeBoundingSphere();

// Arm plank geometry (pointing in +X direction; rotate in JSX to aim each arm)
// Main plank body
const _armBodyGeo = new THREE.BoxGeometry(ARM_W, ARM_H, ARM_D);
// Tip (pointed end) — extra bit at the +X end to simulate fingerpost arrow
const _armTipGeo  = new THREE.BoxGeometry(TIP_W, TIP_H, ARM_D);
const armPlanksGeo = mergeGeometries([
  translatedGeo(_armBodyGeo, ARM_W / 2, 0, 0),
  translatedGeo(_armTipGeo,  ARM_W + TIP_W / 2 - 2, 0, 0),
]) ?? _armBodyGeo.clone();
armPlanksGeo.computeBoundingBox();
armPlanksGeo.computeBoundingSphere();

// Face plane for the CanvasTexture label — same X orientation as armPlanksGeo
const _armFacePlane = new THREE.PlaneGeometry(ARM_W - 16, ARM_H - 16);

// ---------------------------------------------------------------------------
// Module-scope materials — instantiated once
// ---------------------------------------------------------------------------
const woodMat = new THREE.MeshBasicMaterial({ color: WOOD_COLOR });
const panelMat = new THREE.MeshBasicMaterial({ color: PANEL_COLOR });

// Per-arm face materials, allocated at module load (SSR-safe: guarded by typeof window)
let matBounty: THREE.MeshBasicMaterial | null   = null;
let matExchange: THREE.MeshBasicMaterial | null = null;
let matCosmetics: THREE.MeshBasicMaterial | null = null;

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  matBounty = new THREE.MeshBasicMaterial({
    map: bakeArmTexture('Bounty Board', '↑', '#00ffee'),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  matExchange = new THREE.MeshBasicMaterial({
    map: bakeArmTexture('Exchange', '→', '#ffe040'),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  matCosmetics = new THREE.MeshBasicMaterial({
    map: bakeArmTexture('Cosmetics', '←', '#ff80ff'),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function TownDirectorySign() {
  // Panel material fallback for SSR (no canvas available server-side)
  const bMat  = matBounty   ?? panelMat;
  const eMat  = matExchange  ?? panelMat;
  const cMat  = matCosmetics ?? panelMat;

  return (
    <group
      position={[SIGN_X, SIGN_Y, SIGN_Z]}
      userData={{ isOccluder: true }}
      name="town-directory-sign"
    >
      {/* Central post + cap */}
      <mesh geometry={postMergedGeo} material={woodMat} />

      {/* ── BOUNTY BOARD arm — points NORTH (−Z in world). ──
          The arm plank geometry extends in local +X.
          rotY = -π/2: maps local +X → world -Z (north, toward Bounty Board). */}
      <group position={[0, ARM_Y, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh geometry={armPlanksGeo} material={woodMat} />
        {/* Label face — slightly in front of plank (+Z local = world +X after rotation; both sides rendered) */}
        <mesh
          geometry={_armFacePlane}
          material={bMat}
          position={[ARM_W / 2, 0, ARM_D / 2 + 1]}
        />
        {/* Back face */}
        <mesh
          geometry={_armFacePlane}
          material={bMat}
          position={[ARM_W / 2, 0, -(ARM_D / 2 + 1)]}
          rotation={[0, Math.PI, 0]}
        />
      </group>

      {/* ── EXCHANGE arm — points EAST (+X in world). ──
          rotY = 0: arm extends in local +X = world +X (east, toward Exchange). */}
      <group position={[0, ARM_Y + ARM_H + 8, 0]} rotation={[0, 0, 0]}>
        <mesh geometry={armPlanksGeo} material={woodMat} />
        <mesh
          geometry={_armFacePlane}
          material={eMat}
          position={[ARM_W / 2, 0, ARM_D / 2 + 1]}
        />
        <mesh
          geometry={_armFacePlane}
          material={eMat}
          position={[ARM_W / 2, 0, -(ARM_D / 2 + 1)]}
          rotation={[0, Math.PI, 0]}
        />
      </group>

      {/* ── COSMETICS arm — points WEST (−X in world). ──
          rotY = π: maps local +X → world -X (west, toward Cosmetics / Bazaar).
          Stacked another ARM_H above exchange arm so arms don't clip each other. */}
      <group position={[0, ARM_Y + (ARM_H + 8) * 2, 0]} rotation={[0, Math.PI, 0]}>
        <mesh geometry={armPlanksGeo} material={woodMat} />
        <mesh
          geometry={_armFacePlane}
          material={cMat}
          position={[ARM_W / 2, 0, ARM_D / 2 + 1]}
        />
        <mesh
          geometry={_armFacePlane}
          material={cMat}
          position={[ARM_W / 2, 0, -(ARM_D / 2 + 1)]}
          rotation={[0, Math.PI, 0]}
        />
      </group>
    </group>
  );
}
