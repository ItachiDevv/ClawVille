/**
 * reef-race-elevation.ts
 *
 * The RENDER-ONLY vertical datum for the SURF ROAD floating ribbon.
 *
 * The server sim is purely 2D (XZ). `@clawville/shared` exports two pure
 * render-only functions describing the floating ribbon's Y altitude + bank tilt
 * as a function of spline parameter t:
 *   - `reefTrackElevationAt(t)`   → Y altitude (wu), fully periodic (C1 at seam)
 *   - `reefTrackBankAngleAt(t, h)`→ bank lean (radians, ±28° cap); `h` is a
 *                                    heading sampler the caller binds to the spline
 *
 * THE PARITY CONTRACT (the load-bearing invariant): the track ribbon geometry,
 * the rider group, AND the chase camera ALL read the SAME elevation(t)+bank(t)
 * so the surfer rides ON the ribbon and the camera frames it through every
 * climb/dip/bank. The #1 historical bug was the surfer riding a surface while
 * the water sat 200wu below — never recreate it. Ribbon-Y, rider-Y, camera-Y
 * all flow from THIS module.
 *
 * Per-body `heightOffset` (the sim's jump/ramp airborne metres, broadcast as
 * `entity.height`) is ADDED ON TOP of `elevationAtT(t)` — it does not replace it.
 *
 * ─── Cheap per-frame XZ → t lookup ───────────────────────────────────────────
 *
 * The rider + camera know the body's world XZ but NOT its spline-t (the snapshot
 * carries x/y/rot/height, not t). `clientSpline.closestPointOnSpline` is a full
 * O(1000)-sample LUT scan + 6 Newton iters — far too costly to run per-frame for
 * up to 8 karts (8000 centerline evals/frame). Instead we keep a PER-KEY cached
 * last-t and only LOCAL-SCAN a small window of LUT samples around it (the kart's
 * t changes by a tiny amount each frame), then one Newton polish. ~2×WINDOW+1
 * centerline evals/lookup vs 1000 — a >10× cut, and it tracks the smooth motion
 * exactly. A fresh key (first frame, or a teleport/respawn) falls back to the
 * full closest-point scan once, then rides the cache.
 *
 * Zero per-call allocation (scalars + a reused scratch object).
 *
 * @module reef-race-elevation
 */

import { reefTrackElevationAt, reefTrackBankAngleAt } from '@clawville/shared';
import { clientSpline } from './reef-race-spline-instance';

// ─── Heading sampler bound to the shared client spline ───────────────────────
// `reefTrackBankAngleAt` is pure: the caller supplies the heading at a given t.
// atan2(tangent.z, tangent.x) is the world-space heading of the centerline at t.
function _headingAt(tt: number): number {
  const tg = clientSpline.tangentAt(tt);
  return Math.atan2(tg.z, tg.x);
}

/** Render-only Y altitude (wu) of the floating ribbon centerline at spline t. */
export function elevationAtT(t: number): number {
  return reefTrackElevationAt(t);
}

/** Render-only bank lean (radians) the ribbon tilts INTO the turn at spline t. */
export function bankAngleAtT(t: number): number {
  return reefTrackBankAngleAt(t, _headingAt);
}

// ─── XZ → t cache (per render-key: 'cam', avatarId, …) ───────────────────────

interface _TCacheEntry {
  t: number;
  /** Last frame this key was touched — lets us prune stale keys cheaply. */
  seenAt: number;
}

const _tCache = new Map<string, _TCacheEntry>();

/** LUT half-window for the local scan. The LUT has 1000 entries (Δt=0.001). A
 *  kart at REEF_MAX_SPEED=500 wu/s over arc 60256 covers ≈0.0083 t/s ≈ 0.00014
 *  t/frame@60fps — so ±24 samples (±0.024 t) is a generous, robust window even
 *  after a few dropped frames. */
const _SCAN_HALF_WINDOW = 24;
const _LUT_SAMPLES = 1000; // matches ReefSpline LUT_SAMPLES

/**
 * Resolve the spline parameter t for a world XZ position, cached per `key`.
 *
 * First call for a key (or a hard jump beyond the local window's reach) does a
 * full `closestPointOnSpline`. Subsequent calls local-scan ±_SCAN_HALF_WINDOW
 * LUT samples around the cached t and refine — O(2·window) centerline evals.
 *
 * @param x    world X
 * @param z    world Z (sim Y)
 * @param key  stable per-body key ('cam' for the self-cam, avatarId per kart)
 */
export function tAtXZ(x: number, z: number, key: string): number {
  const cached = _tCache.get(key);
  const now = performance.now();

  if (cached === undefined) {
    // Cold key — pay the full scan once, then ride the cache.
    const res = clientSpline.closestPointOnSpline({ x, z });
    _tCache.set(key, { t: res.t, seenAt: now });
    return res.t;
  }

  // ── Local scan: sample LUT t-values in a window around the cached t ────────
  const centerSample = Math.round(cached.t * _LUT_SAMPLES);
  let bestT = cached.t;
  let bestDistSq = Infinity;

  for (let d = -_SCAN_HALF_WINDOW; d <= _SCAN_HALF_WINDOW; d++) {
    // Wrap into [0,1) — the loop is closed/periodic.
    let i = centerSample + d;
    i = ((i % _LUT_SAMPLES) + _LUT_SAMPLES) % _LUT_SAMPLES;
    const lt = i / _LUT_SAMPLES;
    const c = clientSpline.centerlineAt(lt);
    const dx = c.x - x;
    const dz = c.z - z;
    const dsq = dx * dx + dz * dz;
    if (dsq < bestDistSq) {
      bestDistSq = dsq;
      bestT = lt;
    }
  }

  // ── Window-escape guard ────────────────────────────────────────────────────
  // If the best sample is pinned at the very edge of the window, the body
  // jumped further than the window can track (teleport / respawn / big stall) —
  // fall back to a full scan so we re-acquire the correct basin.
  const edge = _SCAN_HALF_WINDOW / _LUT_SAMPLES;
  const delta = Math.abs(_cyclicDelta(bestT, cached.t));
  let t = bestT;
  if (delta >= edge - 1e-6) {
    t = clientSpline.closestPointOnSpline({ x, z }).t;
  }

  cached.t = t;
  cached.seenAt = now;
  return t;
}

/** Shortest cyclic difference a-b in [-0.5, 0.5]. */
function _cyclicDelta(a: number, b: number): number {
  let d = a - b;
  while (d > 0.5) d -= 1;
  while (d < -0.5) d += 1;
  return d;
}

/** Render-only Y altitude for a world XZ position, cached per key. Convenience
 *  wrapper combining {@link tAtXZ} + {@link elevationAtT}. */
export function elevationAtXZ(x: number, z: number, key: string): number {
  return reefTrackElevationAt(tAtXZ(x, z, key));
}

/**
 * Drop a cached key (call when a body despawns / the scene unmounts) so the Map
 * doesn't accrete dead keys across long sessions. Safe to call with an unknown
 * key. The 'cam' key is dropped on scene teardown.
 */
export function forgetTKey(key: string): void {
  _tCache.delete(key);
}

/** Clear the whole cache (scene teardown). */
export function resetElevationCache(): void {
  _tCache.clear();
}
