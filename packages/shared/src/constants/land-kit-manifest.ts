/**
 * land-kit-manifest.ts — the FROZEN measured render manifest for the 12 kit
 * pieces (gamification pass §5.3, slice P2b).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this manifest, every piece was normalized to the same cell-relative
 * cube: `fitKitPieceToCell()` scaled each GLB so its widest XZ span hit 0.92 of
 * a grid cell (small) or 1.9 cells (large). That made price and geometry
 * disagree — a 60-vCLAW `statue-anchor` rendered 56.3 wu wide while a 15-vCLAW
 * `fence-picket` rendered 62.6 wu (defect N-1) — and pinned seven of twelve
 * pieces at or below 0.19× a 270 wu avatar, one at 0.0122× (defect N-2).
 *
 * The manifest replaces "fit to a cell" with "render at an authored height".
 * `targetHeightWu` is the frozen authored number; the X and Z extents fall out
 * of the GLB's own aspect ratio at the uniform scale that height implies. The
 * renderer derives that same scale at runtime from the loaded bbox, so the
 * predicate below and the pixels on screen cannot disagree.
 *
 * MEASUREMENT PROVENANCE
 * ----------------------
 * `sourceExtent` is the world-space bounding box of every mesh in the shipped
 * GLB under `apps/web/public/models/land-kit/<pieceKey>.glb`, node transforms
 * applied — the same box `resolvePieceSource()` computes at runtime. Re-measure
 * and re-verify with `bun scripts/land-kit/verify-manifest.mjs`, which is the
 * §4.3 "manifest match: exact" QC gate. Any asset re-author MUST re-run it.
 *
 * STACKING (Q8)
 * -------------
 * `supportSurfaceYWu` is the height, above a piece's own base, at which another
 * piece may rest on it — or `null` when nothing may stack on it. Only the two
 * pieces whose whole purpose is being a floor carry one: `path-stone` (8) and
 * `deck-plank` (40). You cannot stack on a lantern, a statue, or an arch. This
 * is what bounds the vertical extent: the worst legal stack at
 * `maxStackHeight = 3` is deck-plank → deck-plank → statue-anchor, topping out
 * at 40 + 40 + 292 = 372 wu (§4.4 budget e).
 */

import { KIT_CATALOG, type KitPieceKey, type KitPieceSize } from './land-kit';

/**
 * Which of the eight 45° rotation steps a piece advertises.
 *
 * `orthogonal` is NOT a style choice — it is applied only where per-rotation
 * enumeration found an advertised step with ZERO legal anchors on some tier, so
 * advertising it would hand players a rotation that can never be placed:
 *   • `arch-driftwood` — starter [52,0,52,0,…], founder [28,0,28,0,…]
 *   • `path-stone`     — founder [52,0,52,0,…]
 * `fence-picket`, `fence-rope`, `bench-wood` and `deck-plank` keep all eight.
 */
export const KIT_ROTATION_MODES = ['all', 'orthogonal'] as const;
export type KitRotationMode = (typeof KIT_ROTATION_MODES)[number];

/** The eight authored rotation steps, in 45° units. */
export const KIT_ROTATION_STEPS = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7] as const);

/** The four orthogonal rotation steps, in 45° units. */
export const KIT_ORTHOGONAL_ROTATION_STEPS = Object.freeze([0, 2, 4, 6] as const);

/** Raw GLB bounding-box span, in the asset's own units. Provenance only. */
export interface KitSourceExtent {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface KitPieceRender {
  /** Rendered span on local X, in world units, before rotation. */
  readonly extentXWu: number;
  /** Rendered span on local Z, in world units, before rotation. */
  readonly extentZWu: number;
  /** Rendered span on Y, in world units. Equals `targetHeightWu`. */
  readonly extentYWu: number;
  /** Authored render height. The uniform scale is `targetHeightWu / sourceExtent.y`. */
  readonly targetHeightWu: number;
  /** Q8 — `null` means nothing may stack on this piece. */
  readonly supportSurfaceYWu: number | null;
  /** Largest XZ span reachable over the piece's ADVERTISED rotation steps. */
  readonly maxFootprintWu: number;
  /** Vertical reach of one unstacked instance. Equals `extentYWu`. */
  readonly maxHeightWu: number;
  readonly rotations: KitRotationMode;
  /** Fee + level-cap class ONLY. Never a geometry input — that is the whole point. */
  readonly size: KitPieceSize;
  /** Measured GLB bbox span. Verified by the QC script; not read at runtime. */
  readonly sourceExtent: KitSourceExtent;
}

/** The rotation steps `mode` advertises. */
export function advertisedRotationSteps(mode: KitRotationMode): readonly number[] {
  return mode === 'all' ? KIT_ROTATION_STEPS : KIT_ORTHOGONAL_ROTATION_STEPS;
}

/**
 * Half-extents of a piece's axis-aligned bounding box after rotating it by
 * `rotationStep` × 45° about Y. A rectangle X×Z rotated by θ spans
 * `X·|cosθ| + Z·|sinθ|` on X and `X·|sinθ| + Z·|cosθ|` on Z.
 */
export function rotatedHalfExtents(
  render: Pick<KitPieceRender, 'extentXWu' | 'extentZWu'>,
  rotationStep: number,
): { readonly halfX: number; readonly halfZ: number } {
  const angle = (rotationStep * Math.PI) / 4;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  return {
    halfX: (render.extentXWu * cos + render.extentZWu * sin) / 2,
    halfZ: (render.extentXWu * sin + render.extentZWu * cos) / 2,
  };
}

function maxAdvertisedFootprint(
  extentXWu: number,
  extentZWu: number,
  rotations: KitRotationMode,
): number {
  let widest = 0;
  for (const step of advertisedRotationSteps(rotations)) {
    const { halfX, halfZ } = rotatedHalfExtents({ extentXWu, extentZWu }, step);
    widest = Math.max(widest, halfX * 2, halfZ * 2);
  }
  return widest;
}

interface KitManifestSeed {
  readonly targetHeightWu: number;
  readonly supportSurfaceYWu: number | null;
  readonly rotations: KitRotationMode;
  readonly sourceExtent: KitSourceExtent;
}

/**
 * Frozen seeds. `targetHeightWu` is authored (§5.3); `sourceExtent` is measured.
 * Everything else in `KIT_PIECE_RENDER` is derived below so a re-measure cannot
 * leave a stale cross-field inconsistency behind.
 */
const KIT_MANIFEST_SEEDS = {
  'path-stone': {
    targetHeightWu: 8,
    supportSurfaceYWu: 8,
    rotations: 'orthogonal',
    sourceExtent: { x: 1.8726, y: 0.0998, z: 1.8969 },
  },
  // RE-AUTHORED 2026-08-09. Re-frozen on PLAN FOOTPRINT, not on the old height.
  //
  // The original mesh measured H/W 0.801 — a block, not a plank — which §5.3
  // flagged ROLE-MISMATCH and put on the re-author list, because funding
  // stacking made its flat-platform role load-bearing. The replacement measures
  // H/W 0.107, so it is finally the shape its name claims.
  //
  // The old `targetHeightWu: 40` could NOT be inherited. Scale is uniform and
  // driven by height, so 40 wu of height on the new proportions renders the
  // piece 374 wu wide — five times any other small piece — for a 5-vCLAW item.
  // Sweeping the height against the predicate showed a cliff at 20 wu, where
  // the 45° steps go zero-legal on founder and the piece would have to drop to
  // `orthogonal`; its placement count also collapses (416/112/528). That is
  // backwards for the one piece players tile a floor out of, which should be
  // the EASIEST thing to place, not one of the hardest.
  //
  // So the height is chosen to preserve the frozen PLAN footprint instead:
  // 6 wu renders 56.1 × 24.2, against the §5.3 row's 50 × 22, and reproduces
  // that row's placement counts (1,248 / 992 / 1,248) and min/step (112)
  // EXACTLY, with full rotation intact as §5.3 states. The re-author therefore
  // changes the piece's shape and nothing else about its contract.
  //
  // Consequence worth naming: the deck is now a flush floorboard, so its
  // support surface lifts a stacked piece 6 wu rather than 40. That is
  // physically right for a flat plank, and it makes `path-stone` (8) the
  // tallest support in the catalog. If the founder wants a RAISED deck to
  // stack onto, that needs another mesh with real thickness — it cannot be
  // recovered by retuning this number, because scale is uniform.
  'deck-plank': {
    targetHeightWu: 6,
    supportSurfaceYWu: 6,
    rotations: 'all',
    sourceExtent: { x: 1.8973, y: 0.2031, z: 0.8195 },
  },
  'fence-picket': {
    targetHeightWu: 105,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 1.8953, y: 1.0449, z: 0.2841 },
  },
  'fence-rope': {
    targetHeightWu: 88,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 1.8962, y: 0.8771, z: 0.3178 },
  },
  'bench-wood': {
    targetHeightWu: 85,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 1.8981, y: 1.0817, z: 0.8446 },
  },
  'planter-box': {
    targetHeightWu: 87,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 1.8672, y: 1.3563, z: 1.3356 },
  },
  'planter-coral': {
    targetHeightWu: 93,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 1.8973, y: 1.4764, z: 1.2258 },
  },
  'banner-pole': {
    targetHeightWu: 232,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 0.9017, y: 1.8978, z: 0.249 },
  },
  'lantern-post': {
    targetHeightWu: 250,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 0.407, y: 1.8987, z: 0.4072 },
  },
  'statue-shell': {
    targetHeightWu: 217,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 1.138, y: 1.898, z: 0.8738 },
  },
  'statue-anchor': {
    targetHeightWu: 292,
    supportSurfaceYWu: null,
    rotations: 'all',
    sourceExtent: { x: 0.7142, y: 1.8987, z: 0.5906 },
  },
  'arch-driftwood': {
    targetHeightWu: 197,
    supportSurfaceYWu: null,
    rotations: 'orthogonal',
    sourceExtent: { x: 1.8856, y: 1.858, z: 1.3975 },
  },
} as const satisfies Record<KitPieceKey, KitManifestSeed>;

function buildManifest(): Readonly<Record<KitPieceKey, KitPieceRender>> {
  const entries = {} as Record<KitPieceKey, KitPieceRender>;
  for (const pieceKey of Object.keys(KIT_MANIFEST_SEEDS) as KitPieceKey[]) {
    const seed: KitManifestSeed = KIT_MANIFEST_SEEDS[pieceKey];
    const scale = seed.targetHeightWu / seed.sourceExtent.y;
    const extentXWu = seed.sourceExtent.x * scale;
    const extentZWu = seed.sourceExtent.z * scale;
    entries[pieceKey] = Object.freeze({
      extentXWu,
      extentZWu,
      extentYWu: seed.targetHeightWu,
      targetHeightWu: seed.targetHeightWu,
      supportSurfaceYWu: seed.supportSurfaceYWu,
      maxFootprintWu: maxAdvertisedFootprint(extentXWu, extentZWu, seed.rotations),
      maxHeightWu: seed.targetHeightWu,
      rotations: seed.rotations,
      size: KIT_CATALOG[pieceKey].size,
      sourceExtent: seed.sourceExtent,
    });
  }
  return Object.freeze(entries);
}

/** The frozen §5.3 manifest, keyed by the shared catalog's piece keys. */
export const KIT_PIECE_RENDER: Readonly<Record<KitPieceKey, KitPieceRender>> = buildManifest();

/**
 * Tallest legal stack, in world units above a parcel floor, at
 * `maxStackHeight = 3`. Bounds the render layer's chunk vertical extent
 * (§4.4 budget e). Computed rather than hardcoded so a support-surface or
 * target-height change moves the frustum-culling box with it.
 *
 * The worst stack is `argmax` over supports of (n−1 support surfaces) plus the
 * tallest piece on top: deck-plank (40) → deck-plank (40) → statue-anchor
 * (292) = 372 wu. The previous cell-relative bound was 235.2 wu, which is why
 * two stacked lanterns used to overlap by 216 wu (defect N-3).
 */
export function maxStackHeightWu(maxStackLevels: number): number {
  const levels = Math.max(1, Math.floor(maxStackLevels));
  let tallestSupport = 0;
  let tallestPiece = 0;
  for (const render of Object.values(KIT_PIECE_RENDER)) {
    if (render.supportSurfaceYWu !== null) {
      tallestSupport = Math.max(tallestSupport, render.supportSurfaceYWu);
    }
    tallestPiece = Math.max(tallestPiece, render.extentYWu);
  }
  return (levels - 1) * tallestSupport + tallestPiece;
}

/** The absolute vertical bound across every level rule the ladder allows. */
export const KIT_MAX_STACK_HEIGHT_WU = maxStackHeightWu(3);

/** Largest rendered XZ span any piece can reach in an advertised rotation. */
export const KIT_MAX_PIECE_FOOTPRINT_WU = Object.values(KIT_PIECE_RENDER).reduce(
  (widest, render) => Math.max(widest, render.maxFootprintWu),
  0,
);
