import { describe, expect, test } from 'bun:test';
import { bottomPromptOffset } from './use-bottom-prompt-slot';
import {
  JOYSTICK_ZONE_BOTTOM_CSS,
  JUMP_BUTTON_BOTTOM_IN_ZONE_CSS,
  JUMP_BUTTON_SIZE_CSS,
  PROMPT_JUMP_CLASH_MAX_VW_PX,
} from '@/lib/hud-anchors';

// 2026-09-18: on a 390 px phone the bottom prompt pill covered ~27 px of the
// Hold-Jump button (measured on prod: 1,404 px2 overlap). Evaluate the real CSS
// strings numerically (bottom insets 0/20/34/44, 16 px rem) at device sizes.

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

const jumpTopFromBottom = (vw: number, vh: number, inset = 0) =>
  evalCss(JOYSTICK_ZONE_BOTTOM_CSS, vw, vh, inset) + evalCss(JUMP_BUTTON_BOTTOM_IN_ZONE_CSS, vw, vh, inset) + evalCss(JUMP_BUTTON_SIZE_CSS, vw, vh, inset);
const pillBottom = (vw: number, vh: number, inset = 0) => evalCss(bottomPromptOffset(true, 'npc'), vw, vh, inset);

describe('the mobile bottom prompt clears the Hold-Jump button', () => {
  for (const [vw, vh] of [[390, 844], [375, 667], [430, 932], [360, 780], [320, 568]]) {
    test(`portrait ${vw}x${vh}: the pill sits at least 8 px above the button`, () => {
      expect(vw).toBeLessThan(PROMPT_JUMP_CLASH_MAX_VW_PX);
      for (const inset of [0, 20, 34, 44]) {
        expect(pillBottom(vw, vh, inset)).toBeGreaterThanOrEqual(jumpTopFromBottom(vw, vh, inset) + 8);
      }
    });
  }

  for (const [vw, vh] of [[600, 960], [744, 1133], [820, 1180], [1024, 1366], [844, 390], [1133, 744]]) {
    test(`${vw}x${vh}: wide enough that the pill keeps its old lift`, () => {
      const old = Math.max(80, Math.min(240, vh - 260));
      expect(pillBottom(vw, vh)).toBe(old);
    });
  }

  test('320x568 with a home indicator fits the prompt reserve and a target of at least 44px', () => {
    for (const inset of [34, 44]) {
      expect(pillBottom(320, 568, inset)).toBe(568 - 260);
      expect(pillBottom(320, 568, inset)).toBeGreaterThanOrEqual(jumpTopFromBottom(320, 568, inset) + 8);
      expect(evalCss(JUMP_BUTTON_SIZE_CSS, 320, 568, inset)).toBeGreaterThanOrEqual(44);
    }
  });

  test('desktop is unchanged', () => {
    expect(bottomPromptOffset(false, 'player')).toBe('calc(env(safe-area-inset-bottom, 0px) + 84px)');
    expect(bottomPromptOffset(false, 'npc')).toBe('calc(env(safe-area-inset-bottom, 0px) + 36px)');
  });
});
