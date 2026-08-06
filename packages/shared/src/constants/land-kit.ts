/**
 * Land kit-piece backend contract (P3 stage A).
 *
 * This catalog is deliberately render-agnostic: stage B owns the mapping from
 * a stable `piece_key` to authored assets and fixed render chunks.
 */

export const KIT_PIECE_SIZES = ['small', 'large'] as const;
export type KitPieceSize = (typeof KIT_PIECE_SIZES)[number];

export const KIT_PIECE_CATEGORIES = [
  'fences',
  'decking',
  'planters',
  'lighting',
  'arches',
  'seating',
  'paths',
  'statues',
  'banners',
] as const;
export type KitPieceCategory = (typeof KIT_PIECE_CATEGORIES)[number];

export interface KitCatalogEntry {
  readonly size: KitPieceSize;
  readonly category: KitPieceCategory;
  readonly displayName: string;
}

/** Stable server-owned piece definitions. Never add asset paths here. */
export const KIT_CATALOG = {
  'fence-picket': { size: 'small', category: 'fences', displayName: 'Picket Fence' },
  'fence-rope': { size: 'small', category: 'fences', displayName: 'Rope Fence' },
  'deck-plank': { size: 'small', category: 'decking', displayName: 'Plank Deck' },
  'planter-box': { size: 'small', category: 'planters', displayName: 'Planter Box' },
  'planter-coral': { size: 'small', category: 'planters', displayName: 'Coral Planter' },
  'lantern-post': { size: 'small', category: 'lighting', displayName: 'Lantern Post' },
  'arch-driftwood': { size: 'large', category: 'arches', displayName: 'Driftwood Arch' },
  'bench-wood': { size: 'small', category: 'seating', displayName: 'Wood Bench' },
  'path-stone': { size: 'small', category: 'paths', displayName: 'Stone Path' },
  'statue-anchor': { size: 'large', category: 'statues', displayName: 'Anchor Statue' },
  'statue-shell': { size: 'large', category: 'statues', displayName: 'Shell Statue' },
  'banner-pole': { size: 'small', category: 'banners', displayName: 'Banner Pole' },
} as const satisfies Record<string, KitCatalogEntry>;

export type KitPieceKey = keyof typeof KIT_CATALOG;
export const KIT_PIECE_KEYS = Object.freeze(Object.keys(KIT_CATALOG) as KitPieceKey[]);

export type KitStructureLevel = 1 | 2 | 3 | 4 | 5;

export interface KitLevelRule {
  readonly smallPieceCap: number;
  readonly largePieceCap: number;
  readonly maxStackHeight: number;
  readonly rotationDegrees: 45 | 90;
}

/** Authoritative §2.2 ladder. */
export const KIT_LEVEL_RULES: Readonly<Record<KitStructureLevel, KitLevelRule>> = {
  1: { smallPieceCap: 6, largePieceCap: 0, maxStackHeight: 1, rotationDegrees: 90 },
  2: { smallPieceCap: 16, largePieceCap: 0, maxStackHeight: 2, rotationDegrees: 90 },
  3: { smallPieceCap: 28, largePieceCap: 2, maxStackHeight: 2, rotationDegrees: 45 },
  4: { smallPieceCap: 38, largePieceCap: 3, maxStackHeight: 3, rotationDegrees: 45 },
  5: { smallPieceCap: 48, largePieceCap: 4, maxStackHeight: 3, rotationDegrees: 45 },
};

/** D5 placement fees, in whole vCLAW/CT units. Moving and removal are free. */
export const KIT_PIECE_FEE_CT: Readonly<Record<KitPieceSize, number>> = {
  small: 15,
  large: 60,
};

export const KIT_GRID_SIZE = 16;
export const KIT_SHELL_RESERVED_MIN = 3;
export const KIT_SHELL_RESERVED_MAX = 12;

function kitRule(level: number): KitLevelRule | null {
  if (!Number.isInteger(level) || level < 1 || level > 5) return null;
  return KIT_LEVEL_RULES[level as KitStructureLevel];
}

/** True when adding one piece of `pieceSize` would remain inside the level cap. */
export function isPiecePlacementAllowed(
  level: number,
  currentSmall: number,
  currentLarge: number,
  pieceSize: KitPieceSize,
): boolean {
  const rule = kitRule(level);
  if (
    !rule
    || !Number.isInteger(currentSmall)
    || currentSmall < 0
    || !Number.isInteger(currentLarge)
    || currentLarge < 0
  ) {
    return false;
  }
  return pieceSize === 'small'
    ? currentSmall < rule.smallPieceCap
    : currentLarge < rule.largePieceCap;
}

/** `rotationStep` is an integer 0..7 in 45° units; Lv1-2 accept even steps only. */
export function isRotationAllowed(level: number, rotationStep: number): boolean {
  const rule = kitRule(level);
  if (!rule || !Number.isInteger(rotationStep) || rotationStep < 0 || rotationStep > 7) {
    return false;
  }
  return rule.rotationDegrees === 45 || rotationStep % 2 === 0;
}

/** True only for a 16×16 yard cell outside the center 10×10 shell reservation. */
export function isCellPlaceable(gridX: number, gridY: number): boolean {
  if (
    !Number.isInteger(gridX)
    || !Number.isInteger(gridY)
    || gridX < 0
    || gridX >= KIT_GRID_SIZE
    || gridY < 0
    || gridY >= KIT_GRID_SIZE
  ) {
    return false;
  }
  const insideReservedShell =
    gridX >= KIT_SHELL_RESERVED_MIN
    && gridX <= KIT_SHELL_RESERVED_MAX
    && gridY >= KIT_SHELL_RESERVED_MIN
    && gridY <= KIT_SHELL_RESERVED_MAX;
  return !insideReservedShell;
}
