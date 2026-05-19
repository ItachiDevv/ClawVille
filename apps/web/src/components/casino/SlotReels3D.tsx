'use client';

/**
 * SlotReels3D — R3F 3D reel rig using planar geometry.
 *
 * Architecture (Option B — planar):
 *   5 PlaneGeometry panels, one per reel.
 *   Each plane is CELL_WU wide × (CELL_WU * 3) tall, showing a 3-cell
 *   vertical window. The reel strip is a vertical texture: 1 column × STRIP_LEN
 *   rows (canvas width = TILE_PX, canvas height = STRIP_LEN * TILE_PX).
 *
 *   Spin = tween texture.offset.y (no mesh rotation).
 *   Middle visible cell = strip[p] is positioned by:
 *     offset.y = 1 - (p + 1.5) / STRIP_LEN   (with flipY=true default)
 *   wrapT=RepeatWrapping makes seamless vertical looping.
 *
 * Spin phases per reel i:
 *   ACCEL  (200 ms):          scroll speed 0 → MAX_STRIP_PER_SEC (ease-in)
 *   STEADY (until DECEL_AT):  hold MAX_STRIP_PER_SEC + blur (repeat.y compressed)
 *   DECEL  (600 ms, stagger): tween offset.y → targetOffset, ease-out-cubic
 *   POP    (120 ms):          overshoot 1.5 cells, spring back
 *
 * Blur trick: during ACCEL/STEADY texture.repeat.y = (3 + BLUR_EXTRA) / STRIP_LEN
 *   (shows more cells compressed vertically = motion blur illusion).
 *   Restored to 3 / STRIP_LEN at DECEL start — zero material program change.
 *
 * Camera: position [0, 0, 5], fov 65. At z=5, tan(32.5°)=0.637 → half-width
 *   3.185wu → full width 6.37wu, comfortably containing 5 reels × 1.0wu
 *   spacing = 4.0wu span.
 *
 * Iris Xe invariants:
 *   MeshBasicMaterial only · no per-frame allocations · no drei Text/Billboard
 *   · no ShaderMaterial · no shadows
 */

import { useRef, useEffect, useMemo, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  CLASSIC_REEL_STRIPS,
  BONUS_REEL_STRIPS,
  CLASSIC_SLOT_SYMBOL_ASSETS,
} from '@clawville/shared';
import type { SpinResult } from '@/lib/casino/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REEL_COUNT = 5;
const STRIP_LEN  = 84;

/** World-unit size of each visible cell (and reel width) */
const CELL_WU = 1.0;

/** Visible window height = 3 cells */
const PLANE_HEIGHT = CELL_WU * 3;

/** Horizontal gap between reel centres (wu) */
const REEL_SPACING = 1.0;

/** Scroll speed: full strip traversals per second during steady spin */
const MAX_STRIP_PER_SEC = 5.0; // 5 full loops/s = visually fast

/** Phase durations (ms) */
const ACCEL_MS = 200;
const DECEL_AT: [number, number, number, number, number] = [1800, 2200, 2600, 3000, 3400];
const DECEL_MS = 600;
const POP_MS   = 120;

/** Over-scroll for stop-pop (1.5 cell widths in strip-fraction units) */
const POP_OVERSHOOT = 1.5 / STRIP_LEN;

/** Motion-blur: show 3 + BLUR_EXTRA cells compressed into the window height */
const BLUR_EXTRA = 8;

/** Tile resolution — px per symbol tile in the texture canvas */
const TILE_PX = 128;
const TEX_W   = TILE_PX;                // 1 column
const TEX_H   = STRIP_LEN * TILE_PX;   // STRIP_LEN rows

/** UV repeat.y for normal (crisp) view */
const REPEAT_CRISP = 3 / STRIP_LEN;
/** UV repeat.y during spin (blur illusion) */
const REPEAT_BLUR  = (3 + BLUR_EXTRA) / STRIP_LEN;

// ---------------------------------------------------------------------------
// Phase constants
// ---------------------------------------------------------------------------
const PHASE_IDLE   = 0;
const PHASE_ACCEL  = 1;
const PHASE_STEADY = 2;
const PHASE_DECEL  = 3;
const PHASE_POP    = 4;
const PHASE_DONE   = 5;

// ---------------------------------------------------------------------------
// Easing (pure functions, zero allocations)
// ---------------------------------------------------------------------------
function easeInQuad(t: number): number   { return t * t; }
function easeOutCubic(t: number): number { const u = 1 - t; return 1 - u * u * u; }

// ---------------------------------------------------------------------------
// Per-reel animation state (mutated in useFrame, NOT React state)
// ---------------------------------------------------------------------------
interface ReelAnim {
  phase:            number;
  spinStart:        number;    // ms when spin began
  scrollPos:        number;    // current offset.y (unbounded; mod 1 at draw)
  velocity:         number;    // strip-fractions/second
  targetOffset:     number;    // landing offset.y fractional value (set when reels data arrives)
  targetSet:        boolean;
  decelScrollStart: number;    // scrollPos at start of DECEL
  decelAbsTarget:   number;    // absolute scrollPos target computed once at DECEL entry
  popBaseOffset:    number;    // scrollPos at start of POP phase
  popStartMs:       number;
  settled:          boolean;
}

function makeIdleAnim(): ReelAnim {
  return {
    phase: PHASE_IDLE, spinStart: 0, scrollPos: 0, velocity: 0,
    targetOffset: 0, targetSet: false, decelScrollStart: 0, decelAbsTarget: 0,
    popBaseOffset: 0, popStartMs: 0, settled: true,
  };
}

// ---------------------------------------------------------------------------
// Compute target offset.y from strip position p.
//
// Three.js CanvasTexture has flipY=true (default): canvas y=0 → UV v=1.
// We show 3 cells via repeat.y = 3/STRIP_LEN and scroll via offset.y.
// The visible UV range is [offset.y, offset.y + 3/STRIP_LEN].
// UV v = 1 - k/STRIP_LEN maps to canvas row k.
// Middle cell (p) centre UV = 1 - p/STRIP_LEN.
// We want middle cell at v_centre = offset.y + 1.5/STRIP_LEN.
// → offset.y = 1 - p/STRIP_LEN - 1.5/STRIP_LEN = 1 - (p + 1.5)/STRIP_LEN
// ---------------------------------------------------------------------------
function stripPositionToOffset(p: number): number {
  return 1 - (p + 1.5) / STRIP_LEN;
}

// ---------------------------------------------------------------------------
// Find strip position p where visible 3-row window = [top, mid, bot].
// Falls back to first mid match if no exact 3-way match.
// ---------------------------------------------------------------------------
function findStripPosition(strip: number[], top: number, mid: number, bot: number): number {
  const L = strip.length;
  for (let p = 0; p < L; p++) {
    if (strip[(p - 1 + L) % L] === top && strip[p] === mid && strip[(p + 1) % L] === bot) {
      return p;
    }
  }
  for (let p = 0; p < L; p++) {
    if (strip[p] === mid) return p;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Symbol emojis — local lookup avoids importing the full shared bundle tree
// ---------------------------------------------------------------------------
const SYMBOL_EMOJIS: Record<number, string> = {
  0: '🍒', 1: '🍋', 2: '🍊', 3: '🍇', 4: '🔔',
  5: '🎰', 6: '7️⃣', 7: '🦈', 8: '🎰', 9: '🎰', 10: '💰',
};

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Build reel texture — 1 column × STRIP_LEN rows vertical strip.
// Canvas y = k * TILE_PX → strip symbol k.
// flipY=true (default CanvasTexture): canvas y=0 ↔ UV v=1 (top of strip).
// ---------------------------------------------------------------------------
function buildReelTexture(strip: number[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width  = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#050a18';
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  for (let k = 0; k < STRIP_LEN; k++) {
    const symbolId = strip[k] ?? 0;
    const asset    = CLASSIC_SLOT_SYMBOL_ASSETS[symbolId] ?? CLASSIC_SLOT_SYMBOL_ASSETS[0];
    const emoji    = SYMBOL_EMOJIS[symbolId] ?? '?';

    const px  = 0;
    const py  = k * TILE_PX;
    const pad = 4;

    // Cell background
    ctx.fillStyle = 'rgba(17,32,61,0.88)';
    roundRectPath(ctx, px + pad, py + pad, TILE_PX - pad * 2, TILE_PX - pad * 2, 12);
    ctx.fill();

    // Theme color ring
    ctx.strokeStyle = asset.themeColor + '77';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Emoji
    ctx.font         = `${Math.round(TILE_PX * 0.50)}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = '#ffffff';
    ctx.fillText(emoji, px + TILE_PX / 2, py + TILE_PX * 0.46);

    // Symbol name label
    ctx.font         = `bold ${Math.round(TILE_PX * 0.11)}px monospace`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle    = asset.themeColor;
    ctx.fillText(asset.displayName.toUpperCase(), px + TILE_PX / 2, py + TILE_PX - 8);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace    = THREE.SRGBColorSpace;
  tex.minFilter     = THREE.LinearMipmapLinearFilter;
  tex.magFilter     = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS         = THREE.ClampToEdgeWrapping;
  tex.wrapT         = THREE.RepeatWrapping; // vertical scroll loops seamlessly
  // Start centred on strip position 0 (will be overridden by tween)
  tex.repeat.set(1, REPEAT_CRISP);
  tex.offset.set(0, stripPositionToOffset(0));
  return tex;
}

// ---------------------------------------------------------------------------
// Props
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
// SlotReels3D — R3F scene content (must live inside <Canvas>)
// ---------------------------------------------------------------------------
export default function SlotReels3D({
  reels,
  isSpinning,
  spinTrigger,
  onReelsSettled,
  paytableId,
}: SlotReels3DProps) {
  const { gl, scene, camera } = useThree();

  const strips = useMemo(
    () => paytableId === 'classic-3x5-bonus' ? BONUS_REEL_STRIPS : CLASSIC_REEL_STRIPS,
    [paytableId],
  );

  // Textures — built once per strip set
  const textures = useMemo<THREE.CanvasTexture[]>(() => {
    const built = Array.from({ length: REEL_COUNT }, (_, i) => buildReelTexture(strips[i]));
    if (process.env.NODE_ENV !== 'production') {
      console.log('[SlotReels3D] textures built:', built.length, built.map(t => `${t.image.width}x${t.image.height}`));
    }
    return built;
  }, [strips]);

  // Shared geometry: 1wu wide × 3wu tall plane
  const geometry = useMemo(() => new THREE.PlaneGeometry(CELL_WU, PLANE_HEIGHT), []);

  // Per-reel materials — MeshBasicMaterial, Iris Xe safe
  const materials = useMemo<THREE.MeshBasicMaterial[]>(
    () => textures.map(tex => new THREE.MeshBasicMaterial({
      map:         tex,
      side:        THREE.FrontSide,
      transparent: false,
    })),
    [textures],
  );

  const meshRefs     = useRef<(THREE.Mesh | null)[]>(Array(REEL_COUNT).fill(null));
  const animState    = useRef<ReelAnim[]>(Array.from({ length: REEL_COUNT }, makeIdleAnim));
  const settledRef   = useRef(0);
  const prevTrigger  = useRef(spinTrigger);
  const reelsRef     = useRef<SpinResult['reels'] | null>(null);
  const isSpinningRef = useRef(isSpinning);

  useEffect(() => { reelsRef.current = reels; }, [reels]);
  useEffect(() => { isSpinningRef.current = isSpinning; }, [isSpinning]);

  // Mount diagnostic
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[SlotReels3D] mount: meshRefs=', meshRefs.current.map(m => (m ? 'ok' : 'null')), 'materials=', materials.length, 'camera=', camera.position.toArray());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-warm GPU pipelines once after mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (typeof (gl as any).compileAsync === 'function') {
        (gl as any).compileAsync(scene, camera).catch((err: unknown) => {
          console.warn('[SlotReels3D] compileAsync failed:', err);
        });
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Start spin when spinTrigger increments ─────────────────────────────
  useEffect(() => {
    if (spinTrigger === prevTrigger.current) return;
    prevTrigger.current = spinTrigger;

    const now = performance.now();
    settledRef.current = 0;

    for (let r = 0; r < REEL_COUNT; r++) {
      const anim = animState.current[r];
      anim.phase           = PHASE_ACCEL;
      anim.spinStart       = now;
      anim.velocity        = 0;
      anim.settled         = false;
      anim.targetSet       = false;
      anim.decelScrollStart = 0;

      // Enable motion-blur repeat
      const map = materials[r].map;
      if (map) {
        map.repeat.set(1, REPEAT_BLUR);
        map.needsUpdate = true;
      }
    }
  }, [spinTrigger, materials]);

  // ── Compute target offsets when server result arrives ──────────────────
  // Guard: !reels only. Server result arrives while isSpinning=true (mid-animation);
  // blocking on isSpinning created a deadlock where targets were never set so
  // DECEL never fired, handleReelsSettled never fired, and reels stayed null forever.
  useEffect(() => {
    if (!reels) return;

    for (let r = 0; r < REEL_COUNT; r++) {
      const anim = animState.current[r];
      if (anim.settled || anim.targetSet) continue;

      const strip   = strips[r];
      const window3 = reels[r];
      if (!window3 || window3.length < 3) continue;

      const [top, mid, bot] = window3;
      const p = findStripPosition(strip, top, mid, bot);
      anim.targetOffset = stripPositionToOffset(p);
      anim.targetSet    = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reels]);

  const handleReelSettled = useCallback(() => {
    settledRef.current += 1;
    if (settledRef.current >= REEL_COUNT) {
      onReelsSettled();
    }
  }, [onReelsSettled]);

  // ── Per-frame animation ────────────────────────────────────────────────
  useFrame((_, delta) => {
    const now = performance.now();

    for (let r = 0; r < REEL_COUNT; r++) {
      const anim = animState.current[r];
      const mesh = meshRefs.current[r];
      if (!mesh || anim.settled) continue;

      const map = (mesh.material as THREE.MeshBasicMaterial).map;
      if (!map) continue;

      const elapsed = now - anim.spinStart;

      switch (anim.phase) {

        case PHASE_ACCEL: {
          const t = Math.min(elapsed / ACCEL_MS, 1);
          anim.velocity   = MAX_STRIP_PER_SEC * easeInQuad(t);
          anim.scrollPos += anim.velocity * delta;
          if (t >= 1) anim.phase = PHASE_STEADY;
          // Apply scroll (mod 1 to stay in [0, 1))
          map.offset.set(0, anim.scrollPos % 1);
          break;
        }

        case PHASE_STEADY: {
          anim.scrollPos += MAX_STRIP_PER_SEC * delta;
          map.offset.set(0, anim.scrollPos % 1);

          if (elapsed >= DECEL_AT[r] && anim.targetSet) {
            // Compute absolute decel target once at transition point
            const curFrac = anim.scrollPos % 1;
            let diff = (anim.targetOffset - curFrac + 1) % 1;
            if (diff < 0.5) diff += 1; // guarantee at least half a loop forward

            anim.phase            = PHASE_DECEL;
            anim.decelScrollStart = anim.scrollPos;
            anim.decelAbsTarget   = anim.scrollPos + diff;

            // Restore crisp repeat
            map.repeat.set(1, REPEAT_CRISP);
            map.needsUpdate = true;
          }
          break;
        }

        case PHASE_DECEL: {
          const decelElapsed = elapsed - DECEL_AT[r];
          const t = Math.min(decelElapsed / DECEL_MS, 1);

          const current  = anim.decelScrollStart + (anim.decelAbsTarget - anim.decelScrollStart) * easeOutCubic(t);
          anim.scrollPos = current;
          map.offset.set(0, current % 1);

          if (t >= 1) {
            anim.scrollPos     = anim.decelAbsTarget;
            anim.phase         = PHASE_POP;
            anim.popBaseOffset = anim.decelAbsTarget;
            anim.popStartMs    = now;
          }
          break;
        }

        case PHASE_POP: {
          const popElapsed = now - anim.popStartMs;
          const half       = POP_MS / 2;
          let offset: number;

          if (popElapsed < half) {
            offset = anim.popBaseOffset + POP_OVERSHOOT * easeInQuad(popElapsed / half);
          } else {
            const t2 = Math.min((popElapsed - half) / half, 1);
            offset = anim.popBaseOffset + POP_OVERSHOOT * (1 - easeOutCubic(t2));
          }

          anim.scrollPos = offset;
          map.offset.set(0, offset % 1);

          if (popElapsed >= POP_MS) {
            anim.scrollPos = anim.popBaseOffset;
            map.offset.set(0, anim.popBaseOffset % 1);
            anim.settled = true;
            anim.phase   = PHASE_DONE;
            handleReelSettled();
          }
          break;
        }
      }
    }
  });

  // ── Dispose on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      geometry.dispose();
      for (const mat of materials) {
        mat.map?.dispose();
        mat.dispose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <group>
      {Array.from({ length: REEL_COUNT }, (_, r) => (
        <mesh
          key={r}
          ref={(el) => { meshRefs.current[r] = el; }}
          geometry={geometry}
          material={materials[r]}
          position={[(r - (REEL_COUNT - 1) / 2) * REEL_SPACING, 0, 0]}
        />
      ))}

      {/* Thin separator lines between reels (cheap LineSegments, no shader) */}
      {Array.from({ length: REEL_COUNT - 1 }, (_, i) => {
        const x = (i - (REEL_COUNT - 2) / 2) * REEL_SPACING + REEL_SPACING / 2;
        return (
          <lineSegments key={`sep-${i}`} position={[x, 0, 0.01]}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[new Float32Array([0, -PLANE_HEIGHT / 2, 0, 0, PLANE_HEIGHT / 2, 0]), 3]}
              />
            </bufferGeometry>
            <lineBasicMaterial color={0x00ffe0} opacity={0.25} transparent />
          </lineSegments>
        );
      })}
    </group>
  );
}
