'use client';

/**
 * SlotReels3D — per-cell-plane drum rig.
 *
 * Architecture (Phase 6.1.8 — "drum wheel"):
 *   Each reel is a Group containing PLANES_PER_DRUM PlaneGeometry quads
 *   arranged in a circle around the X-axis (horizontal drum axle). The
 *   drum rotates around X; the camera looks down the +Z axis, so:
 *     - angle=0 → plane faces camera (mid symbol)
 *     - angle=-STEP → plane slightly above (top symbol)
 *     - angle=+STEP → plane slightly below (bot symbol)
 *
 *   Each plane holds a MeshBasicMaterial pointing to one of 12 pre-built
 *   symbol textures (128×128px, built once per unique symbol ID). As the
 *   drum rotates, planes cycling through the back (angle≈π) get their
 *   texture swapped to the next strip symbol — exactly like a mechanical
 *   reel drum refreshing its faces.
 *
 *   Visible 3-row window: the front plane (mid) plus its two immediate
 *   neighbours (top/bot at ±STEP). Visual curvature from side planes
 *   (±2*STEP, ±3*STEP) visible at decreasing angles — matches cherry-charm.
 *
 * Camera: OrthographicCamera (SlotReelsCanvas) with bounds
 *   left=-8.5, right=8.5, top=2.2, bottom=-2.2.
 *   5 reels × 3.2wu spacing = 12.8wu + 2×1.5wu radius margin = 15.8wu fits.
 *
 * Animation phases per reel (group.rotation.x):
 *   ACCEL  200ms  0 → MAX_RPS easeInQuad
 *   STEADY hold MAX_RPS until DECEL_AT[r] and targetSet
 *   DECEL  600ms  stagger L→R, tween to targetAngle easeOutCubic
 *   POP    120ms  overshoot STEP/3 then spring back
 *
 * Iris Xe invariants:
 *   MeshBasicMaterial only · no ShaderMaterial · no shadows · no drei
 *   Text/Billboard · max 70 meshes (60 planes + 10 bezels) · no per-frame
 *   allocations (all texture refs pre-indexed, only pointer swaps in useFrame)
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
// Geometry constants
// ---------------------------------------------------------------------------
const REEL_COUNT      = 5;
const STRIP_LEN       = 84;

/** Drum planes per reel. Must divide evenly into 360°. 12 → 30° per step. */
const PLANES_PER_DRUM = 12;
const STEP            = (2 * Math.PI) / PLANES_PER_DRUM; // 30° in radians

/**
 * Drum radius. At 12 planes, adjacent plane edges meet at:
 *   chord = 2 × R × sin(π/12) ≈ 0.518 × R
 * CELL_WU ≈ 0.76wu at R=1.5 → planes nearly touch = no visible gaps at front.
 */
const DRUM_RADIUS = 1.5;  // wu

/** Each symbol plane: square face, fills one drum stop. */
const CELL_WU = 0.76;  // wu — slightly less than chord to avoid z-fighting at edges

/** Centre-to-centre reel spacing. Must exceed 2 × DRUM_RADIUS = 3wu. */
const REEL_SPACING = 3.2;  // wu

/** Bezel ring inner/outer radii (flat ring flush with drum edges). */
const BEZEL_INNER  = DRUM_RADIUS - 0.05;
const BEZEL_OUTER  = DRUM_RADIUS + 0.15;
// Bezel y-position: top/bot symbols sit at y=±DRUM_RADIUS*sin(STEP)≈±0.75wu.
// Add half-cell margin so the ring frames the outer edge of top/bot cells.
const BEZEL_HALF_H = DRUM_RADIUS * Math.sin(STEP) + CELL_WU * 0.5 + 0.06;

// ---------------------------------------------------------------------------
// Spin physics
// ---------------------------------------------------------------------------
/** Max rotations per second during steady spin. */
const MAX_RPS          = 4;
const MAX_RAD_PER_SEC  = MAX_RPS * 2 * Math.PI;

const ACCEL_MS = 200;
const DECEL_AT: [number, number, number, number, number] = [1800, 2200, 2600, 3000, 3400];
const DECEL_MS = 600;
const POP_MS   = 120;

/** Pop overshoot — 1/3 of a drum step. */
const POP_OVERSHOOT = STEP / 3;

// ---------------------------------------------------------------------------
// Texture constants
// ---------------------------------------------------------------------------
const TILE_PX = 128;

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
// Easing
// ---------------------------------------------------------------------------
function easeInQuad(t: number): number   { return t * t; }
function easeOutCubic(t: number): number { const u = 1 - t; return 1 - u * u * u; }

// ---------------------------------------------------------------------------
// Per-reel animation state — mutated by useFrame, never triggers React renders
// ---------------------------------------------------------------------------
interface ReelAnim {
  phase:         number;
  spinStart:     number;   // performance.now() at spin-press
  rotation:      number;   // unbounded radians applied to group.rotation.x
  velocity:      number;   // rad/s
  targetRot:     number;   // absolute rotation.x for landing
  targetSet:     boolean;
  decelStart:    number;   // rotation at DECEL entry
  popBase:       number;   // rotation at POP entry
  popStartMs:    number;
  settled:       boolean;
  // Texture-swap bookkeeping: which strip index is currently facing "backwards"
  // (being refreshed). Advances by 1 every 30° of rotation.
  backFaceIdx:   number;   // index into drum faces array (0..11)
  stripHead:     number;   // strip index currently assigned to face[backFaceIdx]
}

function makeIdleAnim(): ReelAnim {
  return {
    phase: PHASE_IDLE, spinStart: 0, rotation: 0, velocity: 0,
    targetRot: 0, targetSet: false, decelStart: 0,
    popBase: 0, popStartMs: 0, settled: true,
    backFaceIdx: 6, stripHead: 6,  // face 6 = opposite from face 0 (front)
  };
}

// ---------------------------------------------------------------------------
// Symbol emojis
// ---------------------------------------------------------------------------
const SYMBOL_EMOJIS: Record<number, string> = {
  0: '🍒', 1: '🍋', 2: '🍊', 3: '🍇', 4: '🔔',
  5: '🎰', 6: '7️⃣', 7: '🦈', 8: '🎰', 9: '🎰', 10: '💰',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

/**
 * Build a single symbol tile texture (TILE_PX × TILE_PX).
 * Purple rounded-corner card with emoji + label. Built once per symbolId.
 */
function buildSymbolTexture(symbolId: number): THREE.CanvasTexture {
  const asset = CLASSIC_SLOT_SYMBOL_ASSETS[symbolId] ?? CLASSIC_SLOT_SYMBOL_ASSETS[0];
  const emoji = SYMBOL_EMOJIS[symbolId] ?? '?';

  const canvas = document.createElement('canvas');
  canvas.width  = TILE_PX;
  canvas.height = TILE_PX;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = '#050a18';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);

  const pad = 5;
  const r   = 14;
  const w   = TILE_PX - pad * 2;
  const h   = TILE_PX - pad * 2;

  // Purple card
  ctx.fillStyle = '#6b3aa0';
  roundRectPath(ctx, pad, pad, w, h, r);
  ctx.fill();

  // Top highlight
  const grad = ctx.createLinearGradient(pad, pad, pad, pad + 28);
  grad.addColorStop(0, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  roundRectPath(ctx, pad, pad, w, h, r);
  ctx.fill();

  // Theme-color border
  ctx.strokeStyle = asset.themeColor;
  ctx.lineWidth   = 2.5;
  roundRectPath(ctx, pad, pad, w, h, r);
  ctx.stroke();

  // Emoji
  ctx.font         = `${Math.round(TILE_PX * 0.50)}px serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle    = '#ffffff';
  ctx.fillText(emoji, TILE_PX / 2, TILE_PX * 0.43);

  // Label
  ctx.font         = `bold ${Math.round(TILE_PX * 0.11)}px monospace`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle    = 'rgba(255,255,255,0.9)';
  ctx.fillText(asset.displayName.toUpperCase(), TILE_PX / 2, TILE_PX - 9);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace      = THREE.SRGBColorSpace;
  tex.minFilter       = THREE.LinearMipmapLinearFilter;
  tex.magFilter       = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Find strip position p where 3-row window = [top, mid, bot].
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

/**
 * Given strip position p (0..83), return the drum rotation.x where face 0
 * (at angle=0 = front) shows strip[p] as the mid symbol.
 *
 * The drum has PLANES_PER_DRUM=12 faces. Face k sits at base angle k*STEP.
 * After rotation r, face k's world angle = k*STEP + r.
 * Face 0 is at front when its world angle ≡ 0 (mod 2π).
 * We want face 0 to show strip[p], meaning the drum has been rotated to a
 * position where the strip head aligns with p.
 *
 * Since we accumulate rotation.x during spin, targetRot must be forward
 * from current position by at least one full revolution + the angular offset
 * to land on the desired face.
 */
function stripPosToAngle(p: number): number {
  // Map strip position 0..83 to one of 12 drum stops.
  const drumStop = Math.round(p * PLANES_PER_DRUM / STRIP_LEN) % PLANES_PER_DRUM;
  // drum.rotation.x needed for face 0 to show the symbol at drumStop:
  // face f's world angle = f*STEP + rotation.x.
  // Face 0 is at front when rotation.x ≡ 0 (mod 2π). But we want face drumStop
  // to be at front (world angle 0): drumStop*STEP + rotation.x ≡ 0
  // → rotation.x ≡ -drumStop*STEP (mod 2π) = (PLANES_PER_DRUM - drumStop) * STEP mod 2π.
  return ((PLANES_PER_DRUM - drumStop) % PLANES_PER_DRUM) * STEP;
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

  // Build one texture per unique symbol ID (0..10). Shared across all planes/reels.
  const symbolTextures = useMemo<Record<number, THREE.CanvasTexture>>(() => {
    const map: Record<number, THREE.CanvasTexture> = {};
    const ids = Object.keys(CLASSIC_SLOT_SYMBOL_ASSETS).map(Number);
    for (const id of ids) {
      map[id] = buildSymbolTexture(id);
    }
    return map;
  }, []);

  // Shared geometries
  const planeGeo  = useMemo(() => new THREE.PlaneGeometry(CELL_WU, CELL_WU), []);
  // Flat ring for bezels: RingGeometry(inner, outer, segments) in XY plane.
  // We'll rotate each ring -π/2 around X to make it horizontal (XZ plane).
  const bezelGeo  = useMemo(() => new THREE.RingGeometry(BEZEL_INNER, BEZEL_OUTER, 64), []);
  const bezelMat  = useMemo(() => new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  }), []);

  // Per-reel, per-face materials — each face gets its own material so we can
  // swap .map independently. 12 faces × 5 reels = 60 material instances.
  // Initialised pointing at the symbol for strip[faceIndex].
  const faceMaterials = useMemo<THREE.MeshBasicMaterial[][]>(() => {
    return Array.from({ length: REEL_COUNT }, (_, r) => {
      const strip = strips[r];
      return Array.from({ length: PLANES_PER_DRUM }, (_, f) => {
        const symbolId = strip[f % strip.length] ?? 0;
        const mat = new THREE.MeshBasicMaterial({
          map:  symbolTextures[symbolId] ?? symbolTextures[0],
          side: THREE.FrontSide,
          transparent: false,
        });
        return mat;
      });
    });
  }, [strips, symbolTextures]);

  // Refs to the drum Group nodes (one per reel)
  const drumRefs  = useRef<(THREE.Group | null)[]>(Array(REEL_COUNT).fill(null));
  // Refs to each plane mesh: [reel][face]
  const planeMeshRefs = useRef<(THREE.Mesh | null)[][]>(
    Array.from({ length: REEL_COUNT }, () => Array(PLANES_PER_DRUM).fill(null)),
  );

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
      console.log(
        '[SlotReels3D] mount drum-rig — PLANES_PER_DRUM:', PLANES_PER_DRUM,
        'DRUM_RADIUS:', DRUM_RADIUS, 'REEL_SPACING:', REEL_SPACING,
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

  // ── Start spin when spinTrigger increments ─────────────────────────────
  useEffect(() => {
    if (spinTrigger === prevTrigger.current) return;
    prevTrigger.current = spinTrigger;

    const now = performance.now();
    settledRef.current = 0;

    for (let r = 0; r < REEL_COUNT; r++) {
      const anim = animState.current[r];
      anim.phase     = PHASE_ACCEL;
      anim.spinStart = now;
      anim.velocity  = 0;
      anim.settled   = false;
      anim.targetSet = false;
      anim.backFaceIdx = (Math.round(anim.rotation / STEP) + PLANES_PER_DRUM / 2) % PLANES_PER_DRUM;
      anim.stripHead   = (Math.round(anim.rotation / STEP) + PLANES_PER_DRUM / 2) % STRIP_LEN;
    }
  }, [spinTrigger]);

  // ── Compute target rotations when server result arrives ─────────────────
  // No isSpinning guard — blocking on isSpinning causes deadlock (DECEL never fires).
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

      // Desired drum angle for mid symbol = p
      const desiredBaseAngle = stripPosToAngle(p);

      // Current rotation mod 2π
      const curMod = ((anim.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      // Forward delta to land at desiredBaseAngle
      let diff = ((desiredBaseAngle - curMod) + 2 * Math.PI) % (2 * Math.PI);
      // Guarantee at least one full revolution so the drum visibly spins
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

  // ── Per-frame animation ────────────────────────────────────────────────
  useFrame((_, delta) => {
    const now = performance.now();

    for (let r = 0; r < REEL_COUNT; r++) {
      const anim  = animState.current[r];
      const drum  = drumRefs.current[r];
      if (!drum || anim.settled) continue;

      const elapsed = now - anim.spinStart;
      const prevRot = anim.rotation;

      switch (anim.phase) {

        case PHASE_ACCEL: {
          const t = Math.min(elapsed / ACCEL_MS, 1);
          anim.velocity   = MAX_RAD_PER_SEC * easeInQuad(t);
          anim.rotation  += anim.velocity * delta;
          if (t >= 1) anim.phase = PHASE_STEADY;
          break;
        }

        case PHASE_STEADY: {
          anim.rotation += MAX_RAD_PER_SEC * delta;
          if (elapsed >= DECEL_AT[r] && anim.targetSet) {
            anim.phase      = PHASE_DECEL;
            anim.decelStart = anim.rotation;
          }
          break;
        }

        case PHASE_DECEL: {
          const decelElapsed = elapsed - DECEL_AT[r];
          const t = Math.min(decelElapsed / DECEL_MS, 1);
          anim.rotation = anim.decelStart + (anim.targetRot - anim.decelStart) * easeOutCubic(t);
          if (t >= 1) {
            anim.rotation  = anim.targetRot;
            anim.phase     = PHASE_POP;
            anim.popBase   = anim.targetRot;
            anim.popStartMs = now;
          }
          break;
        }

        case PHASE_POP: {
          const popElapsed = now - anim.popStartMs;
          const half       = POP_MS / 2;
          if (popElapsed < half) {
            const t = popElapsed / half;
            anim.rotation = anim.popBase + POP_OVERSHOOT * easeInQuad(t);
          } else {
            const t = Math.min((popElapsed - half) / half, 1);
            anim.rotation = anim.popBase + POP_OVERSHOOT * (1 - easeOutCubic(t));
          }
          if (popElapsed >= POP_MS) {
            anim.rotation = anim.popBase;
            anim.settled  = true;
            anim.phase    = PHASE_DONE;
            handleReelSettled();
          }
          break;
        }
      }

      // Apply rotation to drum group
      drum.rotation.x = anim.rotation;

      // ── Texture-swap: when a face crosses the "back" position (angle≈π),
      // assign it the next strip symbol. This keeps the visible faces
      // correct without rebuilding any textures.
      // Back position in local drum space = rotation such that face's world
      // angle ≡ π. Face k's world angle = k*STEP + drum.rotation.x.
      // We detect when any face passes through angle π (the back).
      const rotDelta = anim.rotation - prevRot;
      if (Math.abs(rotDelta) > 0) {
        const strips_r = strips[r];
        for (let f = 0; f < PLANES_PER_DRUM; f++) {
          const worldAnglePrev = f * STEP + prevRot;
          const worldAngleNow  = f * STEP + anim.rotation;
          // Detect crossing of π (mod 2π)
          const prevMod = ((worldAnglePrev % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const nowMod  = ((worldAngleNow  % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          // Crossing π when the interval (prevMod, nowMod) straddles π
          const crossedBack = rotDelta > 0
            ? (prevMod < Math.PI && nowMod >= Math.PI)
            : (prevMod >= Math.PI && nowMod < Math.PI);

          if (crossedBack) {
            // Advance strip head and assign new texture
            anim.stripHead = (anim.stripHead + (rotDelta > 0 ? 1 : -1) + STRIP_LEN) % STRIP_LEN;
            const symbolId = strips_r[anim.stripHead] ?? 0;
            const mat = faceMaterials[r][f];
            const newTex = symbolTextures[symbolId] ?? symbolTextures[0];
            if (mat.map !== newTex) {
              mat.map = newTex;
              mat.needsUpdate = true;
            }
          }
        }
      }
    }
  });

  // ── Dispose on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      planeGeo.dispose();
      bezelGeo.dispose();
      bezelMat.dispose();
      for (const row of faceMaterials) {
        for (const mat of row) mat.dispose();
      }
      for (const tex of Object.values(symbolTextures)) {
        tex.dispose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <group>
      {Array.from({ length: REEL_COUNT }, (_, r) => {
        const reelX = (r - (REEL_COUNT - 1) / 2) * REEL_SPACING;
        return (
          <group key={r} position={[reelX, 0, 0]}>
            {/* Drum group — rotation.x is animated */}
            <group ref={(el) => { drumRefs.current[r] = el; }}>
              {Array.from({ length: PLANES_PER_DRUM }, (_, f) => {
                const angle = f * STEP;
                const pz    = DRUM_RADIUS * Math.cos(angle);
                const py    = DRUM_RADIUS * Math.sin(angle);
                return (
                  <mesh
                    key={f}
                    ref={(el) => { planeMeshRefs.current[r][f] = el; }}
                    geometry={planeGeo}
                    material={faceMaterials[r][f]}
                    position={[0, py, pz]}
                    rotation={[angle, 0, 0]}
                  />
                );
              })}
            </group>

            {/* Bezel rings — static, not part of drum rotation group */}
            {/* Top bezel: at y = +BEZEL_HALF_H, facing horizontal (XZ) */}
            <mesh
              geometry={bezelGeo}
              material={bezelMat}
              position={[0, BEZEL_HALF_H, 0]}
              rotation={[-Math.PI / 2, 0, 0]}
            />
            {/* Bottom bezel */}
            <mesh
              geometry={bezelGeo}
              material={bezelMat}
              position={[0, -BEZEL_HALF_H, 0]}
              rotation={[-Math.PI / 2, 0, 0]}
            />
          </group>
        );
      })}
    </group>
  );
}
