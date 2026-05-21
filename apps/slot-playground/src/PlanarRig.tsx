/**
 * PlanarRig — production-mirror with Phase 6.1.14 polish.
 *
 * Mirrors apps/web/src/components/cove/SlotReels3D.tsx so we can iterate
 * the cell artwork + reel animation locally without pushing to prod.
 *
 * When a configuration reads well here, the polished drawCell lifts back
 * into apps/web verbatim.
 */

import { useRef, useEffect, useMemo, useCallback, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useControls, folder } from 'leva';
import type { SlotRigProps } from './types';
import { CLASSIC_REEL_STRIPS, SYMBOL_ASSETS, STRIP_LEN } from './constants';

// ---------------------------------------------------------------------------
// Geometry — bumped cell size + tighter gap to fill the canvas
// ---------------------------------------------------------------------------
const REEL_COUNT   = 5;
const VISIBLE_ROWS = 3;
const CELL_WU      = 1.7;
const REEL_WIDTH   = CELL_WU;
const REEL_HEIGHT  = CELL_WU * VISIBLE_ROWS;
const REEL_GAP     = 0.10;
const REEL_PITCH   = REEL_WIDTH + REEL_GAP;

// ---------------------------------------------------------------------------
// Texture — one column × STRIP_LEN rows, TILE_PX per cell
// ---------------------------------------------------------------------------
const TILE_PX = 192;
const TEX_W = TILE_PX;
const TEX_H = TILE_PX * STRIP_LEN;

// ---------------------------------------------------------------------------
// Animation state — per-reel (mutated in useFrame, NEVER React state)
// ---------------------------------------------------------------------------
interface ReelAnim {
  phase:           'idle' | 'accel' | 'steady' | 'decel' | 'bounce' | 'done';
  spinStartMs:     number;
  offset:          number;       // current texture.offset.y
  velocity:        number;       // offset/sec
  targetOffset:    number;
  targetSet:       boolean;
  decelStartMs:    number;
  decelStartOffset: number;
  bounceStartMs:   number;
  bounceBaseOffset: number;
  settled:         boolean;
}

function makeIdleAnim(): ReelAnim {
  return {
    phase: 'idle', spinStartMs: 0, offset: 0, velocity: 0,
    targetOffset: 0, targetSet: false, decelStartMs: 0,
    decelStartOffset: 0, bounceStartMs: 0, bounceBaseOffset: 0,
    settled: true,
  };
}

const easeInQuad = (t: number) => t * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1, u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
};

function findStripPosition(strip: number[], top: number, mid: number, bot: number): number {
  const L = strip.length;
  for (let k = 0; k < L; k++) {
    if (strip[(k - 1 + L) % L] === top && strip[k] === mid && strip[(k + 1) % L] === bot) return k;
  }
  for (let k = 0; k < L; k++) if (strip[k] === mid) return k;
  return 0;
}

function offsetForStripPosition(p: number): number {
  // Correct: cell `p` sits at the MIDDLE row of a VISIBLE_ROWS-tall window.
  //   Cell p UV center = (STRIP_LEN - p - 0.5) / STRIP_LEN
  //   Window center    = offset + repeat/2 = offset + VISIBLE_ROWS/(2·STRIP_LEN)
  //   Solving:           offset = 1 - (p + 0.5 + VISIBLE_ROWS/2) / STRIP_LEN
  // Previously missed the 0.5 → window straddled cell boundaries (showed
  // half-cell + full + full + half-cell instead of 3 full cells).
  return 1 - (p + 0.5 + VISIBLE_ROWS / 2) / STRIP_LEN;
}

// ---------------------------------------------------------------------------
// Image cache + loader
// ---------------------------------------------------------------------------
const imageCache = new Map<number, HTMLImageElement>();
function loadSymbolImage(id: number, path: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(id);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { imageCache.set(id, img); resolve(img); };
    img.onerror = () => reject(new Error(`load fail ${path}`));
    img.src = path;
  });
}

// ---------------------------------------------------------------------------
// Round-rect path
// ---------------------------------------------------------------------------
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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
// drawCell — Phase 6.1.15 CLEAN treatment.
//
// Reference: classic arcade fruit-slot (CodeCanyon-style). Symbol-first.
// No per-cell card frame. No corner ornaments. No double borders. Just a
// near-white background, a big readable symbol, and a faint divider so
// row boundaries still register at a glance.
// ---------------------------------------------------------------------------
function drawCell(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, size: number,
  _symbolId: number, _themeColor: string,
  img?: HTMLImageElement,
) {
  void _symbolId;
  void _themeColor;

  // 1. Cream background with subtle vertical stripe (printed-paper feel)
  const bg = ctx.createLinearGradient(x, y, x, y + size);
  bg.addColorStop(0, '#fef9ec');
  bg.addColorStop(0.5, '#fdf3d5');
  bg.addColorStop(1, '#f4e3b3');
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, size, size);

  // Faint vertical stripe texture — adds printed-paper feel without busy noise
  ctx.fillStyle = 'rgba(180, 120, 40, 0.04)';
  const stripeStep = size * 0.08;
  for (let sx = 0; sx < size; sx += stripeStep) {
    ctx.fillRect(x + sx, y, 1, size);
  }

  // 2. Row dividers — top + bottom edges, faint
  ctx.fillStyle = 'rgba(60, 30, 0, 0.12)';
  ctx.fillRect(x, y, size, 1);
  ctx.fillRect(x, y + size - 1, size, 1);

  // 3. Symbol artwork — BIG (84% of cell), centered, with soft drop shadow
  if (img && img.complete && img.naturalWidth > 0) {
    const symSize = size * 0.84;
    const sx = x + (size - symSize) / 2;
    const sy = y + (size - symSize) / 2;
    try {
      // Soft drop shadow — gives chibi PNGs depth on the printed paper
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.drawImage(img, sx + size * 0.014, sy + size * 0.022, symSize, symSize);
      ctx.restore();
      ctx.drawImage(img, sx, sy, symSize, symSize);
    } catch {
      /* fall through to text fallback */
    }
  } else {
    // Unicode fallback for missing assets
    const fallback: Record<number, string> = {
      0: '🦞', 1: '🤖', 2: 'ELIZA', 3: '🐿️', 4: 'MILADY',
      5: 'BAR', 6: '7', 7: 'CLAW', 8: 'BAR×2', 9: 'BAR×3', 10: '🪙',
    };
    const text = fallback[_symbolId] ?? '?';
    const isWord = text.length > 1 && !/^[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u.test(text);
    ctx.font = `900 ${Math.round(size * (isWord ? 0.22 : 0.5))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1f2937';
    ctx.fillText(text, x + size / 2, y + size / 2);
  }
}

// ---------------------------------------------------------------------------
// Build per-reel CanvasTexture — STRIP_LEN cells stacked vertically
// ---------------------------------------------------------------------------
function buildReelTexture(strip: number[]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#050817';
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  for (let k = 0; k < strip.length; k++) {
    const id = strip[k];
    const asset = SYMBOL_ASSETS.find(a => a.id === id) ?? SYMBOL_ASSETS[0];
    drawCell(ctx, 0, k * TILE_PX, TILE_PX, id, asset.themeColor, imageCache.get(id));
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// PlanarRig — main
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 3D pull-lever — clicks trigger onSpinClick, ball travels down + bounces back
// ---------------------------------------------------------------------------
function PullLever({
  cabinetHalfH, onPull,
}: {
  cabinetHalfH: number;
  onPull?: () => void;
}) {
  const SHAFT_X = 0;           // local-X inside the lever group (parent positions it)
  const SHAFT_W = 0.18;
  const SHAFT_TOP = cabinetHalfH * 0.85;
  const SHAFT_BOTTOM = -cabinetHalfH * 0.85;
  const SHAFT_LEN = SHAFT_TOP - SHAFT_BOTTOM;
  const BALL_R = 0.22;
  const BALL_TRAVEL = SHAFT_LEN * 0.55;

  const ballRef = useRef<THREE.Mesh>(null);
  const shaftRef = useRef<THREE.Mesh>(null);
  const animRef = useRef<{ active: boolean; startMs: number }>({ active: false, startMs: 0 });

  const handleClick = useCallback(() => {
    if (animRef.current.active) return;
    animRef.current.active = true;
    animRef.current.startMs = performance.now();
    onPull?.();
  }, [onPull]);

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
    if (ballRef.current) ballRef.current.position.y = SHAFT_TOP + offset;
    // Shaft scales down from top — its center shifts as length shortens
    if (shaftRef.current) {
      const newLen = SHAFT_LEN + offset; // offset is negative when pulled
      const newCenterY = SHAFT_BOTTOM + newLen / 2;
      shaftRef.current.position.y = newCenterY;
      shaftRef.current.scale.y = Math.max(0.01, newLen / SHAFT_LEN);
    }
  });

  return (
    <group>
      {/* Shaft base socket — sits at bottom, gives the lever an anchor */}
      <mesh position={[SHAFT_X, SHAFT_BOTTOM - 0.05, 0]}>
        <circleGeometry args={[SHAFT_W * 1.4, 16]} />
        <meshBasicMaterial color={0x4a2818} />
      </mesh>
      {/* Shaft — animated length */}
      <mesh ref={shaftRef} position={[SHAFT_X, (SHAFT_TOP + SHAFT_BOTTOM) / 2, 0]}>
        <planeGeometry args={[SHAFT_W, SHAFT_LEN]} />
        <meshBasicMaterial color={0xd9a55a} />
      </mesh>
      {/* Shaft highlight stripe — fakes cylinder shading */}
      <mesh position={[SHAFT_X - SHAFT_W * 0.2, (SHAFT_TOP + SHAFT_BOTTOM) / 2, 0.001]}>
        <planeGeometry args={[SHAFT_W * 0.25, SHAFT_LEN]} />
        <meshBasicMaterial color={0xfff1a3} transparent opacity={0.55} />
      </mesh>
      {/* Ball tip — clickable, animated Y */}
      <mesh
        ref={ballRef}
        position={[SHAFT_X, SHAFT_TOP, 0.01]}
        onPointerDown={(e) => { e.stopPropagation(); handleClick(); }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = 'default'; }}
      >
        <circleGeometry args={[BALL_R, 24]} />
        <meshBasicMaterial color={0xe53935} />
      </mesh>
      {/* Ball shadow disc — sits behind */}
      <mesh
        position={[SHAFT_X + 0.04, SHAFT_TOP - 0.05, 0.005]}
      >
        <circleGeometry args={[BALL_R * 1.08, 24]} />
        <meshBasicMaterial color={0x2a0808} transparent opacity={0.55} />
      </mesh>
      {/* Ball highlight — fakes spherical specular */}
      <mesh position={[SHAFT_X - BALL_R * 0.3, SHAFT_TOP + BALL_R * 0.25, 0.02]}>
        <circleGeometry args={[BALL_R * 0.32, 16]} />
        <meshBasicMaterial color={0xffffff} transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Animated marching-marquee frame around a winning cell
//   - scale-pop entry (0 → 1.15 → 1.0, easeOutBack)
//   - glow halo: scale + alpha throb
//   - 4 sides: chasing wave of opacity (TOP → RIGHT → BOTTOM → LEFT)
//   - 4 corner dots: synced strobe
// ---------------------------------------------------------------------------
function WinHighlight({ x, y, size, delay = 0 }: { x: number; y: number; size: number; delay?: number }) {
  const rootRef    = useRef<THREE.Group>(null);
  const haloRef    = useRef<THREE.Mesh>(null);
  const sideRefs   = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const dotRefs    = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const startMs    = useRef(performance.now() + delay);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const elapsed = performance.now() - startMs.current;
    if (elapsed < 0) {
      if (rootRef.current) rootRef.current.scale.setScalar(0);
      return;
    }

    // Entry scale-pop — 320ms easeOutBack 0 → 1.0 (overshoots to ~1.15)
    const ENTRY_MS = 320;
    let entry = 1;
    if (elapsed < ENTRY_MS) {
      entry = easeOutBack(elapsed / ENTRY_MS);
    }
    if (rootRef.current) rootRef.current.scale.setScalar(entry);

    // Glow halo — throb scale 1.0↔1.12 + alpha 0.35↔0.75
    const haloPulse = 0.5 + 0.5 * Math.sin(t * 5);
    if (haloRef.current) {
      const s = 1.0 + 0.12 * haloPulse;
      haloRef.current.scale.set(s, s, 1);
      (haloRef.current.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.4 * haloPulse;
    }

    // 4 sides — chasing wave (each side phase-offset by quarter turn)
    for (let i = 0; i < 4; i++) {
      const m = sideRefs[i].current;
      if (!m) continue;
      const phase = (t * 4) - i * (Math.PI / 2);
      const wave = 0.55 + 0.45 * Math.sin(phase);
      (m.material as THREE.MeshBasicMaterial).opacity = wave;
    }

    // Corner dots — strobe 0.6↔1.0 in sync
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
      {/* Glow halo — pulses scale + alpha */}
      <mesh ref={haloRef}>
        <planeGeometry args={[size * 1.20, size * 1.20]} />
        <meshBasicMaterial color={0xffd54f} transparent opacity={0.5} depthWrite={false} />
      </mesh>
      {/* 4 frame sides — TOP, RIGHT, BOTTOM, LEFT (each phase-offset chase) */}
      <mesh ref={sideRefs[0]} position={[0, halfS - T / 2, 0.001]}>
        <planeGeometry args={[size, T]} />
        <meshBasicMaterial color={0xffd54f} transparent opacity={1} />
      </mesh>
      <mesh ref={sideRefs[1]} position={[halfS - T / 2, 0, 0.001]}>
        <planeGeometry args={[T, size]} />
        <meshBasicMaterial color={0xffd54f} transparent opacity={1} />
      </mesh>
      <mesh ref={sideRefs[2]} position={[0, -halfS + T / 2, 0.001]}>
        <planeGeometry args={[size, T]} />
        <meshBasicMaterial color={0xffd54f} transparent opacity={1} />
      </mesh>
      <mesh ref={sideRefs[3]} position={[-halfS + T / 2, 0, 0.001]}>
        <planeGeometry args={[T, size]} />
        <meshBasicMaterial color={0xffd54f} transparent opacity={1} />
      </mesh>
      {/* 4 corner dots — strobe */}
      {([[-halfS, halfS], [halfS, halfS], [-halfS, -halfS], [halfS, -halfS]] as Array<[number, number]>).map(([cx, cy], i) => (
        <mesh key={i} ref={dotRefs[i]} position={[cx, cy, 0.002]}>
          <circleGeometry args={[T * 1.4, 14]} />
          <meshBasicMaterial color={0xffffff} transparent opacity={1} />
        </mesh>
      ))}
    </group>
  );
}

export default function PlanarRig({ reels, isSpinning, spinTrigger, onReelsSettled, onSpinClick }: SlotRigProps) {
  const { gl, scene, camera } = useThree();

  const planar = useControls({
    Planar: folder({
      MAX_SCROLL_PER_SEC: { value: 5.5, min: 1, max: 12, step: 0.1 },
      ACCEL_MS:           { value: 280, min: 100, max: 600, step: 20 },
      STEADY_MIN_MS:      { value: 620, min: 300, max: 1500, step: 50 },
      DECEL_MS:           { value: 720, min: 300, max: 1500, step: 50 },
      DECEL_STAGGER_MS:   { value: 160, min: 0, max: 400, step: 20 },
      BOUNCE_MS:          { value: 220, min: 80, max: 500, step: 20 },
      BOUNCE_OVERSHOOT:   { value: 0.32, min: 0, max: 1, step: 0.02, label: 'bounce cells' },
      BLUR_EXTRA:         { value: 8, min: 0, max: 14, step: 1, label: 'motion blur' },
    }),
  });
  const VISIBLE_REPEAT = VISIBLE_ROWS / STRIP_LEN;
  const BLUR_REPEAT = (VISIBLE_ROWS + planar.BLUR_EXTRA) / STRIP_LEN;
  const BOUNCE_OVERSHOOT_FRAC = planar.BOUNCE_OVERSHOOT / STRIP_LEN;

  // Preload symbol images
  const [imagesReady, setImagesReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all(SYMBOL_ASSETS.map(a => loadSymbolImage(a.id, a.imagePath).catch(() => null)))
      .then(() => { if (!cancelled) setImagesReady(true); });
    return () => { cancelled = true; };
  }, []);

  // Textures (rebuilt after images load)
  const textures = useMemo<THREE.CanvasTexture[]>(
    () => CLASSIC_REEL_STRIPS.map(s => buildReelTexture(s)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imagesReady],
  );

  // Geometry + materials
  const reelGeom = useMemo(() => new THREE.PlaneGeometry(REEL_WIDTH, REEL_HEIGHT), []);
  const reelMats = useMemo(
    () => textures.map(t => {
      const m = new THREE.MeshBasicMaterial({ map: t, transparent: false });
      if (m.map) {
        m.map.repeat.set(1, VISIBLE_REPEAT);
        m.map.offset.set(0, 1 - VISIBLE_REPEAT);
      }
      return m;
    }),
    [textures, VISIBLE_REPEAT],
  );

  const animState = useRef<ReelAnim[]>(Array.from({ length: REEL_COUNT }, makeIdleAnim));
  const prevTrigger = useRef(spinTrigger);
  const settledCount = useRef(0);
  const onSettledRef = useRef(onReelsSettled);
  useEffect(() => { onSettledRef.current = onReelsSettled; }, [onReelsSettled]);

  // Compile shaders once
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const g = gl as unknown as { compileAsync?: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown> };
      g.compileAsync?.(scene, camera).catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
  }, [gl, scene, camera]);

  // Trigger spin
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
      const map = reelMats[r]?.map;
      if (map) {
        map.repeat.set(1, BLUR_REPEAT);
        map.needsUpdate = true;
      }
    }
  }, [spinTrigger, reelMats, BLUR_REPEAT]);

  // Compute landing target on reels arrival
  useEffect(() => {
    if (!reels) return;
    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      if (a.settled || a.targetSet) continue;
      const window3 = reels[r];
      if (!window3 || window3.length < 3) continue;
      const strip = CLASSIC_REEL_STRIPS[r];
      const p = findStripPosition(strip, window3[0], window3[1], window3[2]);
      const landingOffset = offsetForStripPosition(p);
      const cur = a.offset;
      const minDist = 0.5;
      const baseDelta = cur - landingOffset;
      const k = Math.max(1, Math.ceil(minDist - baseDelta));
      a.targetOffset = landingOffset - k;
      a.targetSet = true;
    }
  }, [reels]);

  // Force-stop on isSpinning false-edge (abort-safety)
  useEffect(() => {
    if (isSpinning) return;
    let any = false;
    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      if (a.settled) continue;
      const map = reelMats[r]?.map;
      if (map) { map.repeat.set(1, VISIBLE_REPEAT); map.needsUpdate = true; }
      a.phase = 'done'; a.settled = true;
      any = true;
    }
    if (any) settledCount.current = REEL_COUNT;
  }, [isSpinning, reelMats, VISIBLE_REPEAT]);

  const handleReelSettled = useCallback(() => {
    settledCount.current += 1;
    if (settledCount.current >= REEL_COUNT) {
      setTimeout(() => onSettledRef.current(), 0);
    }
  }, []);

  useFrame((_, delta) => {
    const now = performance.now();
    for (let r = 0; r < REEL_COUNT; r++) {
      const a = animState.current[r];
      const map = reelMats[r]?.map;
      if (!map || a.settled) continue;
      const elapsed = now - a.spinStartMs;

      switch (a.phase) {
        case 'accel': {
          const t = Math.min(elapsed / planar.ACCEL_MS, 1);
          a.velocity = planar.MAX_SCROLL_PER_SEC * easeInQuad(t);
          a.offset -= a.velocity * delta;
          if (t >= 1) a.phase = 'steady';
          break;
        }
        case 'steady': {
          a.offset -= planar.MAX_SCROLL_PER_SEC * delta;
          const myDecel = planar.ACCEL_MS + planar.STEADY_MIN_MS + r * planar.DECEL_STAGGER_MS;
          if (elapsed >= myDecel && a.targetSet) {
            a.phase = 'decel';
            a.decelStartMs = now;
            a.decelStartOffset = a.offset;
            map.repeat.set(1, VISIBLE_REPEAT);
            map.needsUpdate = true;
          }
          break;
        }
        case 'decel': {
          const t = Math.min((now - a.decelStartMs) / planar.DECEL_MS, 1);
          a.offset = a.decelStartOffset + (a.targetOffset - a.decelStartOffset) * easeOutCubic(t);
          if (t >= 1) {
            a.offset = a.targetOffset;
            a.phase = 'bounce';
            a.bounceStartMs = now;
            a.bounceBaseOffset = a.targetOffset;
          }
          break;
        }
        case 'bounce': {
          const t = Math.min((now - a.bounceStartMs) / planar.BOUNCE_MS, 1);
          const overshoot = BOUNCE_OVERSHOOT_FRAC * (1 - easeOutBack(t));
          a.offset = a.bounceBaseOffset - overshoot;
          if (t >= 1) {
            a.offset = a.bounceBaseOffset;
            a.phase = 'done';
            a.settled = true;
            handleReelSettled();
          }
          break;
        }
      }
      map.offset.y = a.offset;
    }
  });

  useEffect(() => () => {
    reelGeom.dispose();
    for (const m of reelMats) { m.map?.dispose(); m.dispose(); }
  }, [reelGeom, reelMats]);

  // Cabinet geometry constants (computed pre-hooks to keep useMemo above any
  // early-return — moving rivet useMemo below the `!imagesReady` guard
  // breaks Rules-of-Hooks across the imagesReady transition).
  const clusterW = REEL_PITCH * REEL_COUNT;
  const frameW   = clusterW + 0.55;
  const frameH   = REEL_HEIGHT + 0.55;

  const rivets: Array<[number, number]> = useMemo(() => {
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

  // Win-line detection — three horizontal paylines (top / middle / bottom).
  // RTP-locked; do NOT add vertical / diagonal patterns without re-running
  // the Monte Carlo gate. Production paytable is tuned to 94% on horizontals
  // only (packages/shared/.../slot-paytables.ts).
  //
  // Wild = id 7 (Clawbster) substitutes for any non-scatter.
  // Scatter = id 10 (Eliza Coin) does NOT count as a line win.
  const winCells: Array<{ reel: number; row: number }> = useMemo(() => {
    if (!reels || reels.length < REEL_COUNT) return [];
    const WILD = 7;
    const SCATTER = 10;
    const out: Array<{ reel: number; row: number }> = [];

    for (let row = 0; row < 3; row++) {
      let lineSymbol = -1;
      let scattered = false;
      for (let r = 0; r < REEL_COUNT; r++) {
        const v = reels[r]?.[row];
        if (v === undefined) { scattered = true; break; }
        if (v === SCATTER) { scattered = true; break; }
        if (v !== WILD) { lineSymbol = v; break; }
      }
      if (scattered) continue;
      if (lineSymbol === -1) lineSymbol = WILD;

      const matched: number[] = [];
      for (let r = 0; r < REEL_COUNT; r++) {
        const v = reels[r][row];
        if (v === lineSymbol || v === WILD) matched.push(r);
        else break;
      }
      if (matched.length >= 3) {
        for (const r of matched) out.push({ reel: r, row });
      }
    }
    return out;
  }, [reels]);

  if (!imagesReady) {
    return (
      <mesh>
        <planeGeometry args={[0.6, 0.6]} />
        <meshBasicMaterial color={0xfdf6e3} transparent opacity={0.3} />
      </mesh>
    );
  }

  return (
    <group>
      {/* Cabinet outer frame — bright brass */}
      <mesh position={[0, 0, -0.04]}>
        <planeGeometry args={[frameW + 0.18, frameH + 0.18]} />
        <meshBasicMaterial color={0xf4b840} />
      </mesh>
      {/* Cabinet outer bezel — darker brass for depth */}
      <mesh position={[0, 0, -0.03]}>
        <planeGeometry args={[frameW, frameH]} />
        <meshBasicMaterial color={0xb8801f} />
      </mesh>
      {/* Cabinet inner shadow rim — thin dark line just outside reels */}
      <mesh position={[0, 0, -0.02]}>
        <planeGeometry args={[clusterW + 0.08, REEL_HEIGHT + 0.08]} />
        <meshBasicMaterial color={0x2a1810} />
      </mesh>

      {/* Brass rivets around the cabinet perimeter */}
      {rivets.map(([rx, ry], i) => (
        <mesh key={`rivet-${i}`} position={[rx, ry, -0.025]}>
          <circleGeometry args={[0.06, 12]} />
          <meshBasicMaterial color={0xfff1a3} />
        </mesh>
      ))}

      {/* Reel column dividers — thin dark verticals between reels */}
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
          geometry={reelGeom}
          material={reelMats[r]}
          position={[(r - (REEL_COUNT - 1) / 2) * REEL_PITCH, 0, 0]}
        />
      ))}

      {/* Note: removed top/bottom vignettes + idle payline strip — they read
          as dirty overlays on a flat light cabinet. Win highlights handle
          the payline visualization. */}

      {/* Win cell highlights — marching marquee frames around each winning cell */}
      {!isSpinning && winCells.map(({ reel, row }) => {
        const cx = (reel - (REEL_COUNT - 1) / 2) * REEL_PITCH;
        const cy = (1 - row) * CELL_WU;
        return <WinHighlight key={`win-${reel}-${row}`} x={cx} y={cy} size={CELL_WU * 0.86} />;
      })}

      {/* Winning paylines — one per row that has a 3+ left-to-right hit.
          Color-coded by row so overlapping wins read clearly:
            row 0 (top)    → red    #ff3535
            row 1 (middle) → cyan   #00d4ff
            row 2 (bottom) → green  #22c55e */}
      {!isSpinning && [0, 1, 2].map(row => {
        const rowCells = winCells.filter(c => c.row === row);
        if (rowCells.length < 3) return null;
        const firstReel = rowCells[0].reel;
        const lastReel  = rowCells[rowCells.length - 1].reel;
        const xFirst    = (firstReel - (REEL_COUNT - 1) / 2) * REEL_PITCH;
        const xLast     = (lastReel  - (REEL_COUNT - 1) / 2) * REEL_PITCH;
        const cy        = (1 - row) * CELL_WU;
        const colors    = [0xff3535, 0x00d4ff, 0x22c55e];
        return (
          <mesh key={`payline-${row}`} position={[(xFirst + xLast) / 2, cy, 0.04]}>
            <planeGeometry args={[xLast - xFirst + CELL_WU * 0.6, 0.08]} />
            <meshBasicMaterial color={colors[row]} transparent opacity={0.85} />
          </mesh>
        );
      })}

      {/* 3D pull-lever — right side of cabinet, clickable */}
      <group position={[frameW / 2 + 0.45, 0, 0]}>
        <PullLever cabinetHalfH={frameH / 2} onPull={onSpinClick} />
      </group>
    </group>
  );
}
