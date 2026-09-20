import { describe, expect, test } from 'bun:test';
import {
  BAND_BOTTOM_CSS,
  BAND_HEIGHT_CSS,
  resolveTradingFloorTouchLayout,
  TOUCH_LAYOUT,
  USE_BUTTON_BOTTOM_CSS,
} from './trading-floor-touch-layout';

/**
 * These cases exist because the browser sweep CANNOT reach them: Playwright
 * does not implement `env(safe-area-inset-*)`, so eight green viewports only
 * ever prove the zero-inset column.
 *
 * Two real defects have now come out of this one button, both found by
 * arithmetic rather than by a screenshot:
 *   1. a fixed `bottom: 332px` put its top at -18 px at 844 x 390;
 *   2. the first fix cleared the viewport but, with a 34 px home-indicator
 *      inset, overlapped the camera joystick zone by 8 px.
 */

/**
 * Phone landscape is the tight case. 375 is iPhone SE landscape, the SHORTEST
 * viewport any shipping device presents and the one nearest the floor below.
 * The rest are the browser sweep's eight viewports.
 */
const VIEWPORT_HEIGHTS = [375, 390, 744, 820, 844, 1024, 1133, 1180, 1366];
/** 0 = no notch. 34 = iPhone home indicator. 44 = the tallest inset shipping. */
const SAFE_AREAS = [0, 34, 44];

describe('Trading Floor touch layout', () => {
  test.each(VIEWPORT_HEIGHTS.flatMap((h) => SAFE_AREAS.map((s) => [h, s] as const)))(
    'height %i with a %i px safe area keeps USE on screen and clear of the band',
    (height, safeArea) => {
      const layout = resolveTradingFloorTouchLayout(height, safeArea);
      // On screen at the top...
      expect(layout.useTop).toBeGreaterThanOrEqual(TOUCH_LAYOUT.useMinTop);
      // ...and clear of the joystick band below it.
      expect(layout.useBottom + TOUCH_LAYOUT.minClearance).toBeLessThanOrEqual(
        layout.bandTop,
      );
      expect(layout.clearance).toBeGreaterThanOrEqual(TOUCH_LAYOUT.minClearance);
      // The whole band is on screen too.
      expect(layout.bandTop).toBeGreaterThanOrEqual(0);
      expect(layout.bandBottom).toBeGreaterThanOrEqual(0);
    },
  );

  test.each(VIEWPORT_HEIGHTS.flatMap((h) => SAFE_AREAS.map((s) => [h, s] as const)))(
    'height %i with a %i px safe area still contains the nipple',
    (height, safeArea) => {
      const { bandHeight } = resolveTradingFloorTouchLayout(height, safeArea);
      // nipplejs centres a 120 px nipple at bottom 80, so it reaches 140.
      expect(bandHeight).toBeGreaterThanOrEqual(TOUCH_LAYOUT.nippleTopWithinZone);
    },
  );

  // The exact case Codex called: the previous layout overlapped here by 8 px.
  test('844x390 with a 34 px home indicator has real clearance, not an overlap', () => {
    const layout = resolveTradingFloorTouchLayout(390, 34);
    expect(layout.bandBottom).toBe(94);
    expect(layout.bandHeight).toBe(160);
    expect(layout.bandTop).toBe(136);
    // Shrinking the band moves its top DOWN far enough that the button's
    // band-relative position (94 + 160 + 12 = 266) already clears the viewport
    // top on its own — the dvh clamp does not even bind here.
    expect(layout.useBottomCss).toBe(266);
    expect(layout.useTop).toBe(48);
    expect(layout.useBottom).toBe(124);
    expect(layout.clearance).toBe(TOUCH_LAYOUT.useGap);
  });

  // Band-relative placement is now the load-bearing term and the dvh clamp is
  // insurance. Keep that branch covered so it cannot rot unnoticed.
  test('the dvh clamp still catches a pathologically short viewport', () => {
    const layout = resolveTradingFloorTouchLayout(300, 44);
    expect(layout.useBottomCss).toBe(300 - (TOUCH_LAYOUT.useSize + TOUCH_LAYOUT.useMinTop));
    expect(layout.useTop).toBe(TOUCH_LAYOUT.useMinTop);
    // HONEST LIMIT: at 300 px there is no arrangement that fits a 160 px band
    // (the nipple floor), a 76 px button and two 8 px margins above a 104 px
    // inset — 348 px of demand in 300 px of screen. The clamp keeps the button
    // reachable and the band loses the argument. See SUPPORTED_MIN_HEIGHT.
    expect(layout.clearance).toBeLessThan(TOUCH_LAYOUT.minClearance);
  });

  /**
   * Worst case is the largest inset (44). Below this height the demand
   * (inset 44 + pad 60 + band 160 + gap 8 + button 76 + top margin 8) exceeds
   * the viewport and something must give. 356 sits 19 px below iPhone SE
   * landscape, the shortest shipping viewport, so no real device reaches it.
   */
  const SUPPORTED_MIN_HEIGHT = 356;

  test('the documented floor is genuinely the floor', () => {
    const atFloor = resolveTradingFloorTouchLayout(SUPPORTED_MIN_HEIGHT, 44);
    expect(atFloor.clearance).toBeGreaterThanOrEqual(TOUCH_LAYOUT.minClearance);
    expect(atFloor.useTop).toBeGreaterThanOrEqual(TOUCH_LAYOUT.useMinTop);
    // ...and one pixel below it the guarantee lapses, which is why the number
    // is written down rather than assumed.
    expect(
      resolveTradingFloorTouchLayout(SUPPORTED_MIN_HEIGHT - 1, 44).clearance,
    ).toBeLessThan(TOUCH_LAYOUT.minClearance);
  });

  test('every shipping landscape viewport clears the floor', () => {
    // iPhone SE is the shortest; everything the sweep drives is taller.
    expect(Math.min(...VIEWPORT_HEIGHTS)).toBeGreaterThan(SUPPORTED_MIN_HEIGHT);
  });

  test('a tall viewport is untouched: full 220 px band, gap is the authored 12', () => {
    const layout = resolveTradingFloorTouchLayout(844, 0);
    expect(layout.bandHeight).toBe(TOUCH_LAYOUT.bandHeightMax);
    expect(layout.clearance).toBe(TOUCH_LAYOUT.useGap);
    expect(layout.useTop).toBe(456);
    expect(layout.useBottom).toBe(532);
  });

  test('the band only shrinks when the viewport actually demands it', () => {
    expect(resolveTradingFloorTouchLayout(1366, 44).bandHeight).toBe(
      TOUCH_LAYOUT.bandHeightMax,
    );
    expect(resolveTradingFloorTouchLayout(390, 0).bandHeight).toBe(
      TOUCH_LAYOUT.bandHeightMin,
    );
  });

  // The resolver mirrors CSS the test cannot execute. If a term is added to one
  // and not the other the numbers above go quietly stale, so pin that every
  // constant the resolver uses also appears in the emitted CSS.
  describe('CSS and resolver are built from the same constants', () => {
    test('band bottom CSS carries the pad and the floor', () => {
      expect(BAND_BOTTOM_CSS).toContain(`${TOUCH_LAYOUT.bandSafeAreaPad}px`);
      expect(BAND_BOTTOM_CSS).toContain(`${TOUCH_LAYOUT.bandBottomMin}px`);
      expect(BAND_BOTTOM_CSS).toContain('env(safe-area-inset-bottom, 0px)');
    });

    test('band height CSS carries both bounds and the reserve', () => {
      expect(BAND_HEIGHT_CSS).toContain(`${TOUCH_LAYOUT.bandHeightMin}px`);
      expect(BAND_HEIGHT_CSS).toContain(`${TOUCH_LAYOUT.bandHeightMax}px`);
      expect(BAND_HEIGHT_CSS).toContain(
        `100dvh - ${TOUCH_LAYOUT.bandHeightViewportReserve}px`,
      );
    });

    test('USE bottom CSS clamps against dvh, never vh', () => {
      expect(USE_BUTTON_BOTTOM_CSS).toContain(
        `100dvh - ${TOUCH_LAYOUT.useSize + TOUCH_LAYOUT.useMinTop}px`,
      );
      expect(USE_BUTTON_BOTTOM_CSS).toContain(`${TOUCH_LAYOUT.useGap}px`);
      // `vh` ignores mobile Safari's collapsing URL bar and under-clamps.
      expect(USE_BUTTON_BOTTOM_CSS).not.toMatch(/[^d]vh/);
    });
  });
});
