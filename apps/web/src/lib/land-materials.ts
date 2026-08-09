import type { KitPieceSize } from '@clawville/shared';

/**
 * Materials-rail piece fee, client-owned pricing DISPLAY ONLY (P5b render
 * lane, 2026-08-09). Mirrors gamification-pass-2026-08-09.md §3.3: "Small =
 * 8 materials, large = 30." The server is ALWAYS authoritative for what is
 * actually charged — same caveat `kitPieceFeeCt` carries for the vCLAW rail
 * — this exists only so the yard editor can show a price before the player
 * commits. If/when a shared `kitPieceMaterialFee()` helper lands in
 * `@clawville/shared` (this lane cannot add it — outside the file boundary),
 * delete this file and import that instead.
 */
export const LAND_MATERIAL_PIECE_FEE: Readonly<Record<KitPieceSize, number>> = {
  small: 8,
  large: 30,
};
