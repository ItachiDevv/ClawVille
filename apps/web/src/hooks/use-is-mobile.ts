'use client';

import { useState, useEffect, useLayoutEffect } from 'react';

// Layout effect in the browser, so the touch decision is made BEFORE the first
// paint and no touch-only layout paints once in its desktop form (the minimap
// did, Codex review 2026-09-18). Plain effect on the server, where layout
// effects do not run.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Detects mobile/touch devices using pointer media query, viewport width,
 * AND `navigator.maxTouchPoints` (the only reliable iPad signal — modern
 * iPadOS Safari reports as Mac in `userAgent` so we must check touch points).
 *
 * Without the `maxTouchPoints` branch, an iPad in landscape (≥1024 px) with
 * an attached keyboard (`pointer: fine`) registers as desktop, mobile
 * controls never render, and the user can SEE the world but can't move.
 * Reported critical 2026-05-27.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const checkMobile = () => {
      const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
      const isNarrow = window.innerWidth < 768;
      // iPad-on-Mac-UA fix: modern iPads expose maxTouchPoints > 1 even
      // when the userAgent claims macOS. Desktops with touchscreens may
      // report 1, so we require >1 to avoid false positives.
      const hasMultiTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
      // Belt-and-suspenders for older WebKit (Touch Events without PointerEvents).
      const hasTouchStart = typeof window !== 'undefined' && 'ontouchstart' in window;
      setIsMobile(hasCoarsePointer || isNarrow || hasMultiTouch || hasTouchStart);
    };

    checkMobile();

    const mediaQuery = window.matchMedia('(pointer: coarse)');
    const handleMediaChange = () => checkMobile();
    mediaQuery.addEventListener('change', handleMediaChange);

    window.addEventListener('resize', checkMobile);

    return () => {
      mediaQuery.removeEventListener('change', handleMediaChange);
      window.removeEventListener('resize', checkMobile);
    };
  }, []);

  return isMobile;
}
