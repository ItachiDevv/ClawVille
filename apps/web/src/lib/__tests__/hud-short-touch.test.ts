import { describe, expect, test } from 'bun:test';
import {
  JOYSTICK_ZONE_BOTTOM_CSS,
  JOYSTICK_ZONE_HEIGHT_PX,
  JUMP_BUTTON_BOTTOM_IN_ZONE_CSS,
  JUMP_BUTTON_SIZE_PX,
  JUMP_BUTTON_SIZE_CSS,
  SHORT_TOUCH_AUTONOMY_MAX_HEIGHT_CSS,
  SHORT_TOUCH_LEFT_ROW_MAX_VW,
  SHORT_TOUCH_MAX_VH,
  SHORT_TOUCH_ROW_LEFT_PX,
  SHORT_TOUCH_UNDER_MAP_TOP_PX,
  PHONE_MAP_BUTTON_TOP_PX,
  SHORT_TOUCH_WIDE_MAX_VH,
} from '@/lib/hud-anchors';

// 2026-09-18 phone overlaps (measured in touch emulation): at 844x390 Hold
// Jump covered the gear and Controls and Controls + Language covered the
// camera joystick; at 740x360 Jump covered Nori; at 667x375 a row beside
// Nori met the guest login banner. Evaluate the actual CSS at a 16 px rem.
// Include bottom insets: the old zero-only evaluator hid real-device collisions.

function evalCss(css: string, vw: number, vh: number, bottomInset = 0): number {
  const js = css
    .replace(/env\(safe-area-inset-bottom, 0px\)/g, String(bottomInset))
    .replace(/env\(safe-area-inset-[a-z]+, 0px\)/g, '0')
    .replace(/100dvh/g, String(vh))
    .replace(/100vw/g, String(vw))
    .replace(/(\d+(?:\.\d+)?)vw/g, (_, n) => String((Number(n) * vw) / 100))
    .replace(/(\d+(?:\.\d+)?)rem/g, (_, n) => String(Number(n) * 16))
    .replace(/(\d+(?:\.\d+)?)px/g, '$1')
    .replace(/calc\(/g, '(')
    .replace(/clamp\(/g, '__clamp(')
    .replace(/max\(/g, 'Math.max(')
    .replace(/min\(/g, 'Math.min(');
  // eslint-disable-next-line no-new-func
  return new Function('__clamp', `return ${js};`)((a: number, b: number, c: number) => Math.min(Math.max(a, b), c));
}

const NORI_BOTTOM = 62; // top-4 + measured height
const ROW = { top: 16, bottom: 60 }; // the top-line row (below 768 px) and Nori's line
const jumpTop = (vw: number, vh: number, inset = 0) =>
  vh - evalCss(JOYSTICK_ZONE_BOTTOM_CSS, vw, vh, inset) - evalCss(JUMP_BUTTON_BOTTOM_IN_ZONE_CSS, vw, vh, inset) - evalCss(JUMP_BUTTON_SIZE_CSS, vw, vh, inset);
const cameraStickTop = (vw: number, vh: number, inset = 0) =>
  vh - evalCss(JOYSTICK_ZONE_BOTTOM_CSS, vw, vh, inset) - JOYSTICK_ZONE_HEIGHT_PX + 80; // nipple top: 140 above zone bottom

const SHORT = [[667, 375], [740, 360], [812, 375], [844, 390], [932, 430]] as const;

describe('short touch screens (phones held landscape)', () => {
  const DEVICE_SIZES = [
    [390, 844], [844, 390], [744, 1133], [1133, 744],
    [820, 1180], [1180, 820], [1024, 1366], [1366, 1024],
    [740, 360], [667, 375], [812, 375], [320, 568],
  ] as const;

  for (const [vw, vh] of DEVICE_SIZES) {
    for (const inset of [0, 20, 34, 44]) {
      test(`${vw}x${vh}, bottom inset ${inset}: Jump stays between Nori and the joystick with a 44px target`, () => {
        const size = evalCss(JUMP_BUTTON_SIZE_CSS, vw, vh, inset);
        const top = jumpTop(vw, vh, inset);
        expect(size).toBeGreaterThanOrEqual(44);
        expect(size).toBeLessThanOrEqual(JUMP_BUTTON_SIZE_PX);
        expect(top).toBeGreaterThanOrEqual(NORI_BOTTOM + 8);
        expect(top + size).toBeLessThanOrEqual(cameraStickTop(vw, vh, inset));
        if (inset <= 20) {
          expect(size).toBe(JUMP_BUTTON_SIZE_PX);
          const previousBottom = Math.min(Math.min(Math.max(148, 0.38 * vw), 168), vh - 214);
          expect(top).toBeCloseTo(vh - 80 - previousBottom - 64, 8);
        }
      });

      if (vh < (vw < 768 ? SHORT_TOUCH_MAX_VH : SHORT_TOUCH_WIDE_MAX_VH)) {
        test(`${vw}x${vh}, bottom inset ${inset}: Autonomous panel ends above camera joystick`, () => {
          const height = evalCss(SHORT_TOUCH_AUTONOMY_MAX_HEIGHT_CSS, vw, vh, inset);
          expect(height).toBeGreaterThan(0);
          expect(70 + height).toBeLessThanOrEqual(cameraStickTop(vw, vh, inset) - 8);
        });
      }
    }
  }

  test('the old zero-inset cap reproduces the reported collision with a home-indicator inset', () => {
    const vh = 360, padBottom = 94, oldBottom = 146;
    expect(vh - padBottom - oldBottom - 64).toBeLessThan(NORI_BOTTOM);
    expect(jumpTop(740, vh, 34)).toBeGreaterThanOrEqual(NORI_BOTTOM + 8);
  });

  for (const [vw, vh] of SHORT) {
    test(`${vw}x${vh}: short, Jump below Nori and the top row, above the camera joystick`, () => {
      expect(vh).toBeLessThan(SHORT_TOUCH_MAX_VH);
      const top = jumpTop(vw, vh);
      expect(top).toBeGreaterThanOrEqual(NORI_BOTTOM + 8);
      expect(top).toBeGreaterThanOrEqual(ROW.bottom + 8);
      expect(top + JUMP_BUTTON_SIZE_PX).toBeLessThanOrEqual(cameraStickTop(vw, vh));
    });
  }

  test('iPads and portrait phones are not short', () => {
    for (const [, vh] of [[1133, 744], [744, 1133], [390, 844], [375, 667]]) {
      expect(vh).toBeGreaterThanOrEqual(SHORT_TOUCH_MAX_VH);
    }
  });

  test('portrait: Jump stays 8 px above the camera joystick; 390+ phones unchanged', () => {
    for (const [vw, vh] of [[390, 844], [375, 667], [430, 932], [360, 780], [320, 568]]) {
      expect(evalCss(JUMP_BUTTON_BOTTOM_IN_ZONE_CSS, vw, vh)).toBe(Math.min(Math.max(148, 0.38 * vw), 168));
      expect(jumpTop(vw, vh) + JUMP_BUTTON_SIZE_PX).toBeLessThanOrEqual(cameraStickTop(vw, vh) - 8);
    }
    // The old floor (7rem) at 390+ gave the same value: those phones do not move.
    for (const vw of [390, 414, 430]) expect(Math.min(Math.max(148, 0.38 * vw), 168)).toBe(Math.min(Math.max(112, 0.38 * vw), 168));
  });

  const W = 46; // button width (44-46 px)
  const rowRight = (inset: number) => inset + SHORT_TOUCH_ROW_LEFT_PX.language + W;

  test('buttons in the row do not touch', () => {
    expect(SHORT_TOUCH_ROW_LEFT_PX.controls).toBeGreaterThanOrEqual(SHORT_TOUCH_ROW_LEFT_PX.gear + 44 + 8);
    expect(SHORT_TOUCH_ROW_LEFT_PX.language).toBeGreaterThanOrEqual(SHORT_TOUCH_ROW_LEFT_PX.controls + W + 8);
  });

  test('below 768 px: top line at the left, clear of the centred login banner', () => {
    for (const vw of [667, 740]) {
      expect(vw).toBeLessThan(SHORT_TOUCH_LEFT_ROW_MAX_VW);
      expect(rowRight(0)).toBeLessThan(vw / 2 - 152.5); // ~305 px banner
    }
  });

  test('from 768 px: under the collapsed minimap header, clear of the centred stack and the left joystick, with and without a notch inset', () => {
    expect(SHORT_TOUCH_UNDER_MAP_TOP_PX).toBeGreaterThanOrEqual(63 + 8); // minimap header bottom
    for (const [vw, vh] of [[768, 375], [780, 360], [812, 375], [844, 390], [932, 430]]) {
      for (const inset of [0, 47]) {
        // Mode toggle (y 80-116) is up to ~200 px wide, centred.
        expect(rowRight(inset)).toBeLessThan(vw / 2 - 100 - 8);
      }
      // Left joystick top (vh - 220) is below the row (top + 44).
      expect(SHORT_TOUCH_UNDER_MAP_TOP_PX + 44).toBeLessThan(cameraStickTop(vw, vh));
    }
  });

  test('AutonomyHUD on a short screen: right side under Nori, clear of the mode toggle and the camera joystick', () => {
    // Mirrors autonomy-hud.tsx: top 70, right inset+16, width min(320, 50vw - 134 - inset), maxHeight 100dvh - 298.
    for (const [vw, vh] of [[667, 375], [740, 360], [812, 375], [844, 390], [932, 430]]) {
      for (const inset of [0, 47]) {
        const width = Math.min(320, vw / 2 - 134 - inset);
        const left = vw - inset - 16 - width;
        expect(left).toBeGreaterThanOrEqual(vw / 2 + 110 + 8); // quest card (~220 px) and toggle (~200 px), + gap
        expect(70).toBeGreaterThanOrEqual(NORI_BOTTOM + 8);
        expect(70 + (vh - 298)).toBeLessThanOrEqual(cameraStickTop(vw, vh) - 8);
      }
    }
  });

  test('phone Map button (below 768 px): under the top stack and the short-screen row, left of the centred toggle, above the left joystick', () => {
    const top = PHONE_MAP_BUTTON_TOP_PX, bottom = top + 44, right = 16 + 44;
    expect(top).toBeGreaterThanOrEqual(52 + 8); // login banner / agent pill bottom
    expect(top).toBeGreaterThanOrEqual(ROW.bottom + 8); // short-screen top-left row
    for (const [vw, vh] of [[360, 780], [375, 667], [390, 844], [430, 932], [667, 375], [740, 360], [744, 1133]]) {
      expect(right).toBeLessThan(vw / 2 - 100 - 8); // mode toggle, up to ~200 px, centred
      expect(bottom).toBeLessThan(cameraStickTop(vw, vh) - 8); // left joystick top (same height as the right)
    }
  });

  test('wide touch screens below 658 px high use the short layout, so the capped left Autonomous panel never gets under ~96 px', () => {
    // Left panel cap from md: vh - 272 (bottom) - 290 (below the full minimap card).
    for (const vh of [SHORT_TOUCH_WIDE_MAX_VH, 700, 744, 820]) expect(vh - 272 - 290).toBeGreaterThanOrEqual(96);
    // Short-layout right panel (top 70, to 8 px above the camera joystick) inside the band.
    for (const vh of [560, 600, SHORT_TOUCH_WIDE_MAX_VH - 1]) expect(vh - 298).toBeGreaterThanOrEqual(96);
  });
});
