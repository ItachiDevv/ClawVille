'use client';

/**
 * SlotReelsCanvas — R3F Canvas wrapper for the per-cell-plane drum rig.
 *
 * Camera: OrthographicCamera, fixed world bounds — independent of canvas
 * pixel aspect so drums fill the region at any modal width.
 *
 * Bounds chosen for drum geometry (DRUM_RADIUS=1.5, REEL_SPACING=3.2):
 *   Horizontal: 5 reels, outermost centres at ±2×3.2=±6.4wu, edges at ±(6.4+1.5)=±7.9wu
 *     → left=-8.5, right=8.5 (0.6wu breathing room)
 *   Vertical: drum diameter=3wu (2×DRUM_RADIUS) + bezel margin
 *     → top=2.2, bottom=-2.2
 *
 * frameloop='always' — demand mode causes transparent-black canvas on mount.
 * DPR cap [0.55, 0.7] on low-end keeps Iris Xe pixel budget manageable.
 */

import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrthographicCamera } from '@react-three/drei';
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
        gl={{
          antialias:             false,
          powerPreference:       'high-performance',
          preserveDrawingBuffer: true,  // required for readPixels verification; canvas is modal-scoped so no perf issue
        }}
        style={{ display: 'block', width: '100%', height: '100%' }}
      >
        <OrthographicCamera
          makeDefault
          position={[0, 0, 10]}
          near={0.1}
          far={30}
          left={-8.5}
          right={8.5}
          top={2.2}
          bottom={-2.2}
        />
        <Suspense fallback={null}>
          <SlotReels3D {...props} />
        </Suspense>
      </Canvas>
    </div>
  );
}
