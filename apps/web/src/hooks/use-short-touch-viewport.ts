'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import {
  SHORT_TOUCH_LEFT_ROW_MAX_VW,
  SHORT_TOUCH_MAX_VH,
  SHORT_TOUCH_WIDE_MAX_VH,
  SHORT_TOUCH_ROW_LEFT_PX,
  SHORT_TOUCH_ROW_TOP_PX,
  SHORT_TOUCH_UNDER_MAP_TOP_PX,
} from '@/lib/hud-anchors';
import { useIsMobile } from '@/hooks/use-is-mobile';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Where the touch utility buttons go on a short screen, or null for the
 * normal right column: 'top-left' (minimap hidden, below 768 px) or
 * 'under-map' (from 768 px, under the collapsed minimap header).
 */
export type ShortTouchRow = 'top-left' | 'under-map' | null;

/**
 * On a touch device whose viewport is SHORT (a phone held landscape), the
 * right-column utility buttons (gear, Controls, Language) leave their
 * vertical stack, which reached y 228 and covered Hold Jump and the camera
 * joystick (measured 2026-09-18 at 844x390 and 932x430), and form one row at
 * the LEFT, clear of the centred top stack at every width and notch inset.
 * See SHORT_TOUCH_* in hud-anchors.ts.
 */
export function useShortTouchRow(): ShortTouchRow {
  const isMobile = useIsMobile();
  const [row, setRow] = useState<ShortTouchRow>(null);
  useIsomorphicLayoutEffect(() => {
    if (!isMobile) {
      setRow(null);
      return;
    }
    const read = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const short = h < SHORT_TOUCH_MAX_VH || (w >= SHORT_TOUCH_LEFT_ROW_MAX_VW && h < SHORT_TOUCH_WIDE_MAX_VH);
      if (!short) setRow(null);
      else setRow(w < SHORT_TOUCH_LEFT_ROW_MAX_VW ? 'top-left' : 'under-map');
    };
    read();
    const vv = window.visualViewport;
    window.addEventListener('resize', read);
    vv?.addEventListener('resize', read);
    return () => {
      window.removeEventListener('resize', read);
      vv?.removeEventListener('resize', read);
    };
  }, [isMobile]);
  return isMobile ? row : null;
}

/** Fixed-position style for one row button, or null when the column applies. */
export function shortTouchRowStyle(
  row: ShortTouchRow,
  slot: 'gear' | 'controls' | 'language',
): { top: number; left: string } | null {
  if (row === null) return null;
  return {
    top: row === 'top-left' ? SHORT_TOUCH_ROW_TOP_PX : SHORT_TOUCH_UNDER_MAP_TOP_PX,
    left: `calc(env(safe-area-inset-left, 0px) + ${SHORT_TOUCH_ROW_LEFT_PX[slot]}px)`,
  };
}
