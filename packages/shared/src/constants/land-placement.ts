/**
 * land-placement.ts — `evaluatePlacement`, the ONE kit-placement legality
 * predicate (gamification pass §5.4, slice P3).
 *
 * It replaces `isCellPlaceable`, which validated the ANCHOR CELL ONLY (defect
 * D-1). Pieces span up to five cells once rotated, so anchor-only validation
 * let a `path-stone` anchored on a legal perimeter cell overhang the shell
 * reservation by most of its 150 wu width, and let two pieces occupy the same
 * ground while both passed the check.
 *
 * Three things this predicate is deliberate about:
 *
 *   1. It is SHARED. The server enforces it on the write path and the yard
 *      editor draws its ghost from it, so a ghost that reads legal cannot be
 *      refused on submit. Two implementations would drift.
 *
 *   2. The shell reservation it subtracts is `shellEnvelopeHalfWu(tier)`, which
 *      takes NO level. A placement legal at Lv1 stays legal at Lv5.
 *
 *   3. It is 3D (Q8). Cross-level occupancy is tested on Y as well as XZ, so a
 *      piece resting on a deck plank no longer reads as a collision with the
 *      plank, and two lanterns at the same anchor no longer both pass.
 *
 * GRANDFATHERING (Q5). This predicate answers "may this placement be written
 * NOW". It is NOT a render filter. An existing paid row that a stricter rule
 * makes illegal is kept and rendered where it is; its owner may move it to a
 * legal position at no fee. Callers MUST NOT delete or refuse to draw a row
 * because `evaluatePlacement` refuses it — re-validate only on move.
 */

import { type LandTier } from './land-tiers';
import { getParcelFootprintWu } from './land-parcels';
import { shellEnvelopeHalfWu } from './land-economy';
import {
  KIT_GRID_SIZE,
  KIT_LEVEL_RULES,
  isPiecePlacementAllowed,
  isRotationAllowed,
  type KitPieceKey,
  type KitStructureLevel,
} from './land-kit';
import { KIT_PIECE_RENDER, advertisedRotationSteps, rotatedHalfExtents } from './land-kit-manifest';

/** Floating-point slack, in world units, for boundary comparisons. */
const PLACEMENT_EPSILON_WU = 1e-6;

export interface PlacementRequest {
  readonly pieceKey: KitPieceKey;
  /** Anchor cell, 0..15. */
  readonly gridX: number;
  /** Anchor cell, 0..15. */
  readonly gridY: number;
  /** 0..7, in 45° units. */
  readonly rotationStep: number;
  /** 1..`maxStackHeight` for the structure level. */
  readonly stackLevel: number;
}

/** A placement already on the parcel, in the same parcel-local wu frame. */
export interface PlacedFootprint {
  readonly pieceRef: string;
  readonly stackLevel: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Manifest-derived, NOT `floorY + (n−1) × 34`. */
  readonly minY: number;
  readonly maxY: number;
  /** Absolute Y another piece may rest at, or `null` when nothing may stack. */
  readonly supportSurfaceY: number | null;
}

export interface PlacementContext {
  readonly parcelTier: LandTier;
  /** Current structure level on the parcel — drives caps, rotation and stack height. */
  readonly structureLevel: number;
  /** Small pieces already placed, EXCLUDING the piece being moved. */
  readonly currentSmall: number;
  /** Large pieces already placed, EXCLUDING the piece being moved. */
  readonly currentLarge: number;
  /** Footprints already on the parcel, EXCLUDING the piece being moved. */
  readonly occupied: readonly PlacedFootprint[];
}

export type PlacementRefusalCode =
  | 'piece_unknown'
  | 'cell_out_of_bounds'
  | 'rotation_not_allowed'
  | 'level_cap_exceeded'
  | 'stack_exceeds_height'
  | 'unsupported_stack'
  | 'outside_parcel'
  | 'intersects_shell'
  | 'intersects_piece';

export type PlacementVerdict =
  | { readonly ok: true; readonly footprint: PlacedFootprint }
  | { readonly ok: false; readonly code: PlacementRefusalCode };

/** Parcel-local wu of the centre of grid cell `grid` on a `sideWu` parcel. */
export function kitCellCentreWu(grid: number, sideWu: number): number {
  const cell = sideWu / KIT_GRID_SIZE;
  return (grid + 0.5) * cell - sideWu / 2;
}

function levelRule(structureLevel: number) {
  if (!Number.isInteger(structureLevel) || structureLevel < 1 || structureLevel > 5) return null;
  return KIT_LEVEL_RULES[structureLevel as KitStructureLevel];
}

/**
 * Compute the footprint a request WOULD occupy, ignoring every legality rule
 * except the geometry it needs (piece known, anchor in bounds, supporter found).
 * The renderer uses this to place grandfathered rows the predicate refuses.
 *
 * Returns `null` only when the piece key is unknown, the anchor is off-grid, or
 * a stacked piece has no supporter to derive its Y from.
 */
export function resolveFootprint(
  req: PlacementRequest,
  parcelTier: LandTier,
  occupied: readonly PlacedFootprint[],
  pieceRef = 'pending',
): PlacedFootprint | null {
  const render = KIT_PIECE_RENDER[req.pieceKey];
  if (!render) return null;
  if (
    !Number.isInteger(req.gridX)
    || !Number.isInteger(req.gridY)
    || req.gridX < 0
    || req.gridX >= KIT_GRID_SIZE
    || req.gridY < 0
    || req.gridY >= KIT_GRID_SIZE
  ) {
    return null;
  }
  if (!Number.isInteger(req.rotationStep) || req.rotationStep < 0 || req.rotationStep > 7) {
    return null;
  }
  const stackLevel = req.stackLevel;
  if (!Number.isInteger(stackLevel) || stackLevel < 1) return null;

  const sideWu = getParcelFootprintWu(parcelTier);
  const centreX = kitCellCentreWu(req.gridX, sideWu);
  const centreZ = kitCellCentreWu(req.gridY, sideWu);
  const { halfX, halfZ } = rotatedHalfExtents(render, req.rotationStep);

  let minY = 0;
  if (stackLevel > 1) {
    const supporter = findSupporter(centreX, centreZ, stackLevel, occupied);
    if (!supporter) return null;
    minY = supporter.supportSurfaceY as number;
  }

  return {
    pieceRef,
    stackLevel,
    minX: centreX - halfX,
    maxX: centreX + halfX,
    minZ: centreZ - halfZ,
    maxZ: centreZ + halfZ,
    minY,
    maxY: minY + render.extentYWu,
    supportSurfaceY:
      render.supportSurfaceYWu === null ? null : minY + render.supportSurfaceYWu,
  };
}

/**
 * The supporter of a piece at `stackLevel`: a footprint one level below whose
 * support surface exists and whose rotated XZ box CONTAINS the new piece's
 * centre. Containing the centre (rather than merely overlapping) is what keeps
 * a piece from balancing on the corner of a plank it barely clips.
 */
function findSupporter(
  centreX: number,
  centreZ: number,
  stackLevel: number,
  occupied: readonly PlacedFootprint[],
): PlacedFootprint | null {
  for (const candidate of occupied) {
    if (candidate.stackLevel !== stackLevel - 1) continue;
    if (candidate.supportSurfaceY === null) continue;
    if (
      centreX < candidate.minX - PLACEMENT_EPSILON_WU
      || centreX > candidate.maxX + PLACEMENT_EPSILON_WU
      || centreZ < candidate.minZ - PLACEMENT_EPSILON_WU
      || centreZ > candidate.maxZ + PLACEMENT_EPSILON_WU
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * True when two axis-aligned boxes overlap on all three axes.
 *
 * INVARIANT THIS RELIES ON — a support piece's `supportSurfaceYWu` must equal
 * its `extentYWu`. A stacked piece is tested against EVERY occupied footprint,
 * including its own supporter, and it clears that test only because its `minY`
 * lands exactly on the supporter's `maxY`, which the epsilon treats as touching
 * rather than overlapping. Both floor pieces satisfy this today: `path-stone`
 * (8/8) and `deck-plank` (40/40) have their support surface AT the top of their
 * bounding box.
 *
 * Author a floor whose usable surface sits BELOW its own bbox top — a raised-rim
 * table, a shelf under a canopy — and anything placed on it would read as
 * intersecting its own supporter and be refused `intersects_piece` no matter
 * where it went. The fix at that point is to exclude the resolved supporter from
 * the collision sweep, not to shrink the piece. The G-H gate ("every support
 * piece admits at least one legal stacked placement per tier") fails loudly the
 * moment such an asset is added, so this is a guarded landmine rather than a
 * silent one — but it is cheaper to read this comment than to re-derive it from
 * a red test.
 */
function intersects3D(a: PlacedFootprint, b: PlacedFootprint): boolean {
  return (
    a.minX < b.maxX - PLACEMENT_EPSILON_WU
    && a.maxX > b.minX + PLACEMENT_EPSILON_WU
    && a.minZ < b.maxZ - PLACEMENT_EPSILON_WU
    && a.maxZ > b.minZ + PLACEMENT_EPSILON_WU
    && a.minY < b.maxY - PLACEMENT_EPSILON_WU
    && a.maxY > b.minY + PLACEMENT_EPSILON_WU
  );
}

/**
 * Full placement legality. Order matters — each refusal code is only reachable
 * once every earlier condition holds, so a caller can surface the FIRST real
 * reason rather than a generic rejection:
 *
 *   piece known → anchor in bounds → rotation allowed by BOTH the level rule
 *   and the piece's own `rotations` → level piece cap → stack height →
 *   support test → rotated AABB inside the parcel → disjoint from the
 *   level-free shell envelope → 3D-disjoint from every occupied footprint.
 */
export function evaluatePlacement(
  req: PlacementRequest,
  ctx: PlacementContext,
): PlacementVerdict {
  const render = KIT_PIECE_RENDER[req.pieceKey];
  if (!render) return { ok: false, code: 'piece_unknown' };

  if (
    !Number.isInteger(req.gridX)
    || !Number.isInteger(req.gridY)
    || req.gridX < 0
    || req.gridX >= KIT_GRID_SIZE
    || req.gridY < 0
    || req.gridY >= KIT_GRID_SIZE
  ) {
    return { ok: false, code: 'cell_out_of_bounds' };
  }

  const rule = levelRule(ctx.structureLevel);
  if (!rule) return { ok: false, code: 'level_cap_exceeded' };

  if (!isRotationAllowed(ctx.structureLevel, req.rotationStep)) {
    return { ok: false, code: 'rotation_not_allowed' };
  }
  if (!advertisedRotationSteps(render.rotations).includes(req.rotationStep)) {
    return { ok: false, code: 'rotation_not_allowed' };
  }

  if (!isPiecePlacementAllowed(ctx.structureLevel, ctx.currentSmall, ctx.currentLarge, render.size)) {
    return { ok: false, code: 'level_cap_exceeded' };
  }

  if (
    !Number.isInteger(req.stackLevel)
    || req.stackLevel < 1
    || req.stackLevel > rule.maxStackHeight
  ) {
    return { ok: false, code: 'stack_exceeds_height' };
  }

  const footprint = resolveFootprint(req, ctx.parcelTier, ctx.occupied);
  // Every non-support failure is already excluded above, so a null here can only
  // mean the stacked piece found no valid supporter beneath it.
  if (!footprint) return { ok: false, code: 'unsupported_stack' };

  const sideWu = getParcelFootprintWu(ctx.parcelTier);
  const parcelHalf = sideWu / 2;
  if (
    footprint.minX < -parcelHalf - PLACEMENT_EPSILON_WU
    || footprint.maxX > parcelHalf + PLACEMENT_EPSILON_WU
    || footprint.minZ < -parcelHalf - PLACEMENT_EPSILON_WU
    || footprint.maxZ > parcelHalf + PLACEMENT_EPSILON_WU
  ) {
    return { ok: false, code: 'outside_parcel' };
  }

  // The shell reservation is a square column of unbounded height: a piece may
  // not sit above the shell either, so this test is XZ-only by design.
  const shellHalf = shellEnvelopeHalfWu(ctx.parcelTier);
  const clearsShell =
    footprint.maxX <= -shellHalf + PLACEMENT_EPSILON_WU
    || footprint.minX >= shellHalf - PLACEMENT_EPSILON_WU
    || footprint.maxZ <= -shellHalf + PLACEMENT_EPSILON_WU
    || footprint.minZ >= shellHalf - PLACEMENT_EPSILON_WU;
  if (!clearsShell) return { ok: false, code: 'intersects_shell' };

  for (const other of ctx.occupied) {
    if (intersects3D(footprint, other)) return { ok: false, code: 'intersects_piece' };
  }

  return { ok: true, footprint };
}

/**
 * Every legal (anchor, rotation) pair for one piece on an EMPTY parcel of
 * `tier` at that tier's maximum structure level. The G-H feasibility gate and
 * the editor's "where can this go" highlight both read this.
 *
 * Empty and max-level by construction: it answers "is this piece placeable at
 * all on this tier", not "is it placeable in this particular yard right now".
 */
export function legalPlacements(
  pieceKey: KitPieceKey,
  tier: LandTier,
  structureLevel: number,
): readonly PlacementRequest[] {
  const render = KIT_PIECE_RENDER[pieceKey];
  if (!render) return [];
  const results: PlacementRequest[] = [];
  const ctx: PlacementContext = {
    parcelTier: tier,
    structureLevel,
    currentSmall: 0,
    currentLarge: 0,
    occupied: [],
  };
  for (const rotationStep of advertisedRotationSteps(render.rotations)) {
    for (let gridX = 0; gridX < KIT_GRID_SIZE; gridX++) {
      for (let gridY = 0; gridY < KIT_GRID_SIZE; gridY++) {
        const req: PlacementRequest = { pieceKey, gridX, gridY, rotationStep, stackLevel: 1 };
        if (evaluatePlacement(req, ctx).ok) results.push(req);
      }
    }
  }
  return results;
}

/** Legal ground anchors for one specific rotation step. Used by the G-H gate. */
export function legalAnchors(
  pieceKey: KitPieceKey,
  tier: LandTier,
  structureLevel: number,
  rotationStep: number,
): number {
  return legalPlacements(pieceKey, tier, structureLevel).filter(
    (placement) => placement.rotationStep === rotationStep,
  ).length;
}

/** Tallest support surface in the catalog — the grandfather fallback lift. */
export const KIT_FALLBACK_STACK_SURFACE_WU = Object.values(KIT_PIECE_RENDER).reduce(
  (tallest, render) => Math.max(tallest, render.supportSurfaceYWu ?? 0),
  0,
);

/** A stored placement row, as both the render layer and the write path see it. */
export interface StoredPlacement {
  readonly pieceRef: string;
  readonly pieceKey: KitPieceKey;
  readonly gridX: number;
  readonly gridY: number;
  readonly rotationStep: number;
  readonly stackLevel: number;
}

export interface ResolvedPlacement {
  readonly row: StoredPlacement;
  readonly footprint: PlacedFootprint;
  /**
   * True when this row's Y could not be derived from a real supporter and the
   * fallback lift was used — a legacy stack whose supporter never existed or
   * has since been removed. Q5: render it, never delete it. The editor uses
   * this to offer the free move.
   */
  readonly unsupported: boolean;
}

/**
 * Resolve every stored row on one parcel to a concrete footprint, lowest stack
 * level first so a supporter is always resolved before what rests on it.
 *
 * GRANDFATHERING IS THE POINT (Q5). This never refuses and never drops a row:
 * a placement the current predicate would reject still gets a footprint, and a
 * stacked row with no valid supporter is lifted by
 * `KIT_FALLBACK_STACK_SURFACE_WU` per level so it renders visibly floating
 * rather than vanishing or being silently re-grounded. Removing a supporter
 * leaves the piece above it floating, deliberately: the alternative is a
 * cascade that relocates or deletes paid rows.
 */
export function resolveParcelPlacements(
  rows: readonly StoredPlacement[],
  parcelTier: LandTier,
): readonly ResolvedPlacement[] {
  const ordered = [...rows].sort((a, b) => a.stackLevel - b.stackLevel);
  const resolved: ResolvedPlacement[] = [];
  const footprints: PlacedFootprint[] = [];

  for (const row of ordered) {
    const supported = resolveFootprint(row, parcelTier, footprints, row.pieceRef);
    if (supported) {
      footprints.push(supported);
      resolved.push({ row, footprint: supported, unsupported: false });
      continue;
    }

    // Either the piece key is unknown / off-grid (nothing to draw), or it is a
    // stacked row with no supporter. Distinguish by retrying at ground level.
    const grounded = resolveFootprint(
      { ...row, stackLevel: 1 },
      parcelTier,
      [],
      row.pieceRef,
    );
    if (!grounded) continue;

    const lift = (row.stackLevel - 1) * KIT_FALLBACK_STACK_SURFACE_WU;
    const floating: PlacedFootprint = {
      ...grounded,
      stackLevel: row.stackLevel,
      minY: grounded.minY + lift,
      maxY: grounded.maxY + lift,
      supportSurfaceY:
        grounded.supportSurfaceY === null ? null : grounded.supportSurfaceY + lift,
    };
    footprints.push(floating);
    resolved.push({ row, footprint: floating, unsupported: true });
  }

  return resolved;
}
