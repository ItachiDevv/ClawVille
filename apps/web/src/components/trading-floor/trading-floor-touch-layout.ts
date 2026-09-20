/**
 * trading-floor-touch-layout.ts
 *
 * The Trading Floor touch HUD's geometry, as numbers AND as the CSS built from
 * those same numbers.
 *
 * Why this is a module and not inline styles: the layout depends on
 * `env(safe-area-inset-bottom)`, which **Playwright does not implement**. A
 * viewport sweep therefore always measures the zero-inset case and can never
 * catch a collision that only appears on a real notched phone. Codex found
 * exactly that (2026-09-19, round 2): at 844 × 390 with a 34 px home-indicator
 * inset the joystick band's top rose to 76 px while the clamped USE button
 * occupied 8..84, an 8 px overlap that eight green browser viewports had no way
 * of reporting.
 *
 * So the arithmetic lives here, `resolveTradingFloorTouchLayout` mirrors what
 * the CSS resolves to, and a unit test sweeps the inset values the browser
 * cannot produce.
 *
 * KEEP THE TWO IN STEP. Every number below feeds both the exported CSS strings
 * and the resolver; if you add a term to one, add it to the other and extend
 * `trading-floor-touch-layout.test.ts`.
 */

export const TOUCH_LAYOUT = Object.freeze({
  /** Band sits this far above the safe-area inset... */
  bandSafeAreaPad: 60,
  /** ...but never closer than this to the viewport bottom. */
  bandBottomMin: 80,
  /** Full-height band on a roomy viewport. */
  bandHeightMax: 220,
  /**
   * Floor for the band. nipplejs places the 120 px nipple centred at
   * `bottom: 80`, so it spans 20..140 inside the zone — 160 keeps it contained
   * with room to spare, and is what buys the USE button its clearance on a
   * short landscape viewport.
   */
  bandHeightMin: 160,
  /**
   * Height the band gives back to the rest of the screen before it starts
   * shrinking: USE (76) + its top margin (8) + the gap (12) + headroom.
   */
  bandHeightViewportReserve: 230,
  useSize: 76,
  /** The USE button's top never comes closer than this to the viewport top. */
  useMinTop: 8,
  /** Gap between the USE button's bottom and the band's top on a tall screen. */
  useGap: 12,
  /** The clearance the layout must always preserve between USE and the band. */
  minClearance: 8,
  /** nipplejs nipple extent inside a zone, measured from the zone bottom. */
  nippleTopWithinZone: 140,
});

/**
 * `100dvh`, never `100vh`: `vh` ignores mobile Safari's collapsing URL bar and
 * would under-clamp exactly where the viewport is shortest.
 */
export const BAND_BOTTOM_CSS =
  `max(calc(env(safe-area-inset-bottom, 0px) + ${TOUCH_LAYOUT.bandSafeAreaPad}px), ${TOUCH_LAYOUT.bandBottomMin}px)`;

export const BAND_HEIGHT_CSS =
  `max(${TOUCH_LAYOUT.bandHeightMin}px, min(${TOUCH_LAYOUT.bandHeightMax}px, calc(100dvh - ${TOUCH_LAYOUT.bandHeightViewportReserve}px)))`;

export const USE_BUTTON_BOTTOM_CSS =
  `min(calc(100dvh - ${TOUCH_LAYOUT.useSize + TOUCH_LAYOUT.useMinTop}px), calc(${BAND_BOTTOM_CSS} + ${BAND_HEIGHT_CSS} + ${TOUCH_LAYOUT.useGap}px))`;

export interface TradingFloorTouchLayout {
  /** CSS `bottom` of the joystick band, in px. */
  readonly bandBottom: number;
  readonly bandHeight: number;
  /** Distance from the VIEWPORT TOP to the band's top edge. */
  readonly bandTop: number;
  /** CSS `bottom` of the USE button, in px. */
  readonly useBottomCss: number;
  /** Distance from the viewport top to the button's top / bottom edge. */
  readonly useTop: number;
  readonly useBottom: number;
  /** Vertical gap between the button's bottom edge and the band's top edge. */
  readonly clearance: number;
}

/**
 * What the CSS above resolves to at a given viewport height and safe-area
 * inset. Pure — this is the seam the unit test drives.
 */
export function resolveTradingFloorTouchLayout(
  viewportHeight: number,
  safeAreaBottom: number,
): TradingFloorTouchLayout {
  const bandBottom = Math.max(
    safeAreaBottom + TOUCH_LAYOUT.bandSafeAreaPad,
    TOUCH_LAYOUT.bandBottomMin,
  );
  const bandHeight = Math.max(
    TOUCH_LAYOUT.bandHeightMin,
    Math.min(
      TOUCH_LAYOUT.bandHeightMax,
      viewportHeight - TOUCH_LAYOUT.bandHeightViewportReserve,
    ),
  );
  const bandTop = viewportHeight - bandBottom - bandHeight;
  const useBottomCss = Math.min(
    viewportHeight - (TOUCH_LAYOUT.useSize + TOUCH_LAYOUT.useMinTop),
    bandBottom + bandHeight + TOUCH_LAYOUT.useGap,
  );
  const useTop = viewportHeight - useBottomCss - TOUCH_LAYOUT.useSize;
  const useBottom = useTop + TOUCH_LAYOUT.useSize;
  return {
    bandBottom,
    bandHeight,
    bandTop,
    useBottomCss,
    useTop,
    useBottom,
    clearance: bandTop - useBottom,
  };
}
