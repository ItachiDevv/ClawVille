'use client';

/**
 * SlotReelsCanvas — R3F Canvas wrapper for the 3D cylinder drum rig.
 *
 * Camera: z=5, fov=65° — viewport half-width ≈ 3.19 wu, fits 5 reels × 1 wu.
 * Far plane: 10 — well beyond camera z (5) + plane depth (0).
 * frameloop='always' — demand mode causes transparent-black canvas on mount.
 * DPR cap [0.55, 0.7] on low-end keeps Iris Xe pixel budget manageable.
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
        width:    '100%',
        height:   '100%',
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
          far:      10,
          position: [0, 0, 5],
        }}
        gl={{
          antialias:             false,
          powerPreference:       'high-performance',
          preserveDrawingBuffer: true,  // required for readPixels verification; canvas is modal-scoped so no perf issue
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
