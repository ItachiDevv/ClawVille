'use client';

import { useState, useEffect } from 'react';

/**
 * Detects mobile/touch devices using pointer media query and viewport width.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
      const isNarrow = window.innerWidth < 768;
      setIsMobile(hasCoarsePointer || isNarrow);
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
