/**
 * D2 regression + registry drift guard — every /game fixed HUD element
 * registered in `GAME_HUD` (`../hud-layout.ts`) must still carry the
 * z literal the registry claims for it, in whatever form the source file
 * actually uses (Tailwind class, inline `style`, or a CSS rule). A future
 * edit that changes one of these literals without updating the registry
 * fails this test instead of silently reintroducing a D1/D2-class overlap.
 *
 * Reads real file text via `readFileSync` (same pattern as
 * `../../cove/__tests__` Slice 1 CSS check) rather than importing the
 * components — Tailwind classes and inline styles are not "resolved" at
 * module-import time, only present as source text, so this is the only
 * reliable way to verify them without a browser.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GAME_HUD, HUD_Z } from '../hud-layout';

const fileCache = new Map<string, string>();

function readGameHudFile(relPath: string): string {
  const cached = fileCache.get(relPath);
  if (cached !== undefined) return cached;
  // `relPath` is relative to `apps/web/src` (the `@/` alias root); this test
  // lives at `apps/web/src/lib/hud/__tests__/`, three levels below `src`.
  const url = new URL(`../../../${relPath}`, import.meta.url);
  const content = readFileSync(url, 'utf8');
  fileCache.set(relPath, content);
  return content;
}

/**
 * Accepts any of the three forms a z-layer literal shows up in this
 * codebase: a Tailwind default-scale class (`z-40`), a Tailwind
 * arbitrary-value class (`z-[42]`), an inline JS style property
 * (`zIndex: 45`), or a CSS rule (`z-index: 50`).
 */
function zLiteralPresent(source: string, z: number): boolean {
  const patterns = [
    new RegExp(`\\bz-${z}\\b`),
    new RegExp(`\\bz-\\[${z}\\]`),
    new RegExp(`\\bzIndex:\\s*${z}\\b`),
    new RegExp(`\\bz-index:\\s*${z}\\b`),
  ];
  return patterns.some((re) => re.test(source));
}

describe('GAME_HUD registry stays bound to the live /game source', () => {
  test('every registry entry declares expectedZ === HUD_Z[layer]', () => {
    for (const entry of GAME_HUD) {
      expect(entry.expectedZ).toBe(HUD_Z[entry.layer]);
    }
  });

  test('every registered layer is a real HUD_Z key', () => {
    for (const entry of GAME_HUD) {
      expect(Object.prototype.hasOwnProperty.call(HUD_Z, entry.layer)).toBe(true);
    }
  });

  for (const entry of GAME_HUD) {
    test(`${entry.name} — ${entry.file} still contains a z=${entry.expectedZ} literal (${entry.form})`, () => {
      const source = readGameHudFile(entry.file);
      expect(zLiteralPresent(source, entry.expectedZ)).toBe(true);
    });
  }

  test('D2 regression: nori-button.tsx renders icon-only on mobile via the canonical useIsMobile() hook', () => {
    const source = readGameHudFile('components/game/nori-button.tsx');
    // Must gate on the shared hook, never a bare Tailwind breakpoint (would
    // miss iPad Air/Pro per the project's standing iPad-detection rule).
    expect(source).toContain("import { useIsMobile } from '@/hooks/use-is-mobile'");
    expect(source).toMatch(/isMobile\s*=\s*useIsMobile\(\)/);
    // The label span must be conditionally omitted, not just visually hidden
    // (a hidden-but-present label would still occupy layout width and could
    // still overlap the banner).
    expect(source).toMatch(/!isMobile\s*&&\s*\(/);
    expect(source).toContain('min-w-11 min-h-11');
    expect(source).not.toMatch(/\bmd:/);
  });
});
