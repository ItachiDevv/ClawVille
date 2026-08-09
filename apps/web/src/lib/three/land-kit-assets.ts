import {
  KIT_GRID_SIZE,
  KIT_PIECE_KEYS,
  KIT_PIECE_RENDER,
  kitCellCentreWu,
  type KitPieceKey,
  type ParcelSlot,
} from '@clawville/shared';

/** Web-owned asset paths; the shared kit catalog intentionally stays render-agnostic. */
export const LAND_KIT_ASSET_PATHS = Object.freeze(
  Object.fromEntries(
    KIT_PIECE_KEYS.map((pieceKey) => [pieceKey, `/models/land-kit/${pieceKey}.glb`]),
  ) as Record<KitPieceKey, string>,
);

/** Sand floor shared by the parcel and structure render layers. */
export const KIT_FLOOR_Y = -2;

/** One 16x16 kit-grid cell in world units. */
export function KIT_CELL(parcelSize: number): number {
  return parcelSize / KIT_GRID_SIZE;
}

export interface KitGridPlacement {
  gridX: number;
  gridY: number;
  rotationStep: number;
  stackLevel: number;
}

export interface KitWorldTransform {
  cell: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  yaw: number;
}

export interface KitGridCell {
  gridX: number;
  gridY: number;
}

/**
 * Convert one server-owned grid placement to its parcel-world transform.
 *
 * `baseYWu` is the parcel-local height the piece's BASE rests at, resolved by
 * `resolveParcelPlacements()` in `@clawville/shared` from the supporting
 * piece's own manifest support surface. It is a REQUIRED argument on purpose:
 * this used to be `KIT_FLOOR_Y + (stackLevel − 1) × 34`, a fixed 34 wu ladder
 * against pieces that render 8–292 wu tall, which put two stacked lanterns
 * 216 wu inside each other (defect N-3). There is no sane default, so callers
 * must resolve a real support height.
 */
export function kitGridToWorld(
  parcel: Pick<ParcelSlot, 'cx' | 'cz' | 'size'>,
  placement: KitGridPlacement,
  baseYWu: number,
): KitWorldTransform {
  return {
    cell: KIT_CELL(parcel.size),
    worldX: parcel.cx + kitCellCentreWu(placement.gridX, parcel.size),
    worldY: KIT_FLOOR_Y + baseYWu,
    worldZ: parcel.cz + kitCellCentreWu(placement.gridY, parcel.size),
    yaw: (placement.rotationStep * Math.PI) / 4,
  };
}

/** Inverse of `kitGridToWorld` for pointer hits on a parcel ground plane. */
export function kitWorldToGrid(
  parcel: Pick<ParcelSlot, 'cx' | 'cz' | 'size'>,
  worldX: number,
  worldZ: number,
): KitGridCell | null {
  const cell = KIT_CELL(parcel.size);
  const gridX = Math.floor((worldX - (parcel.cx - parcel.size / 2)) / cell);
  const gridY = Math.floor((worldZ - (parcel.cz - parcel.size / 2)) / cell);
  if (
    gridX < 0
    || gridX >= KIT_GRID_SIZE
    || gridY < 0
    || gridY >= KIT_GRID_SIZE
  ) {
    return null;
  }
  return { gridX, gridY };
}

export interface KitPieceBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface KitPieceFit {
  /** Uniform scale that renders the piece at its manifest `targetHeightWu`. */
  scale: number;
  /** Local-space offsets that center XZ and ground bbox min-Y at worldY. */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

/**
 * Scale an authored piece to its FROZEN MANIFEST HEIGHT.
 *
 * This replaces `fitKitPieceToCell`, which normalized every piece to the same
 * cell-relative cube — 0.92 of a cell wide for small, 1.9 cells for large. That
 * made price and geometry disagree (a 60-vCLAW `statue-anchor` rendered 56.3 wu
 * wide against a 15-vCLAW `fence-picket` at 62.6 wu, defect N-1) and squashed
 * seven of twelve pieces to 0.19× a 270 wu avatar or less (defect N-2). It was
 * also parcel-size dependent, so the same piece changed size between tiers.
 *
 * The scale is derived from the RUNTIME bbox rather than the manifest's stored
 * `sourceExtent`, so the drawn height is exactly `targetHeightWu` even if an
 * asset is re-exported; `scripts/land-kit/verify-manifest.mjs` is what catches
 * the resulting extent drift against the placement predicate.
 */
export function fitKitPieceToManifest(
  pieceKey: KitPieceKey,
  bounds: KitPieceBounds,
): KitPieceFit {
  const render = KIT_PIECE_RENDER[pieceKey];
  const height = Math.max(0, bounds.maxY - bounds.minY);
  return {
    scale: height > 1e-6 ? render.targetHeightWu / height : 1,
    offsetX: -(bounds.minX + bounds.maxX) * 0.5,
    offsetY: -bounds.minY,
    offsetZ: -(bounds.minZ + bounds.maxZ) * 0.5,
  };
}
