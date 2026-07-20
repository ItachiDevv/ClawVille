'use client';

/**
 * ReefRaceGhost.tsx — Phase 4 §2 PB ghost mesh
 *
 * Renders the player's own personal-best lap as a translucent ghost kart.
 * Max 1 ghost (self best only) — per spec §2 and Iris Xe performance budget.
 *
 * Ghost path: GhostFrame[] at 10Hz, lap-relative t (ms from 0..lapMs).
 * Reads from `useActivityStore.getState().reefRace.selfBestGhostPath`.
 *
 * Mesh: shared module-scope BoxGeometry glider board (GLIDER_WIDTH × GLIDER_HEIGHT × GLIDER_LENGTH)
 * at KART_SCALE — same geometry as live ReefRacePlayer glider boards.
 * Material: module-scope MeshStandardMaterial, purple (#a78bfa), opacity 0.4.
 * No castShadow — ghost does not fight the live shadow map.
 *
 * Fade: linearly fades in over 0.5 s at the start of each looped lap replay,
 * and fades out over 0.5 s before the end. Detected via loop position within
 * the path duration — no store subscription needed.
 *
 * Settings gate:
 *   localStorage key: "clawville.reef.showPBGhost" (default true).
 *   Checked once at component mount. UI to toggle this is Phase 4.5.
 *   FEATURE_GATE: reef_pb_ghost_toggle
 *   Status: localStorage flag respected; toggle UI not yet surfaced in HUD.
 *   Metric to graduate: any retention signal from Phase 4 instrumentation.
 *   Current reading: to fill
 *   Review deadline: 2026-06-01
 *   On deadline: if no retention metric warrants removal, keep gate; delete if unused.
 *   Reference: reef-race-phase4-detailed.md §2.4
 *
 * Iris Xe invariants:
 *   - No per-frame allocations — module-scope scratch only.
 *   - No drei Text / Billboard (hard GPU crash on Iris Xe).
 *   - import from 'three' only (NOT 'three/webgpu').
 *   - frustumCulled=false on all geometry (SkinnedMesh bind-pose cull risk).
 *   - Shared geometry + material are never disposed mid-session (multi-instance safety).
 *     Disposed only on component unmount via useEffect return.
 *
 * Draw calls: 1 (ghost glider board).
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useActivityStore } from '@/stores/activity';
import {
  KART_SCALE,
  KART_Y_ABOVE_TRACK,
  GLIDER_WIDTH,
  GLIDER_HEIGHT,
  GLIDER_LENGTH,
} from './reef-race-config';
import type { GhostFrame } from './reef-race-types';
import { elevationAtXZ } from './reef-race-elevation';

// SURF ROAD (2026-06-23): the ghost rides the floating ribbon, so its Y is the
// render-only ribbon elevation at its XZ (cheap cached lookup under the 'ghost'
// key) — NOT a flat plane. v1 ellipse path stays flat at y=0.
const USE_SPLINE_GHOST = process.env.NEXT_PUBLIC_REEF_RACE_USE_SPLINE === 'true';

// ─── Settings gate ─────────────────────────────────────────────────────────────

function readShowGhostSetting(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = localStorage.getItem('clawville.reef.showPBGhost');
    if (raw === null) return true; // default ON
    return raw !== 'false';
  } catch {
    return true;
  }
}

// ─── Module-scope shared geometry + material ──────────────────────────────────
//
// ONE instance shared across all ReefRaceGhost renders (there is only one ghost,
// but the geometry/material are created at module scope to guarantee zero alloc
// on mount/re-mount). Must NOT be disposed per-instance — only at unmount.
//
// Dimensions match ReefRacePlayer._gliderGeom: GLIDER_WIDTH × GLIDER_HEIGHT × GLIDER_LENGTH.
// At scale={[KART_SCALE, KART_SCALE, KART_SCALE]} these yield 50wu × 5wu × 100wu.

const _ghostGeom = new THREE.BoxGeometry(GLIDER_WIDTH, GLIDER_HEIGHT, GLIDER_LENGTH);
const _ghostMat  = new THREE.MeshStandardMaterial({
  color:       '#a78bfa',  // purple — differentiates ghost from live karts
  transparent: true,
  opacity:     0.4,        // per Phase 4 spec §2
  roughness:   0.6,
  metalness:   0.2,
  depthWrite:  false,      // standard for transparent meshes — avoid Z-fight with live karts
});

// ─── Module-scope scratch — NO per-frame allocations ─────────────────────────

/** Shape of the sequential scan state kept per-instance in a useRef. */
interface ScanState {
  lastFrameIdx: number;
  lastPathRef: GhostFrame[] | null;
}

/** Find the pair of GhostFrames that bracket `nowMs` and return lerp alpha.
 *  O(1) amortised — sequential scan from last known position.
 *
 *  `scan` is a per-instance ref (ScanState), NOT a module-scope singleton.
 *  Passing it as a parameter means two simultaneous GhostInner mounts
 *  (remount, Suspense re-render, fast navigation) each maintain their own
 *  cursor and cannot corrupt each other's index. */
function findGhostFrames(
  scan: ScanState,
  path: GhostFrame[],
  nowMs: number,
): { a: GhostFrame; b: GhostFrame; alpha: number } | null {
  if (path.length < 2) return null;

  // Reset scan index when path reference changes (new PB ghost loaded).
  if (scan.lastPathRef !== path) {
    scan.lastPathRef  = path;
    scan.lastFrameIdx = 0;
  }

  const start = path[0].t;
  const end   = path[path.length - 1].t;

  if (nowMs <= start) return { a: path[0], b: path[0], alpha: 0 };
  if (nowMs >= end)   return { a: path[path.length - 2], b: path[path.length - 1], alpha: 1 };

  // Sequential scan from last known index.
  let lo = Math.max(0, scan.lastFrameIdx);
  // Guard: lo must point at a frame whose t ≤ nowMs.
  if (lo > 0 && path[lo].t > nowMs) lo = 0;
  while (lo < path.length - 2 && path[lo + 1].t <= nowMs) lo++;
  scan.lastFrameIdx = lo;

  const a = path[lo];
  const b = path[lo + 1];
  const span  = b.t - a.t;
  const alpha = span > 0 ? (nowMs - a.t) / span : 0;
  return { a, b, alpha: alpha < 0 ? 0 : alpha > 1 ? 1 : alpha };
}

// ─── Fade constants ───────────────────────────────────────────────────────────

/** Duration (ms) of fade-in at the start of each looped lap. */
const FADE_IN_MS  = 500;
/** Duration (ms) of fade-out before the end of each looped lap. */
const FADE_OUT_MS = 500;
/** Target opacity (already baked into _ghostMat.opacity, but used for lerp calc). */
const GHOST_MAX_OPACITY = 0.4;

/**
 * Y elevation in LOCAL scale-space = world KART_Y_ABOVE_TRACK / KART_SCALE.
 * The glider board sits at this Y inside the KART_SCALE group, yielding the
 * correct world-space height. Matches ReefRacePlayer.GLIDER_LOCAL_Y.
 */
const GHOST_LOCAL_Y = KART_Y_ABOVE_TRACK / KART_SCALE; // = 0.25

// ─── Ghost mesh inner component ───────────────────────────────────────────────

interface GhostInnerProps {
  path: GhostFrame[];
  raceStartMs: number;
}

function GhostInner({ path, raceStartMs }: GhostInnerProps) {
  // groupRef: world XZ position + Y rotation — at scene root level so
  // position.x/z are in world space (unaffected by KART_SCALE).
  const groupRef = useRef<THREE.Group>(null);

  // Per-instance scan state — keeps the sequential cursor isolated so two
  // simultaneous GhostInner mounts (remount, Suspense re-render, fast nav)
  // cannot corrupt each other's lastFrameIdx.  Initial shape mirrors the old
  // module-scope `_scan` initialiser.
  const scanRef = useRef<ScanState>({ lastFrameIdx: 0, lastPathRef: null });

  // Cache mesh ref on mount — set geometry + material imperatively.
  // We do NOT use JSX geometry={} / material={} because those props trigger
  // R3F's auto-dispose for intrinsic elements; we manage lifetime manually.
  const meshRef = useRef<THREE.Mesh>(null);
  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.geometry = _ghostGeom;
    m.material = _ghostMat;
    m.castShadow    = false;  // ghost does not fight the live shadow map
    m.receiveShadow = false;
    m.frustumCulled = false;  // bounding sphere may be stale — always render
    // Do NOT dispose on unmount — _ghostGeom/_ghostMat are module-scope,
    // shared across any re-mounts. Only dispose if this component is the
    // LAST user; in practice there is at most 1 ghost, but it's safer to
    // leave shared module-scope resources alive for the page lifetime.
  }, []);

  useFrame(() => {
    const group = groupRef.current;
    if (!group || !path.length) return;

    // ── Lap-relative ghost position ────────────────────────────────────────
    // Ghost path t values are lap-relative (0..lapMs). We loop the playback
    // over the path duration using elapsed time from race start.
    const elapsedMs = Date.now() - raceStartMs;
    const pathDuration = path[path.length - 1].t - path[0].t;
    if (pathDuration <= 0) return;

    // Loop position within the ghost path (0..pathDuration).
    const loopMs  = elapsedMs % pathDuration;
    // Absolute ghost time within the lap-relative path.
    const ghostMs = path[0].t + loopMs;

    const frames = findGhostFrames(scanRef.current, path, ghostMs);
    if (!frames) return;

    const { a, b, alpha } = frames;

    // Apply interpolated world XZ position on the OUTER group.
    // groupRef is at scene root (identity parent), so position.x/z are world coords.
    // KART_SCALE only applies to children inside the inner scaled group.
    const gx = a.x + (b.x - a.x) * alpha;
    const gz = a.z + (b.z - a.z) * alpha;
    group.position.x = gx;
    // SURF ROAD: lift onto the floating ribbon (render-only elevation at XZ).
    // The inner scaled group still adds GHOST_LOCAL_Y (board-above-track) on top.
    group.position.y = USE_SPLINE_GHOST ? elevationAtXZ(gx, gz, 'ghost') : 0;
    group.position.z = gz;

    // Lerp rotation via shortest arc.
    let dr = b.rot - a.rot;
    if (dr >  Math.PI) dr -= 2 * Math.PI;
    if (dr < -Math.PI) dr += 2 * Math.PI;
    group.rotation.y = a.rot + dr * alpha;

    // ── Fade in/out based on loop position ────────────────────────────────
    // Fade in over FADE_IN_MS at start of each loop, fade out over FADE_OUT_MS
    // before end of each loop. This makes the ghost feel like it "appears" at
    // the start of each lap and "disappears" as it crosses the finish line.
    let fadeAlpha: number;
    if (loopMs < FADE_IN_MS) {
      fadeAlpha = loopMs / FADE_IN_MS;
    } else if (loopMs > pathDuration - FADE_OUT_MS) {
      fadeAlpha = (pathDuration - loopMs) / FADE_OUT_MS;
    } else {
      fadeAlpha = 1;
    }
    // Clamp to [0, 1] to guard against rounding at boundaries.
    fadeAlpha = fadeAlpha < 0 ? 0 : fadeAlpha > 1 ? 1 : fadeAlpha;

    // Write opacity — material is shared, so this affects any concurrent
    // ghost renders (there is only ever one). No traverse needed (single mesh).
    _ghostMat.opacity = fadeAlpha * GHOST_MAX_OPACITY;
  });

  return (
    /*
     * Scene graph:
     *   groupRef  — world XZ position + Y rotation (updated in useFrame above)
     *     └── scaled group  — applies KART_SCALE to all children
     *           └── meshRef  — glider board, local Y = GHOST_LOCAL_Y (= KART_Y_ABOVE_TRACK/KART_SCALE)
     *
     * groupRef.position is in world space (parent is scene root = identity transform).
     * Inner scaled group child position.y = GHOST_LOCAL_Y converts to world Y = KART_Y_ABOVE_TRACK.
     * Same structure as ReefRacePlayer: groupRef (world XZ) → gliderRef (scale + local Y).
     */
    <group ref={groupRef}>
      <group scale={[KART_SCALE, KART_SCALE, KART_SCALE]}>
        <mesh ref={meshRef} position={[0, GHOST_LOCAL_Y, 0]} />
      </group>
    </group>
  );
}

// ─── Public wrapper ───────────────────────────────────────────────────────────

interface ReefRaceGhostProps {
  /** Wall-clock ms when the race entered 'live' phase. 0 when not live. */
  raceStartMs?: number;
}

export default function ReefRaceGhost({ raceStartMs = 0 }: ReefRaceGhostProps) {
  // Read ghost setting once on mount — re-reading every render is unnecessary;
  // this component is only mounted during an active race session.
  const showGhost = useMemo(() => readShowGhostSetting(), []);

  // Subscribe to selfBestGhostPath (array ref changes only when a new PB loads).
  // Using getState() here would avoid re-renders, but we WANT a remount when the
  // ghost path changes (so GhostInner gets a fresh path prop and the scan resets).
  const ghostPath = useActivityStore((s) => s.reefRace?.selfBestGhostPath ?? null);

  if (!showGhost) return null;
  if (!ghostPath || ghostPath.length < 2) return null;
  if (raceStartMs === 0) return null; // race not live yet — no elapsed time to compute

  return <GhostInner path={ghostPath} raceStartMs={raceStartMs} />;
}
