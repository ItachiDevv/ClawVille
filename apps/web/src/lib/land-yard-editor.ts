import { ApiError } from "@/lib/api";
import type { LandStructurePieceDTO } from "@/components/game/land/types";
import type { PlacedPiece } from "@/stores/land";

const ERROR_COPY: Readonly<Record<string, string>> = {
  cell_reserved: "That spot is under your building.",
  cell_occupied: "Something's already there — stack or pick another spot.",
  stack_support_required: "Needs a piece underneath first.",
  piece_cap_reached: "Piece limit reached for your building level.",
  insufficient_clawtokens: "Not enough vCLAW.",
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

/** Add the render join key to the private owner DTOs returned for one parcel. */
export function ownerPiecesToPlacedPieces(
  parcelCode: string,
  pieces: readonly LandStructurePieceDTO[],
): PlacedPiece[] {
  return pieces.map((piece) => ({ ...piece, parcelCode }));
}
