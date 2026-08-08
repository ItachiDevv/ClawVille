import {
  KIT_CATALOG,
  KIT_GRID_SIZE,
  type KitPieceKey,
  type ParcelSlot,
} from '@clawville/shared';

/** Web-owned asset paths; the shared kit catalog intentionally stays render-agnostic. */
export const LAND_KIT_ASSET_PATHS = Object.freeze(
  Object.fromEntries(
    (Object.keys(KIT_CATALOG) as KitPieceKey[]).map((pieceKey) => [
      pieceKey,
      `/models/land-kit/${pieceKey}.glb`,
    ]),
  ) as Record<KitPieceKey, string>,
);

/** Sand floor shared by the parcel and structure render layers. */
export const KIT_FLOOR_Y = -2;
export const KIT_STACK_UNIT_WU = 34;
export const KIT_SMALL_FOOTPRINT_FRACTION = 0.92;
export const KIT_LARGE_FOOTPRINT_FRACTION = 1.9;
export const KIT_HEIGHT_CAP_FRACTION = 2.2;

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

/** Convert one server-owned grid placement to its fixed parcel-world transform. */
export function kitGridToWorld(
  parcel: Pick<ParcelSlot, 'cx' | 'cz' | 'size'>,
  placement: KitGridPlacement,
): KitWorldTransform {
  const cell = KIT_CELL(parcel.size);
  return {
    cell,
    worldX: parcel.cx - parcel.size / 2 + (placement.gridX + 0.5) * cell,
    worldY: KIT_FLOOR_Y + (placement.stackLevel - 1) * KIT_STACK_UNIT_WU,
    worldZ: parcel.cz - parcel.size / 2 + (placement.gridY + 0.5) * cell,
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
  /** Uniform scale satisfying both the XZ footprint and independent height cap. */
  scale: number;
  /** Local-space offsets that center XZ and ground bbox min-Y at worldY. */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

/**
 * Normalize an authored piece for one parcel cell. Small pieces occupy 0.92 of
 * a cell, large pieces 1.9 cells, and either may shrink further to fit 2.2 cell
 * heights. The returned offsets center XZ and put bbox min-Y on the stack lift.
 */
export function fitKitPieceToCell(
  pieceKey: KitPieceKey,
  parcelSize: number,
  bounds: KitPieceBounds,
): KitPieceFit {
  const cell = KIT_CELL(parcelSize);
  const width = Math.max(0, bounds.maxX - bounds.minX);
  const height = Math.max(0, bounds.maxY - bounds.minY);
  const depth = Math.max(0, bounds.maxZ - bounds.minZ);
  const widestXZ = Math.max(width, depth);
  const footprintFraction =
    KIT_CATALOG[pieceKey].size === 'large'
      ? KIT_LARGE_FOOTPRINT_FRACTION
      : KIT_SMALL_FOOTPRINT_FRACTION;
  const footprintScale =
    widestXZ > 0.001 ? (cell * footprintFraction) / widestXZ : 1;
  const heightScale =
    height > 0.001
      ? (cell * KIT_HEIGHT_CAP_FRACTION) / height
      : Number.POSITIVE_INFINITY;

  return {
    scale: Math.min(footprintScale, heightScale),
    offsetX: -(bounds.minX + bounds.maxX) * 0.5,
    offsetY: -bounds.minY,
    offsetZ: -(bounds.minZ + bounds.maxZ) * 0.5,
  };
}
