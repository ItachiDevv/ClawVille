/**
 * Slot Symbol Manifest — Phase 6.0.4 polish, third-pass redesign (2026-05-19)
 *
 * Maps each `SymbolId` (defined in slot-paytables.ts) to a vector-art
 * SVG path. A parallel asset task generates the SVGs into
 * `apps/web/public/assets/slot-symbols/`. Until each SVG lands, the
 * `<img>` will fail with `onError` and the component falls back to the
 * emoji from `CLASSIC_SYMBOLS`. No 404 surfaces to the user.
 *
 * Filenames are stable: `s0.svg` … `s9.svg`. Reusing index keeps the
 * manifest hard-linked to the paytable's symbol ordering — a swap in
 * `slot-paytables.ts` is a one-line edit here, not a file rename.
 *
 * THIRD-PASS redesign (2026-05-19): 10-symbol classic Vegas paytable
 * with 3-tier BAR. Modern 5-reel convention — each BAR tier evaluates
 * INDEPENDENTLY (BAR, BAR×2, BAR×3 are three distinct kinds; no
 * mixed-tier "any BAR" rule — that was old mechanical 3-reel behavior).
 *
 *   id 0 → Cherry     (was Pearl; reuses s1 "Anemones" art — user-approved as cherries)
 *   id 1 → Lemon      (new art; classic Vegas yellow citrus)
 *   id 2 → Orange     (was Starfish; reuses s3 "Pufferfish" art — user-approved as orange)
 *   id 3 → Plum       (new art; classic Vegas purple plum)
 *   id 4 → Bell       (unchanged from pass-2; classic Vegas brass bell)
 *   id 5 → BAR        (unchanged from pass-2; red+gold plaque, tier 1)
 *   id 6 → Seven      (unchanged from pass-2; Coral 7)
 *   id 7 → WILD       (unchanged from pass-2; cyan plaque + shark + "WILD")
 *   id 8 → BAR×2      (new art; two BAR plaques stacked, tier 2)
 *   id 9 → BAR×3      (new art; three BAR plaques stacked, tier 3)
 *
 * Rationale: ordering now mirrors classic Vegas (Cherry, Lemon, Orange,
 * Plum, Bell, BAR, 7, WILD) with BAR×2/×3 added as independently-paying
 * top tiers. Payouts for ids 0-7 are unchanged from pass-2 — only the
 * NAME of id 0/2 swaps (Anemones→Cherry, Pufferfish→Orange) so the art
 * matches the Vegas-canonical reading the user explicitly approved.
 */

import type { SlotSymbolDef } from './slot-paytables';

export interface SlotSymbolAsset {
  /** Symbol id (matches `SlotSymbolDef.id`). */
  id: number;
  /** Public URL of the SVG. */
  svgPath: string;
  /** Display name (mirrors `SlotSymbolDef.name`; duplicated for export ergonomics). */
  displayName: string;
  /** Theme color reused for cell glow + win ring. */
  themeColor: string;
}

/**
 * Stable indexing — entry `[i]` is the asset for `SymbolId === i`.
 * Order MUST match `CLASSIC_SYMBOLS` in slot-paytables.ts.
 */
export const CLASSIC_SLOT_SYMBOL_ASSETS: SlotSymbolAsset[] = [
  { id: 0,  svgPath: '/assets/slot-symbols/s0.svg',  displayName: 'Cherry',  themeColor: '#d62828' },
  { id: 1,  svgPath: '/assets/slot-symbols/s1.svg',  displayName: 'Lemon',   themeColor: '#f1c40f' },
  { id: 2,  svgPath: '/assets/slot-symbols/s2.svg',  displayName: 'Orange',  themeColor: '#ff8c42' },
  { id: 3,  svgPath: '/assets/slot-symbols/s3.svg',  displayName: 'Plum',    themeColor: '#7c3aed' },
  { id: 4,  svgPath: '/assets/slot-symbols/s4.svg',  displayName: 'Bell',    themeColor: '#ffc857' },
  { id: 5,  svgPath: '/assets/slot-symbols/s5.svg',  displayName: 'BAR',     themeColor: '#d62828' },
  { id: 6,  svgPath: '/assets/slot-symbols/s6.svg',  displayName: 'Seven',   themeColor: '#ff3838' },
  { id: 7,  svgPath: '/assets/slot-symbols/s7.svg',  displayName: 'WILD',    themeColor: '#00d4ff' },
  { id: 8,  svgPath: '/assets/slot-symbols/s8.svg',  displayName: 'BAR×2',   themeColor: '#c0223a' },
  { id: 9,  svgPath: '/assets/slot-symbols/s9.svg',  displayName: 'BAR×3',   themeColor: '#a01828' },
  // Phase 6.1.5 — Bundle B scatter (Treasure Chest). NOT a wild.
  // Pays anywhere (no payline restriction); 3/4/5 anywhere triggers
  // 2×/10×/50× total predict + 10 free spins (capped retrigger at 50).
  { id: 10, svgPath: '/assets/slot-symbols/s10.svg', displayName: 'Scatter', themeColor: '#ffd778' },
];

/**
 * Helper: get asset by id with a defensive fallback to id 0.
 * Components that handle a missing asset gracefully should still call
 * this — it removes the optional-chain dance at every call-site.
 */
export function getSlotSymbolAsset(id: number): SlotSymbolAsset {
  return CLASSIC_SLOT_SYMBOL_ASSETS[id] ?? CLASSIC_SLOT_SYMBOL_ASSETS[0];
}

/**
 * Convenience join of paytable def + asset metadata.
 * Lets the Paytable modal render a single row without two lookups.
 */
export function joinSymbolWithAsset<S extends Pick<SlotSymbolDef, 'id'>>(symbol: S): S & SlotSymbolAsset {
  return { ...symbol, ...getSlotSymbolAsset(symbol.id) };
}
