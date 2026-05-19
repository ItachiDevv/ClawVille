/**
 * Slot Symbol Manifest — Phase 6.0.4 polish
 *
 * Maps each `SymbolId` (defined in slot-paytables.ts) to a vector-art
 * SVG path. A parallel asset task generates the SVGs into
 * `apps/web/public/assets/slot-symbols/`. Until each SVG lands, the
 * `<img>` will fail with `onError` and the component falls back to the
 * emoji from `CLASSIC_SYMBOLS`. No 404 surfaces to the user.
 *
 * Filenames are stable: `s0.svg` … `s7.svg`. Reusing index keeps the
 * manifest hard-linked to the paytable's symbol ordering — a swap in
 * `slot-paytables.ts` is a one-line edit here, not a file rename.
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
 * Order MUST match `CLASSIC_SYMBOLS` in slot-paytables.ts. The display
 * name here OVERRIDES the legacy fruit name (Cherry, Lemon, …) so the
 * UI uses ClawVille-flavoured icons (sea-twisted classic Vegas symbols)
 * while the SpinResult contract stays untouched.
 *
 * SVG art was redesigned in commit f1946fb (2026-05-18) from flat neon
 * icons → chunky bevel-cast classic-slot symbols with sea twist:
 * cherries → anemones, lemon → starfish, orange → pufferfish,
 * plum → urchin, watermelon → clam, bell → diving-helmet, 7 → coral 7.
 */
export const CLASSIC_SLOT_SYMBOL_ASSETS: SlotSymbolAsset[] = [
  { id: 0, svgPath: '/assets/slot-symbols/s0.svg', displayName: 'Kelp',           themeColor: '#5cffae' },
  { id: 1, svgPath: '/assets/slot-symbols/s1.svg', displayName: 'Anemones',       themeColor: '#d62828' },
  { id: 2, svgPath: '/assets/slot-symbols/s2.svg', displayName: 'Starfish',       themeColor: '#ffc857' },
  { id: 3, svgPath: '/assets/slot-symbols/s3.svg', displayName: 'Pufferfish',     themeColor: '#ff8c42' },
  { id: 4, svgPath: '/assets/slot-symbols/s4.svg', displayName: 'Sea Urchin',     themeColor: '#7a3aff' },
  { id: 5, svgPath: '/assets/slot-symbols/s5.svg', displayName: 'Giant Clam',     themeColor: '#6cb98a' },
  { id: 6, svgPath: '/assets/slot-symbols/s6.svg', displayName: 'Diving Helmet',  themeColor: '#ffd778' },
  { id: 7, svgPath: '/assets/slot-symbols/s7.svg', displayName: 'Coral 7',        themeColor: '#ff3838' },
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
