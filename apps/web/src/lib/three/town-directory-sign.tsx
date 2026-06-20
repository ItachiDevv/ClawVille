'use client';

/**
 * TownDirectorySign — a single readable directory board at town centre.
 *
 * History: the old static PNG ("Auction / Bazaar / Marketplace") was
 * inaccurate (all paused). A first rework used a 3-arm fingerpost, but the
 * arms pointed in literal world directions, so the forward (Bounty) arm's
 * text sat edge-on to the player and the baked labels were too small —
 * unreadable. This version is what the founder asked for: ONE flat board
 * facing the player with the three live destinations laid out as a TRIANGLE
 * (forward on top, the two flanks below) with big, high-contrast labels.
 *
 * Direction model — player stands at spawn (camera north of the sign,
 * looking SOUTH at it). On the board's player-facing (+Z) side:
 *   TOP    ↑  = Bounty Board   (straight ahead / south, world z≈-1220)
 *   RIGHT  →  = Exchange        (player's right / east,  world x≈+1273)
 *   LEFT   ←  = Cosmetics       (player's left  / west,  world x≈-1273)
 *
 * All text is baked into a CanvasTexture on a PlaneGeometry. NO drei
 * <Text>/<Billboard> (Iris-Xe crash), NO ShaderMaterial (WebGPU crash),
 * NO per-frame allocation (pure static mesh, no useFrame). Geometry +
 * materials are built once at module scope.
 *
 * town-ux-2026-06-19
 */

import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ─── Sign world position ────────────────────────────────────────────────────
const SIGN_X = 0;
const SIGN_Y = 0; // post rests on sand (sand ≈ Y=-2)
const SIGN_Z = -120;

// ─── Geometry constants ─────────────────────────────────────────────────────
const POST_RADIUS = 11;
const POST_HEIGHT = 260;
const POST_SEGS = 6; // hex prism

const BOARD_W = 400;
const BOARD_H = 300;
const BOARD_D = 16;
const BOARD_CY = POST_HEIGHT + BOARD_H / 2; // board sits ON TOP of the post (no front occlusion)

const WOOD_COLOR = 0x6b3a1f;
const FRAME_COLOR = 0x4a2810;

// ─── CanvasTexture baking ────────────────────────────────────────────────────
const TEX_W = 1024;
const TEX_H = 768; // 4:3 to match BOARD_W:BOARD_H (400:300)

function bakeDirectoryTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;

  // Wood plank background (vertical gradient)
  const grad = ctx.createLinearGradient(0, 0, 0, TEX_H);
  grad.addColorStop(0, '#3a1d0d');
  grad.addColorStop(1, '#281207');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // Subtle horizontal grain
  ctx.strokeStyle = 'rgba(120,72,30,0.16)';
  ctx.lineWidth = 2;
  for (let y = 24; y < TEX_H; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEX_W, y);
    ctx.stroke();
  }

  // Carved double border
  ctx.strokeStyle = '#8a5a30';
  ctx.lineWidth = 12;
  ctx.strokeRect(16, 16, TEX_W - 32, TEX_H - 32);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(30, 30, TEX_W - 60, TEX_H - 60);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Title
  ctx.fillStyle = '#e8c89a';
  ctx.font = 'bold 56px Georgia, serif';
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 6;
  ctx.fillText('TOWN CENTER', TEX_W / 2, 78);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(138,90,48,0.7)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(140, 124);
  ctx.lineTo(TEX_W - 140, 124);
  ctx.stroke();

  // ── TOP (forward): ↑ Bounty Board — arrow above the label, centred ──
  drawArrow('↑', TEX_W / 2, 250, '#3ff0e0', 116);
  drawLabel('BOUNTY BOARD', TEX_W / 2, 350);

  // ── BOTTOM-LEFT: ← Cosmetics ──
  drawInline('←', 'COSMETICS', TEX_W * 0.26, 600, '#ff86e0', 'arrowLeft');
  // ── BOTTOM-RIGHT: Exchange → ──
  drawInline('→', 'EXCHANGE', TEX_W * 0.74, 600, '#ffd24a', 'arrowRight');

  function drawArrow(glyph: string, x: number, y: number, color: string, size: number) {
    ctx.font = `bold ${size}px Arial, sans-serif`;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 22;
    ctx.fillText(glyph, x, y);
    ctx.shadowBlur = 0;
  }
  function drawLabel(text: string, x: number, y: number) {
    ctx.font = 'bold 70px Georgia, serif';
    ctx.fillStyle = '#fbf3e2';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 5;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
  }
  // arrow + label on one baseline, centred as a unit
  function drawInline(
    glyph: string,
    label: string,
    centerX: number,
    y: number,
    color: string,
    mode: 'arrowLeft' | 'arrowRight',
  ) {
    const arrowFont = 'bold 92px Arial, sans-serif';
    const labelFont = 'bold 58px Georgia, serif';
    ctx.font = arrowFont;
    const aw = ctx.measureText(glyph).width;
    ctx.font = labelFont;
    const lw = ctx.measureText(label).width;
    const gap = 22;
    const total = aw + gap + lw;
    let x = centerX - total / 2;
    ctx.textAlign = 'left';
    if (mode === 'arrowLeft') {
      ctx.font = arrowFont;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 20;
      ctx.fillText(glyph, x, y);
      ctx.shadowBlur = 0;
      x += aw + gap;
      ctx.font = labelFont;
      ctx.fillStyle = '#fbf3e2';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 5;
      ctx.fillText(label, x, y);
      ctx.shadowBlur = 0;
    } else {
      ctx.font = labelFont;
      ctx.fillStyle = '#fbf3e2';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 5;
      ctx.fillText(label, x, y);
      ctx.shadowBlur = 0;
      x += lw + gap;
      ctx.font = arrowFont;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 20;
      ctx.fillText(glyph, x, y);
      ctx.shadowBlur = 0;
    }
    ctx.textAlign = 'center';
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8; // stay crisp at grazing angles / distance
  tex.needsUpdate = true;
  return tex;
}

// ─── Module-scope geometry ───────────────────────────────────────────────────
function translatedGeo(geo: THREE.BufferGeometry, x: number, y: number, z: number) {
  const g = geo.clone();
  g.clearGroups();
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, z));
  return g;
}

const _postGeo = new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS * 1.3, POST_HEIGHT, POST_SEGS);
const _capGeo = new THREE.CylinderGeometry(POST_RADIUS * 1.5, POST_RADIUS, 18, POST_SEGS);
const postMergedGeo =
  mergeGeometries([
    translatedGeo(_postGeo, 0, POST_HEIGHT / 2, 0),
    translatedGeo(_capGeo, 0, POST_HEIGHT + 6, 0),
  ]) ?? _postGeo.clone();
postMergedGeo.computeBoundingBox();
postMergedGeo.computeBoundingSphere();

// Wooden board backing (visible from behind) + a crossbar tying it to the post
const _boardGeo = new THREE.BoxGeometry(BOARD_W, BOARD_H, BOARD_D);
const _crossbarGeo = new THREE.BoxGeometry(40, 70, BOARD_D + 4);
const boardMergedGeo =
  mergeGeometries([
    translatedGeo(_boardGeo, 0, BOARD_CY, 0),
    translatedGeo(_crossbarGeo, 0, POST_HEIGHT - 10, 0),
  ]) ?? _boardGeo.clone();
boardMergedGeo.computeBoundingBox();
boardMergedGeo.computeBoundingSphere();

// Player-facing texture plane (front, +Z)
const _facePlane = new THREE.PlaneGeometry(BOARD_W - 24, BOARD_H - 24);

// ─── Module-scope materials ──────────────────────────────────────────────────
const woodMat = new THREE.MeshBasicMaterial({ color: WOOD_COLOR });
void FRAME_COLOR;

let faceMat: THREE.MeshBasicMaterial | null = null;
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  faceMat = new THREE.MeshBasicMaterial({
    map: bakeDirectoryTexture(),
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function TownDirectorySign() {
  const fMat = faceMat ?? woodMat;
  return (
    <group
      position={[SIGN_X, SIGN_Y, SIGN_Z]}
      userData={{ isOccluder: true }}
      name="town-directory-sign"
    >
      {/* Post + cap + board backing (single merged wooden mesh + the post) */}
      <mesh geometry={postMergedGeo} material={woodMat} />
      <mesh geometry={boardMergedGeo} material={woodMat} />

      {/* Player-facing (+Z) texture board — the readable triangle directory */}
      <mesh geometry={_facePlane} material={fMat} position={[0, BOARD_CY, BOARD_D / 2 + 1.5]} />
    </group>
  );
}
