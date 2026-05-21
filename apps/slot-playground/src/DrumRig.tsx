/**
 * DrumRig — true 3D drum with per-character billboard sprites.
 *
 * Previous cylinder attempts baked symbols into a wraparound texture and
 * looked unreadable because 84 cells × 4° arc = streaks. This version
 * decouples VISIBLE-cell-count from STRIP-position-count:
 *
 *   • 8 PlaneGeometry symbols arranged in a circle around the drum's
 *     HORIZONTAL X-axis (radius 1.4wu). Each plane is its own mesh with
 *     a transparent character PNG texture.
 *   • Drum group rotates around X. Symbols orbit. Camera sees the front
 *     arc — usually 3 symbols at any moment (top / middle / bottom of
 *     the visible window).
 *   • TorusGeometry bezel rings at the LEFT and RIGHT face of the drum
 *     (not top/bottom — the drum's axis is horizontal, so "ends" point
 *     left/right). Sells the 3D drum body.
 *   • 84-cell virtual strip drives WHICH 8 symbols are loaded per spin:
 *     before each spin, build the 8-symbol roster from a window of the
 *     strip centered on the landing position. So the visible 3 symbols
 *     at rest match reels[r] = [top, mid, bot] byte-identically.
 *
 * The drum APPEARS 3D (planes orbit, you see the arc, bezels frame the
 * ends) but each cell is a flat plane with full-size readable artwork.
 */

import { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useControls, folder } from 'leva';
import * as THREE from 'three';
import type { SlotRigProps } from './types';
import { CLASSIC_REEL_STRIPS, SYMBOL_ASSETS, STRIP_LEN } from './constants';

// ---------------------------------------------------------------------------
// Constants — geometry
// ---------------------------------------------------------------------------
const REEL_COUNT    = 5;
const CELLS_PER_DRUM = 8;            // ~3 visible at any time on the front arc

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function findStripPosition(strip: number[], top: number, mid: number, bot: number): number {
  const L = strip.length;
  for (let k = 0; k < L; k++) {
    if (strip[(k - 1 + L) % L] === top && strip[k] === mid && strip[(k + 1) % L] === bot) {
      return k;
    }
  }
  for (let k = 0; k < L; k++) if (strip[k] === mid) return k;
  return 0;
}

/** Build an 8-cell window around position p — [(p-3), (p-2), (p-1), p, (p+1), (p+2), (p+3), (p+4)] mod L. */
function buildDrumWindow(strip: number[], p: number): number[] {
  const L = strip.length;
  const window: number[] = [];
  const half = Math.floor(CELLS_PER_DRUM / 2);
  for (let i = 0; i < CELLS_PER_DRUM; i++) {
    const off = i - half + 1;
    window.push(strip[((p + off) % L + L) % L]);
  }
  return window;
}

// ---------------------------------------------------------------------------
// Symbol image cache (module-level, shared across drums)
// ---------------------------------------------------------------------------
const imageCache = new Map<number, THREE.Texture>();
function loadSymbolTexture(id: number, path: string): Promise<THREE.Texture> {
  const cached = imageCache.get(id);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = 'anonymous';
    loader.load(
      path,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        imageCache.set(id, tex);
        resolve(tex);
      },
      undefined,
      reject,
    );
  });
}

// ---------------------------------------------------------------------------
// Per-reel animation state — mutated in useFrame
// ---------------------------------------------------------------------------
interface DrumAnim {
  phase:         'idle' | 'accel' | 'steady' | 'decel' | 'bounce' | 'done';
  spinStartMs:   number;
  rotation:      number;
  velocity:      number;
  targetRot:     number;
  targetSet:     boolean;
  decelStartMs:  number;
  decelStartRot: number;
  bounceStartMs: number;
  settled:       boolean;
  /** Which 8 cells are currently loaded onto this drum's planes. */
  window:        number[];
}

function makeIdleAnim(): DrumAnim {
  return {
    phase: 'idle', spinStartMs: 0, rotation: 0, velocity: 0,
    targetRot: 0, targetSet: false, decelStartMs: 0, decelStartRot: 0,
    bounceStartMs: 0, settled: true, window: new Array(CELLS_PER_DRUM).fill(0),
  };
}

const easeInQuad = (t: number) => t * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1, u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
};

// ---------------------------------------------------------------------------
// DrumRig — main component
// ---------------------------------------------------------------------------
export default function DrumRig({
  reels, isSpinning: _isSpinning, spinTrigger, onReelsSettled, showFx,
}: SlotRigProps) {
  void _isSpinning;
  const { gl, scene, camera } = useThree();

  // ── Leva live controls (drum-specific) ─────────────────────────────────
  const drum = useControls({
    Drum: folder({
      DRUM_RADIUS:   { value: 1.4, min: 0.8, max: 2.5, step: 0.05 },
      DRUM_DEPTH:    { value: 1.0, min: 0.4, max: 2.0, step: 0.05 },
      REEL_SPACING:  { value: 1.85, min: 1.2, max: 2.8, step: 0.05 },
      MAX_RPS:       { value: 1.5, min: 0.5, max: 4, step: 0.1, label: 'Max rev/sec' },
      ACCEL_MS:      { value: 280, min: 100, max: 600, step: 20 },
      STEADY_MIN_MS: { value: 600, min: 300, max: 1500, step: 50 },
      DECEL_MS:      { value: 720, min: 300, max: 1500, step: 50 },
      DECEL_STAGGER_MS: { value: 160, min: 0, max: 400, step: 20 },
      BOUNCE_MS:     { value: 220, min: 80, max: 500, step: 20 },
      BOUNCE_OVERSHOOT_RAD: { value: 0.12, min: 0, max: 0.5, step: 0.01 },
    }),
  });

  const STEP = (2 * Math.PI) / CELLS_PER_DRUM;

  // ── Symbol textures — preload all 11 ──────────────────────────────────
  const [texturesReady, setTexturesReady] = useState(false);
  const symbolTextures = useRef<Record<number, THREE.Texture>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      SYMBOL_ASSETS.map((a) => loadSymbolTexture(a.id, a.imagePath).then((tex) => {
        symbolTextures.current[a.id] = tex;
      }).catch(() => {})),
    ).then(() => { if (!cancelled) setTexturesReady(true); });
    return () => { cancelled = true; };
  }, []);

  // ── Shared geometry + materials ───────────────────────────────────────
  const planeGeom = useMemo(() => new THREE.PlaneGeometry(drum.DRUM_DEPTH, drum.DRUM_RADIUS * 0.95), [drum.DRUM_DEPTH, drum.DRUM_RADIUS]);
  const bezelGeom = useMemo(() => new THREE.TorusGeometry(drum.DRUM_RADIUS, 0.04, 8, 32), [drum.DRUM_RADIUS]);
  const bezelMat  = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.85 }), []);
  const cellBackMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0x0a0e1c, transparent: true, opacity: 0.92, depthWrite: false }), []);

  // ── Per-reel materials (one per drum face × 5 reels) ──────────────────
  // Created in a useMemo so they exist before first render — otherwise the
  // mesh prop binding tries to render before useEffect populates the ref
  // and crashes on undefined material.
  const reelMaterials = useMemo<THREE.MeshBasicMaterial[][]>(() =>
    Array.from({ length: REEL_COUNT }, () =>
      Array.from({ length: CELLS_PER_DRUM }, () => new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite:  false,
        side:        THREE.FrontSide,
      })),
    ),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  , []);
  useEffect(() => () => {
    for (const reel of reelMaterials) for (const m of reel) m.dispose();
  }, [reelMaterials]);

  // Initial texture binding — once textures are ready, point each plane at
  // the first 8 strip positions of its reel so the drum isn't blank at idle.
  useEffect(() => {
    if (!texturesReady) return;
    for (let r = 0; r < REEL_COUNT; r++) {
      const strip = CLASSIC_REEL_STRIPS[r];
      const win = strip.slice(0, CELLS_PER_DRUM);
      animState.current[r].window = win;
      for (let f = 0; f < CELLS_PER_DRUM; f++) {
        const tex = symbolTextures.current[win[f]];
        reelMaterials[r][f].map = tex ?? null;
        reelMaterials[r][f].needsUpdate = true;
      }
    }
  }, [texturesReady, reelMaterials]);

  // ── Refs ─────────────────────────────────────────────────────────────
  const drumGroupRefs = useRef<(THREE.Group | null)[]>(Array(REEL_COUNT).fill(null));
  const animState     = useRef<DrumAnim[]>(Array.from({ length: REEL_COUNT }, makeIdleAnim));
  const prevTrigger   = useRef(spinTrigger);
  const settledCount  = useRef(0);
  const onSettledRef  = useRef(onReelsSettled);
  useEffect(() => { onSettledRef.current = onReelsSettled; }, [onReelsSettled]);

  // Compile shaders once on mount
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const g = gl as unknown as { compileAsync?: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown> };
      g.compileAsync?.(scene, camera).catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [gl, scene, camera]);

  // ── Trigger spin ─────────────────────────────────────────────────────
  useEffect(() => {
    if (spinTrigger === prevTrigger.current) return;
    prevTrigger.current = spinTrigger;
    const now = performance.now();
    settledCount.current = 0;
    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      a.phase = 'accel';
      a.spinStartMs = now;
      a.velocity = 0;
      a.targetSet = false;
      a.settled = false;
    }
  }, [spinTrigger]);

  // ── On `reels` arrival: pre-load each drum's 8-cell window + compute
  //    landing rotation so the front-arc 3 planes show [top, mid, bot]. ──
  useEffect(() => {
    if (!reels || !texturesReady) return;
    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      if (a.settled || a.targetSet) continue;
      const window3 = reels[r];
      if (!window3 || window3.length < 3) continue;

      const strip = CLASSIC_REEL_STRIPS[r];
      const p = findStripPosition(strip, window3[0], window3[1], window3[2]);

      // Build the 8-cell window around this position. We re-texture each
      // plane to match this window.
      const win = buildDrumWindow(strip, p);
      a.window = win;

      // Apply textures to each plane's material.
      for (let f = 0; f < CELLS_PER_DRUM; f++) {
        const symId = win[f];
        const tex = symbolTextures.current[symId];
        if (reelMaterials[r] && reelMaterials[r][f]) {
          reelMaterials[r][f].map = tex ?? null;
          reelMaterials[r][f].needsUpdate = true;
        }
      }

      // Landing rotation: face 0 sits at top of the visible window (top row),
      // face 1 = middle, face 2 = bottom. We want the drum.rotation.x such
      // that the half-index face points forward toward camera (+Z).
      //
      // Each face f sits at world angle = (f * STEP) + drum.rotation.x.
      // We want face (half-1) → top, face half → mid, face half+1 → bot.
      // Set rotation so face `half` is at angle = 0 (pointing +Z).
      const half = Math.floor(CELLS_PER_DRUM / 2);
      const targetAngle = -half * STEP;     // canonical "front mid" position

      // Add enough full revolutions forward for visual spin.
      const cur = a.rotation;
      const baseDelta = cur - targetAngle;
      const k = Math.max(1, Math.ceil(0.75 - baseDelta / (2 * Math.PI)));
      a.targetRot = targetAngle - k * 2 * Math.PI;  // forward = subtract
      a.targetSet = true;
    }
  }, [reels, texturesReady]);

  const handleReelSettled = useCallback(() => {
    settledCount.current += 1;
    if (settledCount.current >= REEL_COUNT) {
      setTimeout(() => onSettledRef.current(), 0);
    }
  }, []);

  // ── useFrame — spin physics ─────────────────────────────────────────
  useFrame((_state, delta) => {
    const now = performance.now();
    const MAX_RAD_PER_SEC = drum.MAX_RPS * 2 * Math.PI;

    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      const group = drumGroupRefs.current[r];
      if (!group || a.settled) continue;

      const elapsed = now - a.spinStartMs;

      switch (a.phase) {
        case 'accel': {
          const t = Math.min(elapsed / drum.ACCEL_MS, 1);
          a.velocity = MAX_RAD_PER_SEC * easeInQuad(t);
          a.rotation -= a.velocity * delta;
          if (t >= 1) a.phase = 'steady';
          break;
        }
        case 'steady': {
          a.rotation -= MAX_RAD_PER_SEC * delta;
          const myDecelStart = drum.ACCEL_MS + drum.STEADY_MIN_MS + r * drum.DECEL_STAGGER_MS;
          if (elapsed >= myDecelStart && a.targetSet) {
            a.phase = 'decel';
            a.decelStartMs = now;
            a.decelStartRot = a.rotation;
          }
          break;
        }
        case 'decel': {
          const t = Math.min((now - a.decelStartMs) / drum.DECEL_MS, 1);
          a.rotation = a.decelStartRot + (a.targetRot - a.decelStartRot) * easeOutCubic(t);
          if (t >= 1) {
            a.rotation = a.targetRot;
            a.phase = 'bounce';
            a.bounceStartMs = now;
          }
          break;
        }
        case 'bounce': {
          const t = Math.min((now - a.bounceStartMs) / drum.BOUNCE_MS, 1);
          const overshoot = drum.BOUNCE_OVERSHOOT_RAD * (1 - easeOutBack(t));
          a.rotation = a.targetRot - overshoot;
          if (t >= 1) {
            a.rotation = a.targetRot;
            a.phase = 'done';
            a.settled = true;
            handleReelSettled();
          }
          break;
        }
      }

      group.rotation.x = a.rotation;
    }
  });

  if (!texturesReady) return <DrumLoadingIndicator />;

  // ── Scene graph ─────────────────────────────────────────────────────
  return (
    <group>
      {Array.from({ length: REEL_COUNT }).map((_, r) => (
        <group
          key={`drum-${r}`}
          position={[(r - (REEL_COUNT - 1) / 2) * drum.REEL_SPACING, 0, 0]}
        >
          {/* Drum group — rotates around X */}
          <group ref={(el) => { drumGroupRefs.current[r] = el; }}>
            {Array.from({ length: CELLS_PER_DRUM }).map((_, f) => {
              const angle = f * STEP;
              const y = Math.cos(angle) * drum.DRUM_RADIUS;
              const z = Math.sin(angle) * drum.DRUM_RADIUS;
              return (
                <group key={f} position={[0, y, z]} rotation={[angle - Math.PI / 2, 0, 0]}>
                  {/* Dark card backdrop behind each symbol */}
                  <mesh geometry={planeGeom} material={cellBackMat} position={[0, 0, -0.01]} />
                  {/* Symbol image */}
                  {reelMaterials.current[r] && (
                    <mesh geometry={planeGeom} material={reelMaterials[r][f]} />
                  )}
                </group>
              );
            })}
          </group>

          {/* Bezel rings at left/right faces of the drum (axis is along X) */}
          {showFx && (
            <>
              <mesh
                geometry={bezelGeom}
                material={bezelMat}
                position={[-drum.DRUM_DEPTH * 0.5 - 0.04, 0, 0]}
                rotation={[0, Math.PI / 2, 0]}
              />
              <mesh
                geometry={bezelGeom}
                material={bezelMat}
                position={[drum.DRUM_DEPTH * 0.5 + 0.04, 0, 0]}
                rotation={[0, Math.PI / 2, 0]}
              />
            </>
          )}
        </group>
      ))}

      {/* Centre payline glow strip */}
      {showFx && (
        <mesh position={[0, 0, drum.DRUM_RADIUS + 0.05]}>
          <planeGeometry args={[drum.REEL_SPACING * REEL_COUNT, 0.06]} />
          <meshBasicMaterial color={0x00d4ff} transparent opacity={0.5} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

function DrumLoadingIndicator() {
  return (
    <mesh>
      <planeGeometry args={[0.5, 0.5]} />
      <meshBasicMaterial color={0xfdf6e3} transparent opacity={0.3} />
    </mesh>
  );
}
