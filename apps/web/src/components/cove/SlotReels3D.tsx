'use client';

/**
 * SlotReels3D — polished animated reel presentation layer (Phase 6.1.9).
 *
 * Replaces the previous per-cell-plane "3D drum" approach (df53dd3..bdbd124).
 * That rig tried to be a literal 3D mechanical drum and ended up looking like
 * scattered cards under orthographic projection.
 *
 * This rig is a flat camera-facing reel layer in the style of modern social
 * cove slots (Stake / Hacksaw / Pragmatic Play presentation quality) — the
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
import type { SpinResult } from '@/lib/cove/types';

// ---------------------------------------------------------------------------
// Constants — geometry
// ---------------------------------------------------------------------------
const REEL_COUNT   = 5;
const VISIBLE_ROWS = 3;
const STRIP_LEN    = 84;

const CELL_WU     = 1.7;                            // world units per cell (square) — bumped 1.5→1.7 Phase 6.1.15
const REEL_WIDTH  = CELL_WU;
const REEL_HEIGHT = CELL_WU * VISIBLE_ROWS;         // 5.1 wu
const REEL_GAP    = 0.10;                           // gap between reels — tightened 0.18→0.10
const REEL_PITCH  = REEL_WIDTH + REEL_GAP;          // centre-to-centre = 1.80 wu

// Total reel cluster span: 5 × 1.7 + 4 × 0.10 = 8.90 wu wide
// Centred at x=0 → reel r at x = (r - 2) × 1.80

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

/** Offset where cell `p` sits in the centre of the visible window.
 *
 * Phase 6.1.15 half-cell fix: the previous formula `1 - (p + N/2)/STRIP_LEN`
 * straddled cell boundaries (showed half + full + full + half instead of
 * 3 full cells). Adding the 0.5 aligns the visible window so cell `p` lands
 * at the exact middle row UV-centered. Derivation:
 *   Cell p UV-center  = (STRIP_LEN − p − 0.5) / STRIP_LEN
 *   Window UV-center  = offset + repeat/2 = offset + N/(2·STRIP_LEN)
 *   ⇒ offset = 1 − (p + 0.5 + N/2) / STRIP_LEN
 */
function offsetForStripPosition(p: number): number {
  return 1 - (p + 0.5 + VISIBLE_ROWS / 2) / STRIP_LEN;
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
// drawCell — Phase 6.1.15 CLEAN treatment (applies to BOTH classic + bonus).
//
// Reference: classic arcade fruit-slot. Symbol-first. No per-cell card frame,
// no corner ornaments, no double borders. Cream background, BIG symbol with
// a soft drop shadow, faint paper stripes for printed-cardboard feel, hairline
// dividers at top + bottom so row boundaries register at a glance.
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
  void themeColor;

  // 1. Cream background — 3-stop vertical gradient
  const bg = ctx.createLinearGradient(x, y, x, y + size);
  bg.addColorStop(0,   '#fef9ec');
  bg.addColorStop(0.5, '#fdf3d5');
  bg.addColorStop(1,   '#f4e3b3');
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, size, size);

  // 2. Faint vertical stripe texture — printed-paper feel
  ctx.fillStyle = 'rgba(180, 120, 40, 0.04)';
  const stripeStep = size * 0.08;
  for (let sx = 0; sx < size; sx += stripeStep) {
    ctx.fillRect(x + sx, y, 1, size);
  }

  // 3. Row dividers — top + bottom hairlines
  ctx.fillStyle = 'rgba(60, 30, 0, 0.12)';
  ctx.fillRect(x, y, size, 1);
  ctx.fillRect(x, y + size - 1, size, 1);

  // 4. Symbol artwork — BIG (84% of cell), soft drop shadow
  const isHighPay = symbolId >= 4;
  if (img && img.complete && img.naturalWidth > 0) {
    const symSize = size * 0.84;
    const sx = x + (size - symSize) / 2;
    const sy = y + (size - symSize) / 2;
    try {
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.drawImage(img, sx + size * 0.014, sy + size * 0.022, symSize, symSize);
      ctx.restore();
      ctx.drawImage(img, sx, sy, symSize, symSize);
    } catch {
      /* fall through to unicode fallback */
    }
  } else {
    // Unicode fallback (Phase 6.1.12 ClawVille roster — only shown if the
    // PNG image fails to decode; the real artwork is in /assets/slot-symbols).
    const fallback: Record<number, string> = {
      0: '🦞', 1: '🤖', 2: 'ELIZA', 3: '🐿️', 4: 'MILADY',
      5: 'BAR', 6: '7', 7: 'CLAW', 8: 'BAR×2', 9: 'BAR×3', 10: '🪙',
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

  // Cream fill — matches the new clean drawCell base
  ctx.fillStyle = '#fef9ec';
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
  /** In-scene 3D pull-lever SPIN trigger. When omitted, the lever is hidden. */
  onSpinClick?:    () => void;
  /** Disables the lever (spinning, locked-out, low balance, evaluating). */
  spinDisabled?:   boolean;
}

// ---------------------------------------------------------------------------
// SlotReels3D — must mount inside <Canvas>
// ---------------------------------------------------------------------------
export default function SlotReels3D({
  reels,
  isSpinning,
  spinTrigger,
  winningCells,
  scatterCells,
  onReelsSettled,
  paytableId,
  onSpinClick,
  spinDisabled,
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
      // World height is FIXED to fit cabinet + lever (5.65 + breathing room).
      // World WIDTH follows canvas aspect so cells stay square regardless of
      // modal width — wide modals just show more side breathing room.
      // Without this, ortho's stretch-to-fit distorts cells (Phase 6.1.15.1).
      const aspect = (size.width > 0 && size.height > 0) ? (size.width / size.height) : 1.78;
      const halfH  = 3.2;
      const halfW  = Math.max(halfH * aspect, 5.7);  // floor at 5.7 so lever stays in view on narrow modals
      orthoCam.left   = -halfW;
      orthoCam.right  =  halfW;
      orthoCam.top    =  halfH;
      orthoCam.bottom = -halfH;
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
  // Refs
  // -------------------------------------------------------------------------
  const reelMeshRefs   = useRef<(THREE.Mesh | null)[]>(Array(REEL_COUNT).fill(null));
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
  });

  // -------------------------------------------------------------------------
  // Dispose
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      reelGeometry.dispose();
      for (const m of reelMaterials) { m.map?.dispose(); m.dispose(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Cabinet geometry — bright brass frame + rivets (Phase 6.1.15.2)
  // Cabinet SCALES with canvas aspect so it fills the visible width on wide
  // modals instead of leaving dead teal space on the sides. Inner ledge
  // (between reel cluster and brass edge) grows with cabinet width.
  // -------------------------------------------------------------------------
  const clusterW       = REEL_PITCH * REEL_COUNT;             // 9.0 wu (fixed)
  const REEL_INNER_GAP = 0.55;                                // min ledge from reel to brass
  const aspect         = (size.width > 0 && size.height > 0) ? size.width / size.height : 1.78;
  const halfH          = 3.2;
  const halfW          = Math.max(halfH * aspect, 5.7);       // matches ortho fix
  // Cabinet width = full visible width minus a small breathing margin,
  // but never smaller than (reel cluster + inner gap).
  const frameW         = Math.max(halfW * 2 - 0.4, clusterW + REEL_INNER_GAP * 2);
  const frameH         = REEL_HEIGHT + REEL_INNER_GAP;

  const rivetPositions = useMemo<Array<[number, number]>>(() => {
    const out: Array<[number, number]> = [];
    const halfW = frameW / 2 - 0.12;
    const halfH = frameH / 2 - 0.12;
    const COLS = 11;
    for (let i = 0; i <= COLS; i++) {
      const t = i / COLS;
      const xs = -halfW + t * (2 * halfW);
      out.push([xs,  halfH]);
      out.push([xs, -halfH]);
    }
    const ROWS = 4;
    for (let i = 1; i < ROWS + 1; i++) {
      const t = i / (ROWS + 1);
      const ys = -halfH + t * (2 * halfH);
      out.push([-halfW, ys]);
      out.push([ halfW, ys]);
    }
    return out;
  }, [frameW, frameH]);

  // Phase 6.1.17 — paytable-aware cabinet theming.
  // Classic: brass-yellow (warm gold). Bonus: deep amber-red (rich casino).
  const isBonus = paytableId === 'classic-3x5-bonus';
  const CABINET_OUTER  = isBonus ? 0xc02038 : 0xf4b840;  // bonus: crimson red · classic: brass yellow
  const CABINET_BEZEL  = isBonus ? 0x6d0a1f : 0xb8801f;  // bonus: dark wine · classic: dark brass
  const CABINET_RIVET  = isBonus ? 0xfff1a3 : 0xfff1a3;  // gold rivets pop on both
  const CABINET_SHADOW = isBonus ? 0x1a0508 : 0x2a1810;  // bonus: near-black wine · classic: dark brown

  // -------------------------------------------------------------------------
  // Scene graph
  // -------------------------------------------------------------------------
  return (
    <group>
      {/* Cabinet outer frame */}
      <mesh position={[0, 0, -0.04]}>
        <planeGeometry args={[frameW + 0.18, frameH + 0.18]} />
        <meshBasicMaterial color={CABINET_OUTER} />
      </mesh>
      {/* Cabinet inner bezel — darker for depth */}
      <mesh position={[0, 0, -0.03]}>
        <planeGeometry args={[frameW, frameH]} />
        <meshBasicMaterial color={CABINET_BEZEL} />
      </mesh>
      {/* Inner shadow rim — thin dark line just outside reels */}
      <mesh position={[0, 0, -0.02]}>
        <planeGeometry args={[clusterW + 0.08, REEL_HEIGHT + 0.08]} />
        <meshBasicMaterial color={CABINET_SHADOW} />
      </mesh>

      {/* Brass rivets around the cabinet perimeter */}
      {rivetPositions.map(([rx, ry], i) => (
        <mesh key={`rivet-${i}`} position={[rx, ry, -0.025]}>
          <circleGeometry args={[0.06, 12]} />
          <meshBasicMaterial color={CABINET_RIVET} />
        </mesh>
      ))}

      {/* Reel column dividers */}
      {Array.from({ length: REEL_COUNT - 1 }, (_, i) => (
        <mesh
          key={`div-${i}`}
          position={[((i - (REEL_COUNT - 1) / 2) + 0.5) * REEL_PITCH, 0, 0.005]}
        >
          <planeGeometry args={[REEL_GAP * 0.5, REEL_HEIGHT]} />
          <meshBasicMaterial color={0x2a1810} />
        </mesh>
      ))}

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

      {/* Server-driven win cell highlights — animated marching marquee.
          `winningCells` covers BOTH classic and bonus paytables; bonus also
          has `scatterCells` for the Eliza Coin scatter (rendered with a
          distinct cyan tint via SlotWinHighlight's `variant`). */}
      {!isSpinning && winningCells.map(({ reel, row }, i) => {
        const cx = (reel - (REEL_COUNT - 1) / 2) * REEL_PITCH;
        const cy = (1 - row) * CELL_WU;
        return (
          <SlotWinHighlight
            key={`win-${reel}-${row}-${i}`}
            x={cx} y={cy} size={CELL_WU * 0.86}
            variant="line"
          />
        );
      })}
      {!isSpinning && scatterCells.map(({ reelIndex, rowIndex }, i) => {
        const cx = (reelIndex - (REEL_COUNT - 1) / 2) * REEL_PITCH;
        const cy = (1 - rowIndex) * CELL_WU;
        return (
          <SlotWinHighlight
            key={`scatter-${reelIndex}-${rowIndex}-${i}`}
            x={cx} y={cy} size={CELL_WU * 0.86}
            variant="scatter"
          />
        );
      })}

      {/* 3D pull-lever — replaces the DOM SPIN button. Click red ball to spin.
          Positioned just right of the rightmost reel — sits INSIDE the cabinet
          on wide aspects, sticks out the right edge on narrow ones. */}
      {onSpinClick && (
        <group position={[clusterW / 2 + 0.65, 0, 0]}>
          <SlotPullLever
            cabinetHalfH={frameH / 2}
            onPull={onSpinClick}
            disabled={spinDisabled ?? false}
          />
        </group>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// SlotPullLever — 3D pull-handle on the right side of the cabinet.
// Red ball at top, animated brass shaft, click ball to fire `onPull`.
// ---------------------------------------------------------------------------
function SlotPullLever({
  cabinetHalfH, onPull, disabled,
}: {
  cabinetHalfH: number;
  onPull: () => void;
  disabled: boolean;
}): React.ReactElement {
  const SHAFT_X      = 0;
  const SHAFT_W      = 0.16;
  const SHAFT_TOP    =  cabinetHalfH * 0.82;
  const SHAFT_BOTTOM = -cabinetHalfH * 0.82;
  const SHAFT_LEN    = SHAFT_TOP - SHAFT_BOTTOM;
  const BALL_R       = 0.21;
  const BALL_TRAVEL  = SHAFT_LEN * 0.55;

  const ballRef  = useRef<THREE.Mesh>(null);
  const shaftRef = useRef<THREE.Mesh>(null);
  const animRef  = useRef<{ active: boolean; startMs: number }>({ active: false, startMs: 0 });

  const handlePull = useCallback(() => {
    if (disabled || animRef.current.active) return;
    animRef.current.active  = true;
    animRef.current.startMs = performance.now();
    onPull();
  }, [disabled, onPull]);

  useFrame(() => {
    if (!animRef.current.active) return;
    const PULL_MS = 220, RETURN_MS = 380;
    const elapsed = performance.now() - animRef.current.startMs;
    let offset = 0;
    if (elapsed < PULL_MS) {
      const t = elapsed / PULL_MS;
      offset = -BALL_TRAVEL * easeOutCubic(t);
    } else if (elapsed < PULL_MS + RETURN_MS) {
      const t = (elapsed - PULL_MS) / RETURN_MS;
      offset = -BALL_TRAVEL * (1 - easeOutBack(t));
    } else {
      animRef.current.active = false;
      offset = 0;
    }
    if (ballRef.current)  ballRef.current.position.y  = SHAFT_TOP + offset;
    if (shaftRef.current) {
      const newLen = SHAFT_LEN + offset;
      shaftRef.current.position.y = SHAFT_BOTTOM + newLen / 2;
      shaftRef.current.scale.y    = Math.max(0.01, newLen / SHAFT_LEN);
    }
  });

  return (
    <group>
      {/* Shaft socket at bottom */}
      <mesh position={[SHAFT_X, SHAFT_BOTTOM - 0.05, 0]}>
        <circleGeometry args={[SHAFT_W * 1.4, 16]} />
        <meshBasicMaterial color={0x4a2818} />
      </mesh>
      {/* Shaft — scales with pull */}
      <mesh ref={shaftRef} position={[SHAFT_X, (SHAFT_TOP + SHAFT_BOTTOM) / 2, 0]}>
        <planeGeometry args={[SHAFT_W, SHAFT_LEN]} />
        <meshBasicMaterial color={0xd9a55a} />
      </mesh>
      {/* Shaft highlight stripe */}
      <mesh position={[SHAFT_X - SHAFT_W * 0.22, (SHAFT_TOP + SHAFT_BOTTOM) / 2, 0.001]}>
        <planeGeometry args={[SHAFT_W * 0.22, SHAFT_LEN]} />
        <meshBasicMaterial color={0xfff1a3} transparent opacity={0.55} />
      </mesh>
      {/* Ball shadow disc */}
      <mesh position={[SHAFT_X + 0.04, SHAFT_TOP - 0.05, 0.005]}>
        <circleGeometry args={[BALL_R * 1.08, 24]} />
        <meshBasicMaterial color={0x2a0808} transparent opacity={0.55} />
      </mesh>
      {/* Ball tip — clickable */}
      <mesh
        ref={ballRef}
        position={[SHAFT_X, SHAFT_TOP, 0.01]}
        onPointerDown={(e) => { e.stopPropagation(); handlePull(); }}
        onPointerOver={() => { document.body.style.cursor = disabled ? 'not-allowed' : 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = 'default'; }}
      >
        <circleGeometry args={[BALL_R, 24]} />
        <meshBasicMaterial color={disabled ? 0x6a3030 : 0xe53935} />
      </mesh>
      {/* Ball specular highlight */}
      <mesh position={[SHAFT_X - BALL_R * 0.3, SHAFT_TOP + BALL_R * 0.25, 0.02]}>
        <circleGeometry args={[BALL_R * 0.32, 16]} />
        <meshBasicMaterial color={0xffffff} transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// SlotWinHighlight — animated marching marquee frame around a winning cell.
// `variant="line"`    → yellow (default line wins)
// `variant="scatter"` → cyan   (bonus paytable scatters)
// ---------------------------------------------------------------------------
function SlotWinHighlight({ x, y, size, variant }: {
  x: number; y: number; size: number;
  variant: 'line' | 'scatter';
}): React.ReactElement {
  const rootRef  = useRef<THREE.Group>(null);
  const haloRef  = useRef<THREE.Mesh>(null);
  const sideRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const dotRefs  = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const startMs  = useRef(performance.now());

  const frameColor = variant === 'scatter' ? 0x00d4ff : 0xffd54f;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const elapsed = performance.now() - startMs.current;

    // Entry scale-pop — 320ms easeOutBack 0 → 1.0 (overshoots ~1.15)
    const ENTRY_MS = 320;
    let entry = 1;
    if (elapsed < ENTRY_MS) {
      entry = easeOutBack(elapsed / ENTRY_MS);
    }
    if (rootRef.current) rootRef.current.scale.setScalar(entry);

    // Halo — pulse scale + alpha
    const haloPulse = 0.5 + 0.5 * Math.sin(t * 5);
    if (haloRef.current) {
      const s = 1.0 + 0.12 * haloPulse;
      haloRef.current.scale.set(s, s, 1);
      (haloRef.current.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.4 * haloPulse;
    }

    // Sides — chasing wave
    for (let i = 0; i < 4; i++) {
      const m = sideRefs[i].current;
      if (!m) continue;
      const wave = 0.55 + 0.45 * Math.sin((t * 4) - i * (Math.PI / 2));
      (m.material as THREE.MeshBasicMaterial).opacity = wave;
    }

    // Corner dots — synced strobe
    const dotPulse = 0.6 + 0.4 * Math.abs(Math.sin(t * 7));
    for (let i = 0; i < 4; i++) {
      const m = dotRefs[i].current;
      if (!m) continue;
      const s = 0.85 + 0.3 * dotPulse;
      m.scale.set(s, s, 1);
      (m.material as THREE.MeshBasicMaterial).opacity = dotPulse;
    }
  });

  const halfS = size / 2;
  const T     = size * 0.07;

  return (
    <group ref={rootRef} position={[x, y, 0.035]} scale={[0, 0, 0]}>
      <mesh ref={haloRef}>
        <planeGeometry args={[size * 1.20, size * 1.20]} />
        <meshBasicMaterial color={frameColor} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <mesh ref={sideRefs[0]} position={[0, halfS - T / 2, 0.001]}>
        <planeGeometry args={[size, T]} />
        <meshBasicMaterial color={frameColor} transparent opacity={1} />
      </mesh>
      <mesh ref={sideRefs[1]} position={[halfS - T / 2, 0, 0.001]}>
        <planeGeometry args={[T, size]} />
        <meshBasicMaterial color={frameColor} transparent opacity={1} />
      </mesh>
      <mesh ref={sideRefs[2]} position={[0, -halfS + T / 2, 0.001]}>
        <planeGeometry args={[size, T]} />
        <meshBasicMaterial color={frameColor} transparent opacity={1} />
      </mesh>
      <mesh ref={sideRefs[3]} position={[-halfS + T / 2, 0, 0.001]}>
        <planeGeometry args={[T, size]} />
        <meshBasicMaterial color={frameColor} transparent opacity={1} />
      </mesh>
      {([[-halfS, halfS], [halfS, halfS], [-halfS, -halfS], [halfS, -halfS]] as Array<[number, number]>).map(([cx, cy], i) => (
        <mesh key={i} ref={dotRefs[i]} position={[cx, cy, 0.002]}>
          <circleGeometry args={[T * 1.4, 14]} />
          <meshBasicMaterial color={0xffffff} transparent opacity={1} />
        </mesh>
      ))}
    </group>
  );
}

// FX texture builders removed Phase 6.1.15 — vignettes + frame-border + payline
// glow were replaced by procedural brass cabinet + animated SlotWinHighlight.
