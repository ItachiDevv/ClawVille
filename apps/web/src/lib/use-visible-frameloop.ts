'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * IntersectionObserver-driven frameloop toggle for landing-page R3F
 * canvases. When the wrapping div scrolls fully out of view, returns
 * `'never'` so the Canvas stops rendering frames and the GPU goes idle.
 * When the div re-enters the viewport (with a 200px rootMargin so the
 * scene is warm before it's actually visible), returns `'always'`.
 *
 * Big perf win on the landing page where 4 separate canvases would
 * otherwise compete for the GPU even when scrolled completely past.
 *
 * Usage:
 *
 *   const { ref, frameloop } = useVisibleFrameloop();
 *   return (
 *     <div ref={ref} style={{ width: '100%', height: '100%' }}>
 *       <Canvas frameloop={frameloop}>…</Canvas>
 *     </div>
 *   );
 */
export function useVisibleFrameloop() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [frameloop, setFrameloop] = useState<'always' | 'never'>('always');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        setFrameloop(visible ? 'always' : 'never');
      },
      { rootMargin: '200px 0px 200px 0px', threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return { ref, frameloop };
}
