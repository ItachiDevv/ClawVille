'use client';

/**
 * SlotReels3D — polished animated reel presentation layer (Phase 6.1.9).
 *
 * Replaces the previous per-cell-plane "3D drum" approach (df53dd3..bdbd124).
 * That rig tried to be a literal 3D mechanical drum and ended up looking like
 * scattered cards under orthographic projection.
 *
 * This rig is a flat camera-facing reel layer in the style of modern social
 * casino slots (Stake / Hacksaw / Pragmatic Play presentation quality) — the
 * "drum" feeling is faked with timing, easing, motion blur, and layered alpha
 * overlays. NOT geometry complexity.
 *
 * Architecture
 * ============
 * 5 reel columns × PlaneGeometry(CELL_WU, CELL_WU * VISIBLE_ROWS).
 * Each reel has a per-reel CanvasTexture: 1 column × STRIP_LEN rows, built once
 * from the corresponding row of CLASSIC_REEL_STRIPS / BONUS_REEL_STRIPS so the
 * visible scroll is genuinely the weighted strip the engine samples.
 *
 * Spin = animate `texture.offset.y` (no mesh translation, no rotation). With
 * wrapT=RepeatWrapping the texture loops seamlessly. Visible 3-row window
 * lands deterministically on `reels[r] = [top, mid, bot]` via
 * findStripPosition() — same math as 565e93d's planar implementation, but
 * with modern slot motion polish on top.
 *
 * Layered FX (all transparent MeshBasicMaterial overlays — no shaders):
 *   - top/bottom vignette gradient (fakes drum curvature without 3D)
 *   - centre-row payline glow strip
 *   - per-reel side-bevel highlights
 *   - whole-cluster frame border
 *
 * Spin pacing (modern online slot feel):
 *   ACCEL  (280ms)            — velocity 0 → MAX, easeInQuad
 *   STEADY (≥600ms hold)      — texture.repeat.y compressed (11 cells in 3-cell window) = motion blur
 *   DECEL  (720ms, staggered) — each reel decels 180ms later than the previous, easeOutCubic
 *   BOUNCE (220ms)            — 0.32-cell overshoot + ease back via easeOutBack-style spring
 *
 * Iris Xe invariants (project-wide ban list):
 *   - MeshBasicMaterial only (no Standard, no Shader, no PBR)
 *   - No shadows, no postprocessing
 *   - Zero per-frame allocations in useFrame
 *   - Geometry / materials / textures useMemo'd at mount
 *   - No drei <Text> / <Billboard>
 *   - frameloop="always" + preserveDrawingBuffer:true preserved by parent Canvas
 */

import { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  CLASSIC_REEL_STRIPS,
  BONUS_REEL_STRIPS,
  CLASSIC_SLOT_SYMBOL_ASSETS,
} from '@clawville/shared';
import type { SpinResult } from '@/lib/casino/types';

// ---------------------------------------------------------------------------
// Constants — geometry
// ---------------------------------------------------------------------------
const REEL_COUNT   = 5;
const VISIBLE_ROWS = 3;
const STRIP_LEN    = 84;

const CELL_WU     = 1.5;                            // world units per cell (square)
const REEL_WIDTH  = CELL_WU;
const REEL_HEIGHT = CELL_WU * VISIBLE_ROWS;         // 4.5 wu
const REEL_GAP    = 0.18;                           // gap between reels
const REEL_PITCH  = REEL_WIDTH + REEL_GAP;          // centre-to-centre = 1.68 wu

// Total reel cluster span: 5 × 1.5 + 4 × 0.18 = 8.22 wu wide
// Centred at x=0 → reel r at x = (r - 2) × 1.68

// ---------------------------------------------------------------------------
// Constants — spin physics
// ---------------------------------------------------------------------------
const ACCEL_MS         = 280;
const STEADY_MIN_MS    = 620;                       // min steady before first reel decels
const DECEL_MS         = 720;                       // per-reel decel duration
const DECEL_STAGGER_MS = 160;                       // reel r starts decel STAGGER_MS after reel r-1
const BOUNCE_MS        = 220;
const BOUNCE_OVERSHOOT = 0.32 / STRIP_LEN;          // 0.32 cells of strip-fraction overshoot

/** Peak scroll velocity (offset units per second). 5 = 5 full strip loops/sec. */
const MAX_SCROLL_PER_SEC = 5.5;

/** Motion-blur compression — squeezes 11 cells into the 3-cell visible window. */
const VISIBLE_REPEAT = VISIBLE_ROWS / STRIP_LEN;
const BLUR_REPEAT    = (VISIBLE_ROWS + 8) / STRIP_LEN;

// ---------------------------------------------------------------------------
// Constants — texture
//
// TEX_H must stay under both the GPU's GL_MAX_TEXTURE_SIZE AND the browser's
// Canvas2D max dimension (Chrome caps at 16384 in any axis, silently clipping
// drawImage calls beyond that). At TILE_PX=256 × STRIP_LEN=84 = 21504, Chrome
// would clamp the canvas, leaving the bottom of the strip blank. UV offsets
// set to (0, 1−VISIBLE_REPEAT) sample exactly that blank zone → reels render
// as a single missing-pixel dot after viewport resize re-triggers texture
// upload.
//
// TILE_PX=192 → TEX_H=16128, comfortably under 16384. Each cell still renders
// at ~80–120 CSS px on screen, so 192 vs 256 is invisible at runtime.
// ---------------------------------------------------------------------------
const TILE_PX = 192;
const TEX_W   = TILE_PX;
const TEX_H   = TILE_PX * STRIP_LEN;

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------
const PHASE_IDLE   = 0;
const PHASE_ACCEL  = 1;
const PHASE_STEADY = 2;
const PHASE_DECEL  = 3;
const PHASE_BOUNCE = 4;
const PHASE_DONE   = 5;

// ---------------------------------------------------------------------------
// Per-reel animation state — mutated in useFrame, NEVER React state
// ---------------------------------------------------------------------------
interface ReelAnim {
  phase:            number;
  spinStart:        number;   // performance.now() at trigger
  offset:           number;   // current texture.offset.y (unwrapped)
  velocity:         number;   // offset units / second
  targetOffset:     number;   // landing offset (set after server result arrives)
  targetSet:        boolean;
  decelStartMs:     number;   // performance.now() at DECEL entry
  decelStartOffset: number;
  bounceStartMs:    number;
  bounceBaseOffset: number;
  settled:          boolean;
}

function makeIdleAnim(): ReelAnim {
  return {
    phase: PHASE_IDLE,
    spinStart: 0,
    offset: 0,
    velocity: 0,
    targetOffset: 0,
    targetSet: false,
    decelStartMs: 0,
    decelStartOffset: 0,
    bounceStartMs: 0,
    bounceBaseOffset: 0,
    settled: true,
  };
}

// ---------------------------------------------------------------------------
// Easing — pure, zero allocations
// ---------------------------------------------------------------------------
function easeInQuad(t: number): number   { return t * t; }
function easeOutCubic(t: number): number { const u = 1 - t; return 1 - u * u * u; }
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u  = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

// ---------------------------------------------------------------------------
// Find strip position where visible window = [top, mid, bot]
// ---------------------------------------------------------------------------
function findStripPosition(strip: number[], top: number, mid: number, bot: number): number {
  const L = strip.length;
  for (let k = 0; k < L; k++) {
    if (strip[(k - 1 + L) % L] === top && strip[k] === mid && strip[(k + 1) % L] === bot) {
      return k;
    }
  }
  // Fallback: any k where middle matches
  for (let k = 0; k < L; k++) {
    if (strip[k] === mid) return k;
  }
  return 0;
}

/** Offset where cell `p` sits in the centre of the visible window. */
function offsetForStripPosition(p: number): number {
  return 1 - (p + (VISIBLE_ROWS / 2)) / STRIP_LEN;
}

// ---------------------------------------------------------------------------
// Symbol → SVG path lookup (extends shared asset registry with id 10 fallback)
// ---------------------------------------------------------------------------
const SYMBOL_SVG_PATHS: Record<number, string> = (() => {
  const out: Record<number, string> = {};
  for (const a of CLASSIC_SLOT_SYMBOL_ASSETS) {
    out[a.id] = a.svgPath;
  }
  // Scatter id 10 is in CLASSIC_SLOT_SYMBOL_ASSETS already (bonus paytable)
  return out;
})();

// ---------------------------------------------------------------------------
// Image cache (module-scope, shared across spin sessions)
// ---------------------------------------------------------------------------
const imageCache = new Map<number, HTMLImageElement>();

function loadSymbolImage(id: number, path: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(id);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { imageCache.set(id, img); resolve(img); };
    img.onerror = () => reject(new Error(`Failed to load slot symbol ${id} (${path})`));
    img.src = path;
  });
}

// ---------------------------------------------------------------------------
// Round-rect path helper (no closePath needed — caller fills/strokes)
// ---------------------------------------------------------------------------
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Draw a single cell into a canvas at (x, y) — premium social-casino styling.
//   - dark vertical-gradient card background (deeper-than-purple slate)
//   - brass border outline
//   - top rim highlight gradient (fake light)
//   - thick-outlined symbol artwork centered ~64% of cell size
//   - theme-color accent stroke around symbol art for high-motion readability
// ---------------------------------------------------------------------------
function drawCell(
  ctx:       CanvasRenderingContext2D,
  x:         number,
  y:         number,
  size:      number,
  symbolId:  number,
  themeColor: string,
  img?:      HTMLImageElement,
): void {
  const pad = size * 0.04;
  const ix  = x + pad;
  const iy  = y + pad;
  const iw  = size - pad * 2;
  const ih  = size - pad * 2;
  const r   = size * 0.10;

  // Card background — vertical slate gradient (top-light, bottom-dark)
  const bg = ctx.createLinearGradient(ix, iy, ix, iy + ih);
  bg.addColorStop(0, '#1c2440');
  bg.addColorStop(1, '#0a0e1c');
  ctx.fillStyle = bg;
  roundRectPath(ctx, ix, iy, iw, ih, r);
  ctx.fill();

  // Top rim highlight — fake specular
  const rim = ctx.createLinearGradient(ix, iy, ix, iy + ih * 0.45);
  rim.addColorStop(0, 'rgba(180, 220, 255, 0.22)');
  rim.addColorStop(1, 'rgba(180, 220, 255, 0)');
  ctx.fillStyle = rim;
  roundRectPath(ctx, ix, iy, iw, ih * 0.45, r);
  ctx.fill();

  // Theme-color accent bottom blob for high-pay symbols (Bell+, Seven, WILD,
  // BARs, Scatter) — adds visual weight to rarer symbols
  const isHighPay = symbolId >= 4;
  if (isHighPay) {
    const accent = ctx.createRadialGradient(
      ix + iw / 2, iy + ih * 0.7, 0,
      ix + iw / 2, iy + ih * 0.7, iw * 0.6,
    );
    accent.addColorStop(0, themeColor + 'aa'); // semi-transparent
    accent.addColorStop(1, themeColor + '00');
    ctx.fillStyle = accent;
    roundRectPath(ctx, ix, iy, iw, ih, r);
    ctx.fill();
  }

  // Brass card outline
  ctx.strokeStyle = 'rgba(200, 154, 77, 0.55)';
  ctx.lineWidth   = size * 0.012;
  roundRectPath(ctx, ix, iy, iw, ih, r);
  ctx.stroke();

  // Inner contour outline — extra readability during motion
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth   = size * 0.008;
  roundRectPath(ctx, ix + size * 0.025, iy + size * 0.025, iw - size * 0.05, ih - size * 0.05, r * 0.85);
  ctx.stroke();

  // Symbol artwork
  if (img && img.complete && img.naturalWidth > 0) {
    const symSize = size * 0.64;
    const sx = x + (size - symSize) / 2;
    const sy = y + (size - symSize) / 2;
    // Draw the SVG twice — once as a darker drop-shadow, once as the real
    // symbol — for a subtle stamped-in-the-card depth without using actual
    // shadow filters (which Iris Xe can choke on).
    try {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(img, sx + size * 0.012, sy + size * 0.014, symSize, symSize);
      ctx.restore();
      ctx.drawImage(img, sx, sy, symSize, symSize);
    } catch {
      // Some SVGs can throw on certain browsers — silently fall through to
      // the unicode fallback below
    }
  } else {
    // Unicode fallback — gigantic, theme-coloured, high-contrast
    const fallback: Record<number, string> = {
      0: '🍒', 1: '🍋', 2: '🍊', 3: '🍇', 4: '🔔',
      5: 'BAR', 6: '7', 7: 'WILD', 8: 'BAR×2', 9: 'BAR×3', 10: '💰',
    };
    const text = fallback[symbolId] ?? '?';
    const isWord = text.length > 1 && !/^[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(text);
    ctx.font         = `900 ${Math.round(size * (isWord ? 0.22 : 0.48))}px system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Stroke first (high-contrast outline)
    ctx.strokeStyle = '#000000';
    ctx.lineWidth   = size * 0.04;
    ctx.lineJoin    = 'round';
    ctx.strokeText(text, x + size / 2, y + size / 2);

    // Fill — theme colour for high-pay, white for low-pay
    ctx.fillStyle = isHighPay ? themeColor : '#ffffff';
    ctx.fillText(text, x + size / 2, y + size / 2);
  }
}

// ---------------------------------------------------------------------------
// Build per-reel CanvasTexture from the strip
// ---------------------------------------------------------------------------
function buildReelTexture(strip: number[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  // Deep slate fill — what shows through any gaps
  ctx.fillStyle = '#080b18';
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  for (let k = 0; k < strip.length; k++) {
    const id    = strip[k];
    const asset = CLASSIC_SLOT_SYMBOL_ASSETS.find(a => a.id === id) ?? CLASSIC_SLOT_SYMBOL_ASSETS[0];
    const img   = imageCache.get(id);
    drawCell(ctx, 0, k * TILE_PX, TILE_PX, id, asset.themeColor, img);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace      = THREE.SRGBColorSpace;
  tex.minFilter       = THREE.LinearMipmapLinearFilter;
  tex.magFilter       = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS           = THREE.ClampToEdgeWrapping;
  tex.wrapT           = THREE.RepeatWrapping;        // seamless vertical scroll
  tex.repeat.set(1, VISIBLE_REPEAT);                 // show 3 cells at rest
  tex.offset.set(0, 1 - VISIBLE_REPEAT);             // align to top of strip
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Props (canonical SlotReels3DProps contract — DO NOT change shape)
// ---------------------------------------------------------------------------
export interface SlotReels3DProps {
  reels:           SpinResult['reels'] | null;
  isSpinning:      boolean;
  spinTrigger:     number;
  winningCells:    { reel: number; row: number }[];
  wildMultipliers: SpinResult['wildMultipliers'];
  scatterCells:    { reelIndex: number; rowIndex: number }[];
  onReelsSettled:  () => void;
  paytableId?:     string;
}

// ---------------------------------------------------------------------------
// SlotReels3D — must mount inside <Canvas>
// ---------------------------------------------------------------------------
export default function SlotReels3D({
  reels,
  isSpinning,
  spinTrigger,
  onReelsSettled,
  paytableId,
}: SlotReels3DProps): React.ReactElement {
  const { gl, scene, camera, size } = useThree();

  // The reel rig uses a FIXED-bounds OrthographicCamera (-5/5/-2.8/2.8) so the
  // 5-reel cluster stays framed at any modal width. R3F's viewport handling
  // (and drei's OrthographicCamera even with `manual`) was observed to drop
  // the projection bounds on viewport resize, leaving only the payline-glow
  // pixel at world origin visible — every reel mesh ends up outside the
  // implicit (-1/1) box. Re-assert the bounds on every size change.
  useEffect(() => {
    const orthoCam = camera as THREE.OrthographicCamera;
    if (orthoCam.isOrthographicCamera) {
      orthoCam.left   = -5.0;
      orthoCam.right  =  5.0;
      orthoCam.top    =  2.8;
      orthoCam.bottom = -2.8;
      orthoCam.near   =  0.1;
      orthoCam.far    = 30;
      orthoCam.zoom   = 1;
      orthoCam.updateProjectionMatrix();
    }
  }, [camera, size.width, size.height]);

  // Resolve strips for the active paytable
  const strips = useMemo<number[][]>(
    () => (paytableId === 'classic-3x5-bonus' ? BONUS_REEL_STRIPS : CLASSIC_REEL_STRIPS),
    [paytableId],
  );

  // -------------------------------------------------------------------------
  // Symbol image preload — gated state so textures rebuild AFTER SVGs load
  // -------------------------------------------------------------------------
  const [imagesReady, setImagesReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      Object.entries(SYMBOL_SVG_PATHS).map(([idStr, path]) =>
        loadSymbolImage(Number(idStr), path).catch(() => null),
      ),
    ).then(() => {
      if (!cancelled) setImagesReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  // -------------------------------------------------------------------------
  // Textures — 5 per-reel CanvasTextures. Built once images are loaded, then
  // rebuilt only if strips/paytable change. Disposed on unmount.
  // -------------------------------------------------------------------------
  const textures = useMemo<THREE.CanvasTexture[]>(
    () => strips.map(s => buildReelTexture(s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strips, imagesReady],
  );

  // -------------------------------------------------------------------------
  // Materials — one per reel, all share the same plane geometry
  // -------------------------------------------------------------------------
  const reelGeometry = useMemo(
    () => new THREE.PlaneGeometry(REEL_WIDTH, REEL_HEIGHT),
    [],
  );

  const reelMaterials = useMemo<THREE.MeshBasicMaterial[]>(
    () => textures.map(t => new THREE.MeshBasicMaterial({
      map:         t,
      side:        THREE.FrontSide,
      transparent: false,
    })),
    [textures],
  );

  // -------------------------------------------------------------------------
  // Layered FX geometry (all camera-facing transparent quads, module-scoped)
  // -------------------------------------------------------------------------
  // Top vignette
  const vignetteTopGeom = useMemo(
    () => new THREE.PlaneGeometry(REEL_PITCH * REEL_COUNT, CELL_WU * 0.6),
    [],
  );
  // Bottom vignette
  const vignetteBotGeom = useMemo(
    () => new THREE.PlaneGeometry(REEL_PITCH * REEL_COUNT, CELL_WU * 0.6),
    [],
  );
  // Center payline glow strip
  const paylineGlowGeom = useMemo(
    () => new THREE.PlaneGeometry(REEL_PITCH * REEL_COUNT + 0.4, 0.12),
    [],
  );
  // Outer frame border (4 thin strips)
  const frameGeom = useMemo(
    () => new THREE.PlaneGeometry(REEL_PITCH * REEL_COUNT + 0.5, REEL_HEIGHT + 0.5),
    [],
  );

  const vignetteTopTex = useMemo(() => makeVerticalGradientTexture(
    ['rgba(21, 9, 14, 0.92)', 'rgba(21, 9, 14, 0)'],
  ), []);
  const vignetteBotTex = useMemo(() => makeVerticalGradientTexture(
    ['rgba(21, 9, 14, 0)', 'rgba(21, 9, 14, 0.92)'],
  ), []);
  const paylineGlowTex = useMemo(() => makeHorizontalGradientTexture(
    ['rgba(255, 174, 0, 0)', 'rgba(255, 174, 0, 0.55)', 'rgba(255, 174, 0, 0)'],
  ), []);
  const frameBorderTex = useMemo(() => makeFrameBorderTexture(), []);

  const vignetteTopMat = useMemo(() => new THREE.MeshBasicMaterial({
    map: vignetteTopTex, transparent: true, depthWrite: false,
  }), [vignetteTopTex]);
  const vignetteBotMat = useMemo(() => new THREE.MeshBasicMaterial({
    map: vignetteBotTex, transparent: true, depthWrite: false,
  }), [vignetteBotTex]);
  const paylineGlowMat = useMemo(() => new THREE.MeshBasicMaterial({
    map: paylineGlowTex, transparent: true, depthWrite: false,
  }), [paylineGlowTex]);
  const frameBorderMat = useMemo(() => new THREE.MeshBasicMaterial({
    map: frameBorderTex, transparent: true, depthWrite: false,
  }), [frameBorderTex]);

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------
  const reelMeshRefs   = useRef<(THREE.Mesh | null)[]>(Array(REEL_COUNT).fill(null));
  const paylineMeshRef = useRef<THREE.Mesh | null>(null);
  const animState      = useRef<ReelAnim[]>(Array.from({ length: REEL_COUNT }, makeIdleAnim));
  const settledCount   = useRef(0);
  const prevTrigger    = useRef(spinTrigger);
  const onSettledRef   = useRef(onReelsSettled);

  useEffect(() => { onSettledRef.current = onReelsSettled; }, [onReelsSettled]);

  // -------------------------------------------------------------------------
  // Diagnostic + GPU pre-warm
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log('[SlotReels3D] mount — paytableId:', paytableId, 'imagesReady:', imagesReady);
    }
    const raf = requestAnimationFrame(() => {
      const gAny = gl as unknown as { compileAsync?: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown> };
      if (typeof gAny.compileAsync === 'function') {
        gAny.compileAsync(scene, camera).catch(() => { /* compile failure non-fatal */ });
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagesReady]);

  // -------------------------------------------------------------------------
  // Trigger spin on spinTrigger increment
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (spinTrigger === prevTrigger.current) return;
    prevTrigger.current = spinTrigger;

    const now = performance.now();
    settledCount.current = 0;

    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      a.phase            = PHASE_ACCEL;
      a.spinStart        = now;
      a.velocity         = 0;
      a.targetSet        = false;
      a.settled          = false;
      a.decelStartMs     = 0;
      a.decelStartOffset = 0;
      a.bounceStartMs    = 0;
      a.bounceBaseOffset = 0;

      // Bump map repeat to blur during spin
      const map = reelMaterials[r]?.map;
      if (map) {
        map.repeat.set(1, BLUR_REPEAT);
        // Shift offset so middle of compressed window stays roughly aligned
        map.offset.set(0, 1 - BLUR_REPEAT);
        map.needsUpdate = true;
      }
    }
  }, [spinTrigger, reelMaterials]);

  // -------------------------------------------------------------------------
  // Compute landing target when server result arrives.
  // No isSpinning guard — that path caused the 565e93d deadlock.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!reels) return;
    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      if (a.settled || a.targetSet) continue;

      const window3 = reels[r];
      if (!window3 || window3.length < 3) continue;

      const strip = strips[r];
      const p     = findStripPosition(strip, window3[0], window3[1], window3[2]);

      const landingOffset = offsetForStripPosition(p);

      // We accumulate offset DOWNWARD (subtract) during spin so the texture
      // appears to scroll up. landingOffset is in [0,1). We need to find the
      // smallest forward (smaller-than-current, since we're decrementing)
      // offset that's at least 0.5 strip-loops away from current to keep the
      // spin visually substantial.
      const cur     = a.offset;
      const minDist = 0.5;                                // half a strip-loop minimum
      // Walk forward (decrementing) until we land precisely on landingOffset
      // mod 1, with at least minDist of travel.
      let target = landingOffset;
      // Express target as cur − k − fraction. Find k such that
      //   cur − target − k  ≥  minDist
      const baseDelta = cur - target;        // could be negative
      const k         = Math.max(1, Math.ceil(minDist - baseDelta));
      a.targetOffset  = target - k;          // i.e. cur − target + k loops forward
      a.targetSet     = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reels]);

  // -------------------------------------------------------------------------
  // Abort-on-spin-failure safety. When `isSpinning` flips from true → false
  // WITHOUT all reels having settled (i.e. /spin failed and the modal's
  // catch block reset the spin lock), force-stop every unsettled reel at
  // its current strip position so the animation doesn't loop forever.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (isSpinning) return; // only act on the false-edge
    let anyForceStopped = false;
    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      if (a.settled) continue;
      // Snap visible window back to the cell its current offset lands on so
      // the player sees a clean idle state instead of a half-blurred mid-spin.
      const map = reelMaterials[r]?.map;
      if (map) {
        map.repeat.set(1, VISIBLE_REPEAT);
        map.needsUpdate = true;
      }
      a.phase   = PHASE_DONE;
      a.settled = true;
      anyForceStopped = true;
    }
    if (anyForceStopped) {
      settledCount.current = REEL_COUNT;
      // DO NOT call onReelsSettled here — the modal already handled the
      // error path and reset its own state. Calling onReelsSettled would
      // double-fire balance / win-celebration logic.
    }
  }, [isSpinning, reelMaterials]);

  const handleReelSettled = useCallback(() => {
    settledCount.current += 1;
    if (settledCount.current >= REEL_COUNT) {
      // Defer to next tick so the final frame paints first
      const cb = onSettledRef.current;
      setTimeout(() => cb(), 0);
    }
  }, []);

  // -------------------------------------------------------------------------
  // useFrame — pure scalar arithmetic, ZERO allocations
  // -------------------------------------------------------------------------
  useFrame((_, delta) => {
    const now = performance.now();

    for (let r = 0; r < REEL_COUNT; r++) {
      const a   = animState.current[r];
      const map = reelMaterials[r]?.map;
      if (!map || a.settled) continue;

      const elapsed = now - a.spinStart;

      switch (a.phase) {

        case PHASE_ACCEL: {
          const t = Math.min(elapsed / ACCEL_MS, 1);
          a.velocity = MAX_SCROLL_PER_SEC * easeInQuad(t);
          a.offset  -= a.velocity * delta;
          if (t >= 1) a.phase = PHASE_STEADY;
          break;
        }

        case PHASE_STEADY: {
          a.offset -= MAX_SCROLL_PER_SEC * delta;
          // Reel r enters DECEL after ACCEL_MS + STEADY_MIN_MS + r * STAGGER,
          // but ONLY when the server target has been set.
          const myDecelStartElapsed = ACCEL_MS + STEADY_MIN_MS + r * DECEL_STAGGER_MS;
          if (elapsed >= myDecelStartElapsed && a.targetSet) {
            a.phase            = PHASE_DECEL;
            a.decelStartMs     = now;
            a.decelStartOffset = a.offset;

            // Restore crisp texture repeat
            map.repeat.set(1, VISIBLE_REPEAT);
            // Don't snap offset — DECEL handles convergence
            map.needsUpdate = true;
          }
          break;
        }

        case PHASE_DECEL: {
          const t = Math.min((now - a.decelStartMs) / DECEL_MS, 1);
          a.offset = a.decelStartOffset + (a.targetOffset - a.decelStartOffset) * easeOutCubic(t);
          if (t >= 1) {
            a.offset           = a.targetOffset;
            a.phase            = PHASE_BOUNCE;
            a.bounceStartMs    = now;
            a.bounceBaseOffset = a.targetOffset;
          }
          break;
        }

        case PHASE_BOUNCE: {
          const t = Math.min((now - a.bounceStartMs) / BOUNCE_MS, 1);
          // Spring: overshoot 0.32 cells past target then ease back via easeOutBack
          const overshoot = BOUNCE_OVERSHOOT * (1 - easeOutBack(t));
          a.offset = a.bounceBaseOffset - overshoot;
          if (t >= 1) {
            a.offset  = a.bounceBaseOffset;
            a.phase   = PHASE_DONE;
            a.settled = true;
            handleReelSettled();
          }
          break;
        }
      }

      // Apply offset. RepeatWrapping handles loop seamlessly even with
      // negative values.
      map.offset.y = a.offset;
    }

    // Animate payline glow pulse during spin (subtle 2Hz sin)
    const pulseMesh = paylineMeshRef.current;
    if (pulseMesh) {
      const anySpinning = animState.current.some(a => !a.settled);
      const baseAlpha   = anySpinning ? 0.25 : 0.5;
      const pulse       = anySpinning ? (0.05 * Math.sin(now * 0.012)) : 0;
      (pulseMesh.material as THREE.MeshBasicMaterial).opacity = baseAlpha + pulse;
    }
  });

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      reelGeometry.dispose();
      vignetteTopGeom.dispose();
      vignetteBotGeom.dispose();
      paylineGlowGeom.dispose();
      frameGeom.dispose();
      vignetteTopMat.dispose();
      vignetteBotMat.dispose();
      paylineGlowMat.dispose();
      frameBorderMat.dispose();
      vignetteTopTex.dispose();
      vignetteBotTex.dispose();
      paylineGlowTex.dispose();
      frameBorderTex.dispose();
      for (const m of reelMaterials) { m.map?.dispose(); m.dispose(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Scene graph
  // -------------------------------------------------------------------------
  return (
    <group>
      {/* Reels */}
      {Array.from({ length: REEL_COUNT }, (_, r) => (
        <mesh
          key={`reel-${r}`}
          ref={(el) => { reelMeshRefs.current[r] = el; }}
          geometry={reelGeometry}
          material={reelMaterials[r]}
          position={[(r - (REEL_COUNT - 1) / 2) * REEL_PITCH, 0, 0]}
        />
      ))}

      {/* Centre payline glow — z=0.01 to render above reels */}
      <mesh
        ref={paylineMeshRef}
        geometry={paylineGlowGeom}
        material={paylineGlowMat}
        position={[0, 0, 0.01]}
      />

      {/* Top vignette — fakes drum curvature */}
      <mesh
        geometry={vignetteTopGeom}
        material={vignetteTopMat}
        position={[0, REEL_HEIGHT / 2 - CELL_WU * 0.3, 0.02]}
      />

      {/* Bottom vignette */}
      <mesh
        geometry={vignetteBotGeom}
        material={vignetteBotMat}
        position={[0, -REEL_HEIGHT / 2 + CELL_WU * 0.3, 0.02]}
      />

      {/* Outer frame — z=-0.01 to sit behind reels */}
      <mesh
        geometry={frameGeom}
        material={frameBorderMat}
        position={[0, 0, -0.01]}
      />
    </group>
  );
}

// ===========================================================================
// FX texture builders (module-scope, pure)
// ===========================================================================

function makeVerticalGradientTexture(stops: [string, string]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, stops[0]);
  g.addColorStop(1, stops[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function makeHorizontalGradientTexture(stops: string[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 4;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 512, 0);
  for (let i = 0; i < stops.length; i++) {
    g.addColorStop(i / (stops.length - 1), stops[i]);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function makeFrameBorderTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);

  // Inner dark frame
  ctx.strokeStyle = 'rgba(200, 154, 77, 0.18)';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, W - 16, H - 16);

  // Subtle inner highlight
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 2;
  ctx.strokeRect(14, 14, W - 28, H - 28);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
