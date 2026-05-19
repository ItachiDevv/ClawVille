'use client';

/**
 * SlotReels3D — R3F 3D cylinder drum reel rig.
 *
 * Geometry: 5 CylinderGeometry drums, Y-axis vertical, rotating around Y.
 *   Each drum: radius = STRIP_LEN×CELL_WU / 2π ≈ 13.37 wu, height = 3 wu.
 *   84 radial segments (one per strip position), 3 height segments, open-ended.
 *
 * Texture layout (TEX_W × TEX_H canvas, 84 columns × 3 rows):
 *   Column k → strip position k (shown at rotation.y = 2π×k/STRIP_LEN).
 *   Row 0 → top cell strip[k-1], row 1 → middle strip[k], row 2 → bottom strip[k+1].
 *   wrapS=RepeatWrapping makes the drum wrap seamlessly.
 *
 * Camera: position [0, 0, 120], fov=60°.
 *   Viewport half-width = 120×tan(30°) = 69.3 wu, full = 138.6 wu.
 *   5 reels × 27.5 wu spacing = 137.5 wu total — fits with 1 wu margin.
 *
 * Bezel rings: RingGeometry(r-0.1, r+0.1, 64) at y=±CYLINDER_HEIGHT/2, rotation.x=-π/2 → horizontal.
 *
 * Iris Xe invariants:
 *   MeshBasicMaterial only · no per-frame allocations · no drei Text/Billboard
 *   · no ShaderMaterial · no shadows · DPR cap handled by SlotReelsCanvas
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

const CELL_WU         = 1.0;
const CYLINDER_HEIGHT = CELL_WU * 3; // 3 wu visible window

/** Circumference = STRIP_LEN×CELL_WU → radius = C / 2π ≈ 13.37 wu */
const CYLINDER_RADIUS = (STRIP_LEN * CELL_WU) / (2 * Math.PI);

/** Centre-to-centre spacing. Must exceed 2×CYLINDER_RADIUS (26.74 wu). */
const REEL_SPACING = 27.5; // wu

/** Max rotations per second during steady spin */
const MAX_RPS          = 6;
const MAX_RADS_PER_SEC = MAX_RPS * 2 * Math.PI;

/** Phase durations (ms) */
const ACCEL_MS = 200;
const DECEL_AT: [number, number, number, number, number] = [1800, 2200, 2600, 3000, 3400];
const DECEL_MS = 600;
const POP_MS   = 120;

/** Over-rotation for stop-pop (1.5 segment widths in radians) */
const POP_OVERSHOOT = (2 * Math.PI / STRIP_LEN) * 1.5;

/** Texture repeat.y during spin for motion-blur illusion */
const BLUR_REPEAT = 0.35;

/** Tile resolution — px per symbol tile */
const TILE_PX = 128;
const TEX_W   = STRIP_LEN * TILE_PX; // 84 columns
const TEX_H   = 3 * TILE_PX;         // 3 rows

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
  phase:         number;
  spinStart:     number;
  rotation:      number;  // unbounded radians applied to mesh.rotation.y
  velocity:      number;  // rads/sec
  targetRot:     number;
  targetSet:     boolean;
  decelRotStart: number;
  popBaseRot:    number;
  popStartMs:    number;
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
// Symbol emojis
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
// Build reel texture — 84 columns × 3 rows.
// Column k: row0=strip[k-1] (top), row1=strip[k] (mid), row2=strip[k+1] (bot).
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

      const px  = k * TILE_PX;
      const py  = row * TILE_PX;
      const pad = 6;

      // Purple rounded-corner cell background
      ctx.fillStyle = '#6b3aa0';
      roundRectPath(ctx, px + pad, py + pad, TILE_PX - pad * 2, TILE_PX - pad * 2, 16);
      ctx.fill();

      // Soft top highlight for depth
      const grad = ctx.createLinearGradient(px + pad, py + pad, px + pad, py + pad + 28);
      grad.addColorStop(0, 'rgba(255,255,255,0.18)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      roundRectPath(ctx, px + pad, py + pad, TILE_PX - pad * 2, TILE_PX - pad * 2, 16);
      ctx.fill();

      // Theme-color border ring
      ctx.strokeStyle = asset.themeColor;
      ctx.lineWidth   = 2.5;
      roundRectPath(ctx, px + pad, py + pad, TILE_PX - pad * 2, TILE_PX - pad * 2, 16);
      ctx.stroke();

      // Emoji
      ctx.font         = `${Math.round(TILE_PX * 0.50)}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#ffffff';
      ctx.fillText(emoji, px + TILE_PX / 2, py + TILE_PX * 0.44);

      // Symbol name label
      ctx.font         = `bold ${Math.round(TILE_PX * 0.11)}px monospace`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle    = 'rgba(255,255,255,0.9)';
      ctx.fillText(asset.displayName.toUpperCase(), px + TILE_PX / 2, py + TILE_PX - 9);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace      = THREE.SRGBColorSpace;
  tex.minFilter       = THREE.LinearMipmapLinearFilter;
  tex.magFilter       = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS           = THREE.RepeatWrapping; // seamless horizontal wrap for rotating drum
  tex.wrapT           = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Find strip column where 3-row window = [top, mid, bot]
// ---------------------------------------------------------------------------
function findStripPosition(strip: number[], top: number, mid: number, bot: number): number {
  const L = strip.length;
  for (let k = 0; k < L; k++) {
    if (strip[(k - 1 + L) % L] === top && strip[k] === mid && strip[(k + 1) % L] === bot) {
      return k;
    }
  }
  for (let k = 0; k < L; k++) {
    if (strip[k] === mid) return k;
  }
  return 0;
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

  const textures = useMemo<THREE.CanvasTexture[]>(
    () => Array.from({ length: REEL_COUNT }, (_, i) => buildReelTexture(strips[i])),
    [strips],
  );

  // Shared drum geometry
  const geometry = useMemo(() => new THREE.CylinderGeometry(
    CYLINDER_RADIUS, CYLINDER_RADIUS, CYLINDER_HEIGHT,
    STRIP_LEN, 3, true, // radialSegs=84, heightSegs=3, openEnded=true
  ), []);

  // Bezel ring geometry — flat RingGeometry at drum top/bottom edges, horizontal
  const bezelGeometry = useMemo(() => new THREE.RingGeometry(
    CYLINDER_RADIUS - 0.1, CYLINDER_RADIUS + 0.1, 64,
  ), []);

  const bezelMaterial = useMemo(() => new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  }), []);

  const materials = useMemo<THREE.MeshBasicMaterial[]>(
    () => textures.map(tex => new THREE.MeshBasicMaterial({
      map:         tex,
      side:        THREE.FrontSide,
      transparent: false,
    })),
    [textures],
  );

  const meshRefs      = useRef<(THREE.Mesh | null)[]>(Array(REEL_COUNT).fill(null));
  const animState     = useRef<ReelAnim[]>(Array.from({ length: REEL_COUNT }, makeIdleAnim));
  const settledRef    = useRef(0);
  const prevTrigger   = useRef(spinTrigger);
  const reelsRef      = useRef<SpinResult['reels'] | null>(null);
  const isSpinningRef = useRef(isSpinning);

  useEffect(() => { reelsRef.current = reels; }, [reels]);
  useEffect(() => { isSpinningRef.current = isSpinning; }, [isSpinning]);

  // Mount diagnostic
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        '[SlotReels3D] mount — CYLINDER_RADIUS:', CYLINDER_RADIUS.toFixed(2),
        'REEL_SPACING:', REEL_SPACING,
        'camera:', camera.position.toArray(),
      );
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

      const map = materials[r].map;
      if (map) {
        map.repeat.set(1, BLUR_REPEAT);
        map.offset.set(0, (1 - BLUR_REPEAT) / 2);
        map.needsUpdate = true;
      }
    }
  }, [spinTrigger, materials]);

  // Compute target rotations when server result arrives.
  // No isSpinning guard — that causes a deadlock where DECEL never fires.
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

      const targetAngle = (2 * Math.PI * p) / STRIP_LEN;

      const curMod = ((anim.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let diff = ((targetAngle - curMod) + 2 * Math.PI) % (2 * Math.PI);
      if (diff < Math.PI) diff += 2 * Math.PI;

      anim.targetRot = anim.rotation + diff;
      anim.targetSet = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reels]);

  const handleReelSettled = useCallback(() => {
    settledRef.current += 1;
    if (settledRef.current >= REEL_COUNT) {
      onReelsSettled();
    }
  }, [onReelsSettled]);

  // Per-frame animation
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
          anim.velocity  = MAX_RADS_PER_SEC * easeInQuad(t);
          anim.rotation += anim.velocity * delta;
          if (t >= 1) anim.phase = PHASE_STEADY;
          break;
        }

        case PHASE_STEADY: {
          anim.rotation += MAX_RADS_PER_SEC * delta;
          if (elapsed >= DECEL_AT[r] && anim.targetSet) {
            anim.phase         = PHASE_DECEL;
            anim.decelRotStart = anim.rotation;

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

  // Dispose on unmount
  useEffect(() => {
    return () => {
      geometry.dispose();
      bezelGeometry.dispose();
      bezelMaterial.dispose();
      for (const mat of materials) {
        mat.map?.dispose();
        mat.dispose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <group>
      {Array.from({ length: REEL_COUNT }, (_, r) => {
        const xPos = (r - (REEL_COUNT - 1) / 2) * REEL_SPACING;
        return (
          <group key={r} position={[xPos, 0, 0]}>
            {/* Drum cylinder */}
            <mesh
              ref={(el) => { meshRefs.current[r] = el; }}
              geometry={geometry}
              material={materials[r]}
            />
            {/* Top bezel ring — RingGeometry lies in XY plane, rotate -π/2 on X → XZ plane (horizontal) */}
            <mesh
              geometry={bezelGeometry}
              material={bezelMaterial}
              position={[0, CYLINDER_HEIGHT / 2, 0]}
              rotation={[-Math.PI / 2, 0, 0]}
            />
            {/* Bottom bezel ring */}
            <mesh
              geometry={bezelGeometry}
              material={bezelMaterial}
              position={[0, -CYLINDER_HEIGHT / 2, 0]}
              rotation={[-Math.PI / 2, 0, 0]}
            />
          </group>
        );
      })}
    </group>
  );
}
