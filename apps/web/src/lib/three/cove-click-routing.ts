/**
 * Cove click routing: the sign outline and the click-yield decision (pure,
 * no three.js runtime imports, so both are unit-testable).
 *
 * Table signs are clickable (BankBanner `onActivate`). A sign is drawn as a
 * capsule on a 240x60 plane; the plane's corners are transparent. A click
 * ray through a transparent corner must not count as a sign hit: from inside
 * the right lane, a ray through a BLACKJACK corner otherwise took a click
 * aimed at the visible BACCARAT sign behind it (Codex review 2026-09-18).
 */

/** Sign plane size in world units (the canvas is 512x128, drawn edge to edge). */
export const COVE_SIGN_WIDTH = 240;
export const COVE_SIGN_HEIGHT = 60;

/**
 * Half-width of the visible capsule at vertical offset `dy` from the sign's
 * middle, in world units. Mirrors `_buildBankBannerTexture`: each end is two
 * quadratic curves, from (W-r, 0) with control (W, 0) to (W, r), r = H/2.
 * Solving that curve for x at a given height gives W/2 - r(1 - sqrt(1 - |dy|/r))^2:
 * the full 120 at mid-height, 90 at the top and bottom edges.
 */
export function coveSignHalfWidthAt(dy: number): number {
  const r = COVE_SIGN_HEIGHT / 2;
  const a = Math.abs(dy);
  if (a > r) return -1;
  const k = 1 - Math.sqrt(1 - a / r);
  return COVE_SIGN_WIDTH / 2 - r * k * k;
}

/** True when plane UV (u, v in 0..1) is inside the drawn capsule. */
export function coveSignContainsUv(u: number, v: number): boolean {
  const x = (u - 0.5) * COVE_SIGN_WIDTH;
  const y = (v - 0.5) * COVE_SIGN_HEIGHT;
  const hw = coveSignHalfWidthAt(y);
  return hw >= 0 && Math.abs(x) <= hw;
}

/**
 * Drop the sign-plane hits in `intersects[start..]` that land on a transparent
 * corner. Called from the sign meshes' raycast, right after the default plane
 * raycast appended its hits, so corner hits never reach the event system or
 * the click-yield rule. In place, no allocation.
 */
export function filterCoveSignHits(
  intersects: Array<{ uv?: { x: number; y: number } | null }>,
  start: number,
): void {
  let w = start;
  for (let i = start; i < intersects.length; i++) {
    const uv = intersects[i].uv;
    if (uv && coveSignContainsUv(uv.x, uv.y)) intersects[w++] = intersects[i];
  }
  intersects.length = w;
}

export interface CoveClickHit {
  distance: number;
  object: unknown;
}

/**
 * The click-yield decision for a hotspot hit at `selfDistance`: yield (let the
 * click travel on) when the ray also hits a FARTHER hotspot and no visible
 * room surface sits in front of that farther hotspot. `roomHitDistance` is the
 * nearest room-geometry hit along the ray, or null for none. `isHotspot`
 * tells hotspot objects apart (userData.coveHotspot in the scene).
 */
export function shouldYieldToFartherHotspot(
  hits: readonly CoveClickHit[],
  self: unknown,
  selfDistance: number,
  roomHitDistance: number | null,
  isHotspot: (object: unknown) => boolean,
): boolean {
  const farther = hits.find((i) => i.object !== self && i.distance > selfDistance && isHotspot(i.object));
  if (!farther) return false;
  return roomHitDistance === null || roomHitDistance > farther.distance;
}
