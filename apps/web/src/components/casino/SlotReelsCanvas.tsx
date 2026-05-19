'use client';

/**
 * SlotReelsCanvas — R3F Canvas wrapper for the 3D reel rig.
 *
 * Sized 480×360px (desktop). `frameloop='always'` — demand mode with no
 * explicit invalidate() call causes the canvas to stay black on mount
 * (no frames are ever committed). The modal is only open while the user
 * is at the slot machine, so always-loop is acceptable.
 * Low-end GPU detection mirrors CasinoCanvas.tsx exactly.
 *
 * Iris Xe invariants:
 *   - DPR cap [0.55, 0.7] on low-end, [0.75, 1] otherwise
 *   - No shadows
 *   - frameloop='always' (demand caused transparent-black canvas on mount)
 */

import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import dynamic from 'next/dynamic';
import type { SlotReels3DProps } from './SlotReels3D';

// ---------------------------------------------------------------------------
// Low-end GPU detection (same pattern as CasinoCanvas.tsx)
// ---------------------------------------------------------------------------
const LOW_END_GPU: boolean = (() => {
  if (typeof window === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return true;
    const ext      = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    const isLowEnd = /\bintel\b|\biris\b|\buhd graphics\b|\bhd graphics\b|\bgma\b|adreno|mali|powervr|apple gpu/i.test(renderer);
    const isTouch  = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    return isLowEnd || isTouch;
  } catch {
    return false;
  }
})();

// Dynamic import keeps SSR clean — canvas APIs are browser-only
const SlotReels3D = dynamic(() => import('./SlotReels3D'), { ssr: false });

// ---------------------------------------------------------------------------
// Props (forward everything SlotReels3D needs)
// ---------------------------------------------------------------------------
export type SlotReelsCanvasProps = SlotReels3DProps;

// ---------------------------------------------------------------------------
// Canvas wrapper
// ---------------------------------------------------------------------------
export default function SlotReelsCanvas(props: SlotReelsCanvasProps) {
  return (
    <div
      style={{
        width:    480,
        height:   360,
        maxWidth: '100%',
        position: 'relative',
        background: 'linear-gradient(180deg, rgba(5,10,24,0.95) 0%, rgba(2,4,10,0.98) 100%)',
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid rgba(0,255,224,0.18)',
        boxShadow: 'inset 0 0 24px rgba(0,255,224,0.06), 0 0 24px rgba(0,0,0,0.6)',
      }}
    >
      <Canvas
        dpr={LOW_END_GPU ? [0.55, 0.7] : [0.75, 1]}
        frameloop="always"
        camera={{
          fov:      65,
          near:     0.1,
          far:      50,
          position: [0, 0, 5],
        }}
        gl={{
          antialias:        false,
          powerPreference:  'high-performance',
          preserveDrawingBuffer: false,
        }}
        style={{ display: 'block', width: '100%', height: '100%' }}
      >
        <Suspense fallback={null}>
          <SlotReels3D {...props} />
        </Suspense>
      </Canvas>
    </div>
  );
}
