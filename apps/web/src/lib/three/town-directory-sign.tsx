'use client';

/**
 * TownDirectorySign — a single readable directory board at town centre.
 *
 * History: the old static PNG ("Auction / Bazaar / Marketplace") was
 * inaccurate (all paused). A first rework used a 3-arm fingerpost (arms pointed
 * edge-on, unreadable). Then a "triangle" board (Bounty on top, flanks below) —
 * but the Bounty label read bigger and floated above the other two, unbalanced
 * and blurry. CURRENT (2026-06-26 polish): ONE flat board facing the player, a
 * prominent "TOWN CENTER" header + clean rule, then the three live destinations
 * as a BALANCED 3-row list — uniform label size, even spacing, an aligned arrow
 * column. Texture bumped 1024×768 → 1536×1152 for crisp lettering at distance.
 *
 * Direction model — player stands at spawn (camera north of the sign,
 * looking SOUTH at it). On the board's player-facing (+Z) side, the rows read:
 *   ↑  Bounty Board   (straight ahead / south, world z≈-1220)
 *   ←  Cosmetics      (player's left  / west,  world x≈-1273)
 *   →  Exchange       (player's right / east,  world x≈+1273)
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
// 1536×1152 (4:3, matches BOARD_W:BOARD_H = 400:300) — bumped from 1024×768 for
// crisp lettering at spawn distance. 1 texture for the whole sign; ~7MB VRAM.
const TEX_W = 1536;
const TEX_H = 1152;

function bakeDirectoryTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;

  // Wood plank background (vertical gradient)
  const grad = ctx.createLinearGradient(0, 0, 0, TEX_H);
  grad.addColorStop(0, '#46260f');
  grad.addColorStop(1, '#2b1408');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // Subtle horizontal grain
  ctx.strokeStyle = 'rgba(150,92,42,0.14)';
  ctx.lineWidth = 2;
  for (let y = 36; y < TEX_H; y += 36) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEX_W, y);
    ctx.stroke();
  }

  // Carved double border (light bevel over a thin dark inner line)
  ctx.strokeStyle = '#b07e44';
  ctx.lineWidth = 18;
  ctx.strokeRect(28, 28, TEX_W - 56, TEX_H - 56);
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 3;
  ctx.strokeRect(52, 52, TEX_W - 104, TEX_H - 104);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // ── Header: "TOWN CENTER" — prominent title (was a dwarfed 56px on 1024) ──
  ctx.fillStyle = '#ffe6b8';
  ctx.font = '800 132px Georgia, serif';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 4;
  ctx.fillText('TOWN CENTER', TEX_W / 2, 150);
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Clean rule under the title
  ctx.strokeStyle = 'rgba(176,126,68,0.85)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(190, 250);
  ctx.lineTo(TEX_W - 190, 250);
  ctx.stroke();

  // ── Three destinations — uniform size, evenly spaced 3-row list ──
  // Aligned arrow column (left of a fixed gutter) + label column, the whole
  // block centred. Kills the old "BOUNTY huge + floating above the other two".
  type Row = { glyph: string; label: string; color: string };
  const rows: Row[] = [
    { glyph: '↑', label: 'BOUNTY BOARD', color: '#46f2e2' }, // straight ahead
    { glyph: '←', label: 'COSMETICS',    color: '#ff8ce4' }, // player's left
    { glyph: '→', label: 'EXCHANGE',     color: '#ffd24a' }, // player's right
  ];

  const ARROW_FONT = '800 110px Arial, sans-serif';
  const LABEL_FONT = '700 96px Georgia, serif';
  const GUTTER = 56;          // gap between arrow column and label column
  const ROW_Y0 = 470;         // first row baseline
  const ROW_DY = 230;         // even vertical spacing

  // Compute a shared centred block X so arrows + labels align across all rows.
  ctx.font = ARROW_FONT;
  let maxArrowW = 0;
  for (const r of rows) maxArrowW = Math.max(maxArrowW, ctx.measureText(r.glyph).width);
  ctx.font = LABEL_FONT;
  let maxLabelW = 0;
  for (const r of rows) maxLabelW = Math.max(maxLabelW, ctx.measureText(r.label).width);
  const blockW = maxArrowW + GUTTER + maxLabelW;
  const blockLeft = (TEX_W - blockW) / 2;
  const arrowCenterX = blockLeft + maxArrowW / 2;     // arrows centred in their column
  const labelLeftX = blockLeft + maxArrowW + GUTTER;  // labels left-aligned after gutter

  rows.forEach((r, i) => {
    const y = ROW_Y0 + i * ROW_DY;

    // Glowing coloured arrow (consistent size for all three)
    ctx.font = ARROW_FONT;
    ctx.textAlign = 'center';
    ctx.fillStyle = r.color;
    ctx.shadowColor = r.color;
    ctx.shadowBlur = 18;
    ctx.fillText(r.glyph, arrowCenterX, y);
    ctx.shadowBlur = 0;

    // Warm-white label (consistent size, light shadow — not muddy)
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fbf3e2';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 3;
    ctx.fillText(r.label, labelLeftX, y);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  });

  ctx.textAlign = 'center';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8; // stay crisp at grazing angles / distance
  tex.generateMipmaps = true;
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
