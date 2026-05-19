'use client';

/**
 * SlotReels3D — R3F 3D reel rig for the slot modal.
 *
 * Architecture:
 *   5 CylinderGeometry drums, one per reel. Each drum has radialSegments=84
 *   (one face per strip position) and heightSegments=3 (top/mid/bottom row).
 *
 *   Texture layout (TEX_W × TEX_H canvas, 84 columns × 3 rows):
 *     Column k, row r (r=0 at TOP of canvas, v=1 in THREE):
 *       r=0 → strip[(k-1+L)%L]   (top visible cell when k is centred)
 *       r=1 → strip[k]            (middle)
 *       r=2 → strip[(k+1)%L]      (bottom)
 *
 *   Rotation: drum.rotation.y = 2π × (p/L) → strip position p at front.
 *   THREE CylinderGeometry u=0 is at θ=0; u increases CCW when viewed from +Y.
 *   FrontSide material so the outer face renders toward the camera.
 *
 * Spin phases per reel i:
 *   ACCEL  (200 ms):          velocity 0 → MAX_RADS_PER_SEC, easeInQuad
 *   STEADY (until DECEL_AT):  hold MAX_RADS_PER_SEC
 *   DECEL  (600 ms, stagger): rotation lerp → targetRot, easeOutCubic
 *   POP    (120 ms):          over-rotate +POP_OVERSHOOT, spring back
 *
 * Blur trick: texture.repeat.y = BLUR_REPEAT during ACCEL/STEADY
 * (stretches symbol tiles vertically = motion blur). Restored to 1 on
 * DECEL start — no material program change, pure texture param update.
 *
 * Iris Xe invariants:
 *   MeshBasicMaterial only · no per-frame allocations · no drei Text/Billboard
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
const REEL_COUNT  = 5;
const STRIP_LEN   = 84;

/** World-unit height of the visible 3-cell window */
const CELL_WU         = 1.0;
const CYLINDER_HEIGHT = CELL_WU * 3; // 3 wu

/** Radius: circumference = STRIP_LEN cells, each CELL_WU wide */
const CYLINDER_RADIUS = (STRIP_LEN * CELL_WU) / (2 * Math.PI);

/** Max rotations per second during steady spin */
const MAX_RPS          = 6;
const MAX_RADS_PER_SEC = MAX_RPS * 2 * Math.PI;

/** Phase durations (ms) */
const ACCEL_MS  = 200;
const DECEL_AT  = [2000, 2400, 2800, 3200, 3600]; // elapsed ms when reel starts decelerating
const DECEL_MS  = 600;
const POP_MS    = 120;

/** Over-rotation for stop-pop (1.5 segment widths) */
const POP_OVERSHOOT = (2 * Math.PI / STRIP_LEN) * 1.5;

/** Texture repeat.y during spin for motion-blur illusion */
const BLUR_REPEAT = 0.35;

/** Tile resolution — px per symbol tile in the texture canvas */
const TILE_PX = 128;
const TEX_W   = STRIP_LEN * TILE_PX;
const TEX_H   = 3 * TILE_PX;

/** Horizontal gap between drum axes (wu) */
const REEL_SPACING = 1.3;

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
// Easing (pure functions, no allocations)
// ---------------------------------------------------------------------------
function easeInQuad(t: number): number  { return t * t; }
function easeOutCubic(t: number): number { const u = 1 - t; return 1 - u * u * u; }

// ---------------------------------------------------------------------------
// Per-reel animation state (mutated in useFrame, NOT React state)
// ---------------------------------------------------------------------------
interface ReelAnim {
  phase:         number;
  spinStart:     number;  // ms when spin began
  rotation:      number;  // unbounded radians
  velocity:      number;  // rads/sec
  targetRot:     number;  // landing rotation (set when reels data arrives)
  targetSet:     boolean; // true once targetRot is computed
  decelRotStart: number;  // rotation at start of DECEL phase
  popBaseRot:    number;  // rotation at start of POP phase
  popStartMs:    number;  // ms when POP started
  settled:       boolean;
}

function makeIdleAnim(): ReelAnim {
  return {
    phase: PHASE_IDLE, spinStart: 0, rotation: 0, velocity: 0,
    targetRot: 0, targetSet: false, decelRotStart: 0,
    popBaseRot: 0, popStartMs: 0, settled: true,
  };
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
// Build reel texture canvas — called once per reel at mount.
//
// Layout: TEX_W × TEX_H, 84 columns (u) × 3 rows (v).
// Row 0 (y=0 in canvas) corresponds to v=1 in THREE (top of cylinder).
// THREE CylinderGeometry: v=0=bottom, v=1=top.
// We store row 0 at canvas y=0 and flip the texture (flipY=true by default
// in CanvasTexture) so row 0 maps to v=1 (top). That means:
//   v=1 (canvas y=0):       top    cell → strip[(k-1+L)%L]
//   v=2/3 (canvas y=TILE):  middle cell → strip[k]
//   v=1/3 (canvas y=2TILE): bottom cell → strip[(k+1)%L]
// ---------------------------------------------------------------------------
function buildReelTexture(strip: number[]): THREE.CanvasTexture {
  const L = strip.length;

  const canvas = document.createElement('canvas');
  canvas.width  = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#050a18';
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  for (let k = 0; k < STRIP_LEN; k++) {
    for (let row = 0; row < 3; row++) {
      const symbolId =
        row === 0 ? strip[(k - 1 + L) % L]
        : row === 1 ? strip[k]
        : strip[(k + 1) % L];

      const asset = CLASSIC_SLOT_SYMBOL_ASSETS[symbolId] ?? CLASSIC_SLOT_SYMBOL_ASSETS[0];
      const emoji = SYMBOL_EMOJIS[symbolId] ?? '?';

      const px = k * TILE_PX;
      const py = row * TILE_PX;
      const pad = 4;

      // Cell background
      ctx.fillStyle = 'rgba(17,32,61,0.88)';
      roundRectPath(ctx, px + pad, py + pad, TILE_PX - pad * 2, TILE_PX - pad * 2, 12);
      ctx.fill();

      // Theme color ring
      ctx.strokeStyle = asset.themeColor + '77';
      ctx.lineWidth   = 2;
      ctx.stroke();

      // Emoji (synchronous, always available)
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
  }

  const tex = new THREE.CanvasTexture(canvas);
  // flipY=true (default) → canvas row 0 maps to v=1 (top of cylinder), correct.
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter  = THREE.LinearMipmapLinearFilter;
  tex.magFilter  = THREE.LinearFilter;
  tex.generateMipmaps = true;
  // wrapS=RepeatWrapping so that rotating past u=1 wraps to u=0 (seamless drum)
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
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
  const textures = useMemo<THREE.CanvasTexture[]>(
    () => Array.from({ length: REEL_COUNT }, (_, i) => buildReelTexture(strips[i])),
    [strips],
  );

  // Shared geometry
  const geometry = useMemo(() => new THREE.CylinderGeometry(
    CYLINDER_RADIUS, CYLINDER_RADIUS, CYLINDER_HEIGHT,
    STRIP_LEN, 3, true,
  ), []);

  // Per-reel materials
  const materials = useMemo<THREE.MeshBasicMaterial[]>(
    () => textures.map(tex => new THREE.MeshBasicMaterial({
      map:         tex,
      side:        THREE.FrontSide, // outer face toward camera
      transparent: true,
    })),
    [textures],
  );

  const meshRefs    = useRef<(THREE.Mesh | null)[]>(Array(REEL_COUNT).fill(null));
  const animState   = useRef<ReelAnim[]>(Array.from({ length: REEL_COUNT }, makeIdleAnim));
  const settledRef  = useRef(0);
  const prevTrigger = useRef(spinTrigger);
  // Track latest reels data for use in useFrame (avoids stale closure)
  const reelsRef    = useRef<SpinResult['reels'] | null>(null);
  const isSpinningRef = useRef(isSpinning);

  useEffect(() => { reelsRef.current = reels; }, [reels]);
  useEffect(() => { isSpinningRef.current = isSpinning; }, [isSpinning]);

  // Fire compileAsync once to pre-warm GPU pipelines
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (typeof (gl as any).compileAsync === 'function') {
        (gl as any).compileAsync(scene, camera).catch((err: unknown) => {
          console.warn('[SlotReels3D] compileAsync failed:', err);
        });
      }
    });
    return () => cancelAnimationFrame(raf);
    // stable R3F refs — intentionally omitted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start spin when spinTrigger increments
  useEffect(() => {
    if (spinTrigger === prevTrigger.current) return;
    prevTrigger.current = spinTrigger;

    const now = performance.now();
    settledRef.current = 0;

    for (let r = 0; r < REEL_COUNT; r++) {
      const anim = animState.current[r];
      anim.phase         = PHASE_ACCEL;
      anim.spinStart     = now;
      anim.velocity      = 0;
      anim.settled       = false;
      anim.targetSet     = false;
      anim.decelRotStart = 0;

      // Enable blur
      const map = materials[r].map;
      if (map) {
        map.repeat.set(1, BLUR_REPEAT);
        map.offset.set(0, (1 - BLUR_REPEAT) / 2);
        map.needsUpdate = true;
      }
    }
  }, [spinTrigger, materials]);

  // Compute target rotations when reels data lands
  useEffect(() => {
    if (isSpinning || !reels) return;

    for (let r = 0; r < REEL_COUNT; r++) {
      const anim = animState.current[r];
      if (anim.settled || anim.targetSet) continue;

      const strip   = strips[r];
      const window3 = reels[r];
      if (!window3 || window3.length < 3) continue;

      const [top, mid, bot] = window3;
      const p = findStripPosition(strip, top, mid, bot);

      // Target angle for this strip position
      const targetAngle = (2 * Math.PI * p) / STRIP_LEN;

      // Find nearest forward landing: current rotation mod 2π → next occurrence
      const curMod = ((anim.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let diff = ((targetAngle - curMod) + 2 * Math.PI) % (2 * Math.PI);
      // Guarantee at least a half-revolution before landing
      if (diff < Math.PI) diff += 2 * Math.PI;

      anim.targetRot = anim.rotation + diff;
      anim.targetSet = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpinning, reels]);

  const handleReelSettled = useCallback(() => {
    settledRef.current += 1;
    if (settledRef.current >= REEL_COUNT) {
      onReelsSettled();
    }
  }, [onReelsSettled]);

  useFrame((_, delta) => {
    const now = performance.now();

    for (let r = 0; r < REEL_COUNT; r++) {
      const anim = animState.current[r];
      const mesh = meshRefs.current[r];
      if (!mesh || anim.settled) continue;

      const elapsed = now - anim.spinStart;

      switch (anim.phase) {

        case PHASE_ACCEL: {
          const t = Math.min(elapsed / ACCEL_MS, 1);
          anim.velocity = MAX_RADS_PER_SEC * easeInQuad(t);
          anim.rotation += anim.velocity * delta;
          if (t >= 1) anim.phase = PHASE_STEADY;
          break;
        }

        case PHASE_STEADY: {
          anim.rotation += MAX_RADS_PER_SEC * delta;
          // Start decel only if we have the target rotation computed
          if (elapsed >= DECEL_AT[r] && anim.targetSet) {
            anim.phase         = PHASE_DECEL;
            anim.decelRotStart = anim.rotation;

            // Restore crisp texture
            const map = materials[r].map;
            if (map) {
              map.repeat.set(1, 1);
              map.offset.set(0, 0);
              map.needsUpdate = true;
            }
          }
          break;
        }

        case PHASE_DECEL: {
          const decelElapsed = elapsed - DECEL_AT[r];
          const t = Math.min(decelElapsed / DECEL_MS, 1);
          anim.rotation = anim.decelRotStart + (anim.targetRot - anim.decelRotStart) * easeOutCubic(t);

          if (t >= 1) {
            anim.rotation   = anim.targetRot;
            anim.phase      = PHASE_POP;
            anim.popBaseRot = anim.targetRot;
            anim.popStartMs = now;
          }
          break;
        }

        case PHASE_POP: {
          const popElapsed = now - anim.popStartMs;
          const half       = POP_MS / 2;

          if (popElapsed < half) {
            anim.rotation = anim.popBaseRot + POP_OVERSHOOT * easeInQuad(popElapsed / half);
          } else {
            const t2 = Math.min((popElapsed - half) / half, 1);
            anim.rotation = anim.popBaseRot + POP_OVERSHOOT * (1 - easeOutCubic(t2));
          }

          if (popElapsed >= POP_MS) {
            anim.rotation = anim.popBaseRot;
            anim.settled  = true;
            anim.phase    = PHASE_DONE;
            handleReelSettled();
          }
          break;
        }
      }

      mesh.rotation.y = anim.rotation;
    }
  });

  // Dispose resources on unmount
  useEffect(() => {
    return () => {
      geometry.dispose();
      for (const mat of materials) {
        mat.map?.dispose();
        mat.dispose();
      }
    };
    // stable refs, intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <group>
      {/* Ambient light so symbols are visible (MeshBasicMaterial ignores lights,
          but a subtle point light adds depth to the surrounding scene) */}
      <ambientLight intensity={0.6} />

      {Array.from({ length: REEL_COUNT }, (_, r) => (
        <mesh
          key={r}
          ref={(el) => { meshRefs.current[r] = el; }}
          geometry={geometry}
          material={materials[r]}
          position={[(r - (REEL_COUNT - 1) / 2) * REEL_SPACING, 0, 0]}
        />
      ))}
    </group>
  );
}
