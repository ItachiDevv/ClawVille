import {
  KIT_CATALOG,
  KIT_LEVEL_RULES,
  KIT_PIECE_KEYS,
  KIT_PIECE_RENDER,
  isKitPaymentRailAllowed,
  kitPieceFeeCt,
  kitPieceFeeMaterials,
  type KitPieceKey,
  type KitStructureLevel,
  type LandStructureType,
} from "@clawville/shared";
import { ApiError } from "@/lib/api";
import type { LandStructurePieceDTO } from "@/components/game/land/types";
import type { PlacedPiece } from "@/stores/land";

const ERROR_COPY: Readonly<Record<string, string>> = {
  cell_reserved: "That spot is under your building.",
  cell_occupied: "Something's already there — stack or pick another spot.",
  stack_support_required: "Needs a piece underneath first.",
  piece_cap_reached: "Piece limit reached for your building level.",
  insufficient_clawtokens: "Not enough vCLAW.",
  insufficient_materials: "Not enough materials.",
};

export function landPieceErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  return error.code ?? error.message ?? null;
}

export function isIdempotencyConflict(error: unknown): boolean {
  return landPieceErrorCode(error) === "idempotency_key_conflict";
}

export function landPieceErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 402)
    return "Not enough vCLAW.";
  const code = landPieceErrorCode(error);
  return (code && ERROR_COPY[code]) || "Couldn't place that — try again.";
}

export function freshLandPieceIdempotencyKey(): string {
  return crypto.randomUUID().slice(0, 32);
}

/* ------------------------------------------------------------------------ *
 * Stacking, explained to a player.
 *
 * Stacking has NO player input at all: `preferredStackLevel`
 * (lib/three/yard-editor-three.tsx) lifts the ghost to the highest legal level
 * on hover, so a player has no way to discover that it exists, that only two
 * pieces can be stacked ON, or that at Lv1 it cannot happen at all.
 *
 * Everything below is DERIVED from the shared constants. A cap or a support
 * surface that moves in `@clawville/shared` moves this copy with it, which is
 * the point: a hardcoded number here would be a lie shipped to a player.
 * ------------------------------------------------------------------------ */

/**
 * The ladder's levels, low to high — DERIVED from `KIT_LEVEL_RULES`, never a
 * typed list. A level added or removed in `@clawville/shared` moves every hint,
 * clamp and unlock sentence built on top of this with it.
 */
export const KIT_STRUCTURE_LEVELS: readonly KitStructureLevel[] = Object.freeze(
  Object.keys(KIT_LEVEL_RULES)
    .map((key) => Number(key) as KitStructureLevel)
    .sort((left, right) => left - right),
);

/** Lowest / highest level the shared ladder defines. */
export const KIT_MIN_STRUCTURE_LEVEL: KitStructureLevel =
  KIT_STRUCTURE_LEVELS[0]!;
export const KIT_MAX_STRUCTURE_LEVEL: KitStructureLevel =
  KIT_STRUCTURE_LEVELS[KIT_STRUCTURE_LEVELS.length - 1]!;

/**
 * Resolve a possibly-missing structure level to an ACTUAL member of the shared
 * ladder.
 *
 * A null is reachable in the brief window before the owner overlay hydrates —
 * the editor only opens on a parcel that already carries an ACTIVE structure.
 *
 * SELECTS, it does not range-clamp. The result is dereferenced as
 * `KIT_LEVEL_RULES[level]` by every caller, so a value merely inside the
 * min/max range is not good enough: the old `Math.min(max, Math.max(min,
 * round(level))) as KitStructureLevel` would happily return a rung the ladder
 * does not define the moment `KIT_LEVEL_RULES` stopped being contiguous, and
 * the cast made the compiler agree. Picking the nearest real member cannot.
 * Ties resolve DOWN (strict `<`), so a level between two rungs never grants
 * capacity the server has not.
 */
export function clampKitStructureLevel(
  level: number | null | undefined,
): KitStructureLevel {
  if (typeof level !== "number" || !Number.isFinite(level)) {
    return KIT_MIN_STRUCTURE_LEVEL;
  }
  let nearest: KitStructureLevel = KIT_MIN_STRUCTURE_LEVEL;
  let nearestDistance = Math.abs(level - nearest);
  // Ascending (see KIT_STRUCTURE_LEVELS), so `<` keeps the LOWER rung on a tie.
  for (const candidate of KIT_STRUCTURE_LEVELS) {
    const distance = Math.abs(level - candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * The pieces something may rest on: exactly the manifest entries carrying a
 * `supportSurfaceYWu`. Never a hand-written key list.
 */
export const STACK_BASE_PIECE_KEYS: readonly KitPieceKey[] = Object.freeze(
  KIT_PIECE_KEYS.filter(
    (pieceKey) => KIT_PIECE_RENDER[pieceKey].supportSurfaceYWu !== null,
  ),
);

/** True when another piece may rest on this one. */
export function isStackBasePiece(pieceKey: KitPieceKey): boolean {
  return KIT_PIECE_RENDER[pieceKey].supportSurfaceYWu !== null;
}

/**
 * The support pieces named in catalog order, e.g. "a Plank Deck or a Stone
 * Path". Empty string when nothing in the catalog can be stacked on.
 */
export function stackBasePiecePhrase(): string {
  const names = STACK_BASE_PIECE_KEYS.map(
    (pieceKey) => `a ${KIT_CATALOG[pieceKey].displayName}`,
  );
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]!}`;
}

/** The lowest level above `level` that allows a stack, or null if none does. */
export function firstStackingLevelAbove(
  level: KitStructureLevel,
): KitStructureLevel | null {
  for (const candidate of KIT_STRUCTURE_LEVELS) {
    if (candidate > level && KIT_LEVEL_RULES[candidate].maxStackHeight > 1) {
      return candidate;
    }
  }
  return null;
}

/**
 * The one or two sentences that explain stacking at `level`. Empty array when
 * the catalog has no stackable base at all.
 */
export function stackingHintLines(level: KitStructureLevel): string[] {
  const phrase = stackBasePiecePhrase();
  if (!phrase) return [];
  const lines = [
    `Pieces stack only on top of ${phrase}. When a stack is legal the preview lifts onto the piece below on its own.`,
  ];
  if (KIT_LEVEL_RULES[level].maxStackHeight <= 1) {
    const unlockLevel = firstStackingLevelAbove(level);
    lines.push(
      unlockLevel === null
        ? "Your building level does not allow stacking yet."
        : `Stacking unlocks when your building reaches Lv${unlockLevel}.`,
    );
  }
  return lines;
}

/** The reserved centre square, named. Sized at the tier's MAX building level. */
export const YARD_RESERVED_SHELL_HINT =
  "The dark square in the middle is your building's space. Pieces cannot go there.";

/**
 * What one piece costs in THIS yard, in plain words.
 *
 * DERIVED from the shared fee tables, never retyped: a home yard and a shop
 * yard are priced differently (`KIT_PIECE_FEE_CT_BY_STRUCTURE`), and only a
 * home yard may spend materials (`isKitPaymentRailAllowed`). Used before the
 * editor opens (the Land Office Decorate hint) and inside it (the primer), so a
 * player knows the price before they commit to walking over.
 */
export function yardPieceCostLine(structureType: LandStructureType): string {
  const smallCt = kitPieceFeeCt(structureType, "small");
  const largeCt = kitPieceFeeCt(structureType, "large");
  const vclaw = `Each small piece costs ${smallCt.toLocaleString()} vCLAW and each large piece ${largeCt.toLocaleString()} vCLAW.`;
  if (!isKitPaymentRailAllowed("materials", structureType)) return vclaw;
  return `${vclaw} You can pay with materials instead: ${kitPieceFeeMaterials("small").toLocaleString()} for a small piece, ${kitPieceFeeMaterials("large").toLocaleString()} for a large one.`;
}

/** Add the render join key to the private owner DTOs returned for one parcel. */
export function ownerPiecesToPlacedPieces(
  parcelCode: string,
  pieces: readonly LandStructurePieceDTO[],
): PlacedPiece[] {
  return pieces.map((piece) => ({ ...piece, parcelCode }));
}
