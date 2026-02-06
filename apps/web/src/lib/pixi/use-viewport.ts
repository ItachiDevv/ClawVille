import { useState, useEffect, useCallback } from 'react';

export interface ViewportSize {
  width: number;
  height: number;
}

export function useViewport(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>({ width: 800, height: 600 });

  const update = useCallback(() => {
    setSize({ width: window.innerWidth, height: window.innerHeight });
  }, []);

  useEffect(() => {
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [update]);

  return size;
}
