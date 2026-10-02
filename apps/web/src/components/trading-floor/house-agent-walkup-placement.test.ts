import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  HOUSE_AGENT_WALKUP_LAYOUT,
  createHouseAgentWalkupPlacement,
  houseAgentWalkupMoved,
  placeHouseAgentWalkup,
  type HouseAgentWalkupPlacementInput,
} from './house-agent-walkup-placement';
import { resolveTradingFloorTouchLayout, TOUCH_LAYOUT } from './trading-floor-touch-layout';

// P15 T5 (ops/house-traders/arena-review/P15_PLAN_2026-10-02.md §3 "Placement").
// The walk-up panel is a DOM element positioned every frame from a projected
// anchor. These cases pin the clamps the plan names: 16 px margins, the flip,
// top >= 72 (below "Back to World"), the bottom above the joystick band and
// clear of the USE button on touch, the off-screen dock and the phone card.

const L = HOUSE_AGENT_WALKUP_LAYOUT;

function input(overrides: Partial<HouseAgentWalkupPlacementInput>): HouseAgentWalkupPlacementInput {
  return {
    viewportWidth: 1366,
    viewportHeight: 768,
    anchorX: 400,
    anchorY: 380,
    anchorOnScreen: true,
    panelHeight: 300,
    touch: false,
    safeAreaBottom: 0,
    ...overrides,
  };
}

/** The bottom edge the panel actually paints at (content capped by maxHeight). */
function bottomOf(p: { top: number; maxHeight: number }, panelHeight: number): number {
  return p.top + Math.min(panelHeight, p.maxHeight);
}

/** The USE button's box, from the SAME resolver the touch HUD's CSS mirrors (right: 24, size 76). */
function useBox(width: number, height: number, safeArea: number) {
  const layout = resolveTradingFloorTouchLayout(height, safeArea);
  return {
    left: width - L.useRight - TOUCH_LAYOUT.useSize,
    right: width - L.useRight,
    top: layout.useTop,
    bottom: layout.useBottom,
    bandTop: layout.bandTop,
  };
}

function overlaps(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin < bMax && bMin < aMax;
}

describe('the frozen numbers', () => {
  test('width 320, gap 28, margin 16, top 72, phone below 600, compact min(92vw, 360)', () => {
    expect(L.panelWidth).toBe(320);
    expect(L.anchorGap).toBe(28);
    expect(L.margin).toBe(16);
    expect(L.topMin).toBe(72);
    expect(L.phoneMaxWidth).toBe(600);
    expect(L.compactMaxWidth).toBe(360);
    expect(L.compactViewportFraction).toBe(0.92);
    expect(L.moveEpsilon).toBe(0.5);
  });

  test('the USE column mirrors TradingFloorMobileControls (right: 24, width TOUCH_LAYOUT.useSize)', () => {
    const source = readFileSync(join(import.meta.dir, 'TradingFloorMobileControls.tsx'), 'utf8');
    expect(source).toContain(`right: ${L.useRight},`);
    expect(source).toContain('width: TOUCH_LAYOUT.useSize,');
  });
});

describe('desktop and tablet: beside the anchor', () => {
  test('sits 28 px right of the anchor, vertically centred on it', () => {
    const p = placeHouseAgentWalkup(input({ anchorX: 400, anchorY: 380, panelHeight: 300 }));
    expect(p.mode).toBe('beside');
    expect(p.side).toBe('right');
    expect(p.left).toBe(428);
    expect(p.width).toBe(320);
    expect(p.top).toBe(380 - 150);
  });

  test('flips to the left when the right side overflows', () => {
    const p = placeHouseAgentWalkup(input({ anchorX: 1200 }));
    expect(p.side).toBe('left');
    expect(p.left).toBe(1200 - 28 - 320);
  });

  test('never closer than 16 px to either side', () => {
    for (let x = 0; x <= 1366; x += 17) {
      const p = placeHouseAgentWalkup(input({ anchorX: x }));
      expect(p.left).toBeGreaterThanOrEqual(16);
      expect(p.left + p.width).toBeLessThanOrEqual(1366 - 16);
    }
  });

  test('top never above 72 (below Back to World), bottom never closer than 16 px', () => {
    for (const y of [-50, 0, 40, 72, 300, 700, 768, 900]) {
      for (const h of [120, 300, 680, 2000]) {
        const p = placeHouseAgentWalkup(input({ anchorY: y, panelHeight: h }));
        expect(p.top).toBeGreaterThanOrEqual(72);
        expect(bottomOf(p, h)).toBeLessThanOrEqual(768 - 16 + 1e-9);
        expect(p.maxHeight).toBe(768 - 16 - 72);
      }
    }
  });

  test('a panel taller than the space starts at 72 and is capped by maxHeight', () => {
    const p = placeHouseAgentWalkup(input({ viewportHeight: 500, panelHeight: 900 }));
    expect(p.top).toBe(72);
    expect(p.maxHeight).toBe(500 - 16 - 72);
  });
});

describe('off screen or behind the camera: dock at the nearest side edge, middle height', () => {
  test('anchor flagged off screen on the left half docks left', () => {
    const p = placeHouseAgentWalkup(input({ anchorOnScreen: false, anchorX: 200, panelHeight: 300 }));
    expect(p.mode).toBe('docked');
    expect(p.side).toBe('left');
    expect(p.left).toBe(16);
    expect(p.top).toBe(768 / 2 - 150);
  });

  test('anchor flagged off screen on the right half docks right', () => {
    const p = placeHouseAgentWalkup(input({ anchorOnScreen: false, anchorX: 1000 }));
    expect(p.mode).toBe('docked');
    expect(p.side).toBe('right');
    expect(p.left + p.width).toBe(1366 - 16);
  });

  test('a projected point outside the viewport counts as off screen', () => {
    expect(placeHouseAgentWalkup(input({ anchorX: -40 })).mode).toBe('docked');
    expect(placeHouseAgentWalkup(input({ anchorX: 1500 })).side).toBe('right');
    expect(placeHouseAgentWalkup(input({ anchorY: -10 })).mode).toBe('docked');
    expect(placeHouseAgentWalkup(input({ anchorY: 900 })).mode).toBe('docked');
  });

  test('a non-finite anchor docks without NaN in the output', () => {
    const p = placeHouseAgentWalkup(input({ anchorX: Number.NaN, anchorY: Number.POSITIVE_INFINITY }));
    expect(p.mode).toBe('docked');
    for (const value of [p.left, p.top, p.width, p.maxHeight]) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('phone width < 600: compact card docked top centre', () => {
  test.each([390, 375, 430, 599])('width %i ignores the anchor and docks at top 72, width min(92vw, 360)', (width) => {
    for (const anchorX of [10, width / 2, width - 10]) {
      const p = placeHouseAgentWalkup(input({ viewportWidth: width, viewportHeight: 844, anchorX, touch: true }));
      expect(p.mode).toBe('compact');
      expect(p.side).toBe('center');
      expect(p.top).toBe(72);
      expect(p.width).toBeCloseTo(Math.min(width * 0.92, 360), 9);
      expect(p.left).toBeCloseTo((width - p.width) / 2, 9);
    }
  });

  test('600 is not a phone', () => {
    expect(placeHouseAgentWalkup(input({ viewportWidth: 600, viewportHeight: 900 })).mode).toBe('beside');
  });
});

// The browser sweep's viewports, portrait AND landscape, plus iPhone SE, each
// with the safe-area insets Playwright cannot produce (see the touch layout test).
const TOUCH_VIEWPORTS: Array<[number, number]> = [
  [390, 844], [844, 390],
  [375, 667], [667, 375],
  [744, 1133], [1133, 744],
  [820, 1180], [1180, 820],
  [1024, 1366], [1366, 1024],
];
const SAFE_AREAS = [0, 34, 44];
const PANEL_HEIGHTS = [180, 420, 1400];

describe('touch: both joystick zones and the USE button stay uncovered', () => {
  test.each(TOUCH_VIEWPORTS.flatMap(([w, h]) => SAFE_AREAS.map((s) => [w, h, s] as const)))(
    '%ix%i with a %i px safe area',
    (width, height, safeArea) => {
      const use = useBox(width, height, safeArea);
      for (const panelHeight of PANEL_HEIGHTS) {
        for (const anchorX of [-20, 30, width * 0.25, width / 2, width * 0.75, width - 30]) {
          for (const anchorY of [40, height / 2, height - 30]) {
            for (const onScreen of [true, false]) {
              const p = placeHouseAgentWalkup({
                viewportWidth: width,
                viewportHeight: height,
                anchorX,
                anchorY,
                anchorOnScreen: onScreen,
                panelHeight,
                touch: true,
                safeAreaBottom: safeArea,
              });
              const bottom = bottomOf(p, panelHeight);
              // Margins and the Back to World row.
              expect(p.left).toBeGreaterThanOrEqual(width < 600 ? 0 : 16);
              expect(p.left + p.width).toBeLessThanOrEqual(width - (width < 600 ? 0 : 16) + 1e-9);
              expect(p.top).toBeGreaterThanOrEqual(72);
              expect(p.maxHeight).toBeGreaterThanOrEqual(0);
              // Above the joystick band (both zones span the full width), with the gap.
              expect(bottom).toBeLessThanOrEqual(use.bandTop - L.touchGap + 1e-9);
              // Never over the USE button.
              const hitsUse =
                overlaps(p.left, p.left + p.width, use.left - L.touchGap, use.right) &&
                overlaps(p.top, bottom, use.top - L.touchGap, use.bottom);
              expect(hitsUse).toBe(false);
            }
          }
        }
      }
    },
  );

  test('desktop (no touch HUD) is not clamped to the band', () => {
    const p = placeHouseAgentWalkup(input({ viewportWidth: 1366, viewportHeight: 1024, touch: false, panelHeight: 1400 }));
    expect(p.maxHeight).toBe(1024 - 16 - 72);
  });

  test('390x844 phone portrait: the card ends above the USE button', () => {
    const use = useBox(390, 844, 34);
    const p = placeHouseAgentWalkup(input({ viewportWidth: 390, viewportHeight: 844, touch: true, safeAreaBottom: 34, panelHeight: 1400 }));
    expect(bottomOf(p, 1400)).toBeLessThanOrEqual(use.top - L.touchGap);
    expect(p.maxHeight).toBeGreaterThan(200);
  });
});

describe('the frame loop writes transform only on a move of 0.5 px or more', () => {
  test('sub-threshold moves are skipped, threshold moves are written', () => {
    expect(houseAgentWalkupMoved(100, 200, 100.49, 200.49)).toBe(false);
    expect(houseAgentWalkupMoved(100, 200, 100.5, 200)).toBe(true);
    expect(houseAgentWalkupMoved(100, 200, 100, 199.5)).toBe(true);
    expect(houseAgentWalkupMoved(100, 200, 100, 200)).toBe(false);
  });

  test('the first frame always writes', () => {
    expect(houseAgentWalkupMoved(Number.NaN, Number.NaN, 0, 0)).toBe(true);
  });

  test('placement reuses the out object (no allocation per frame)', () => {
    const out = createHouseAgentWalkupPlacement();
    expect(placeHouseAgentWalkup(input({}), out)).toBe(out);
    expect(placeHouseAgentWalkup(input({ viewportWidth: 390, touch: true }), out)).toBe(out);
  });
});
