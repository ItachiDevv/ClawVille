'use client';

/**
 * Casino Interior — /casino route
 *
 * Route-isolated interior scene for the Predictive Gaming Cove.
 * Canvas key={'casino-interior'} ensures a clean WebGPU context teardown
 * when the user navigates away (back to /game or elsewhere).
 *
 * Scope — Concern 6.0.2:
 *   - Loads casino-interior.glb (gameready, 4.2MB, Draco-compressed)
 *   - Auto-falls back to casino-interior-fallback.glb if FPS < 40 or ?fallback=1
 *   - Click hotspots over slot machines → placeholder console.info handler
 *   - "Back to World" exit button (top-left, absolute over Canvas) → /game
 *
 * Out of scope:
 *   - Walk-in animation (Concern 6.0.3)
 *   - 2D slot screen UI (Concern 6.0.4)
 *   - Backend / RNG / wager program (Concern 6.1+)
 */

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';

/**
 * CasinoCanvas — dynamically imported with ssr:false so Three.js /
 * WebGPU never runs in the Next.js SSR environment.
 * Follows the same pattern as Arena3DCanvas on /arena.
 */
const CasinoCanvas = dynamic(
  () => import('@/components/three/CasinoCanvas'),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0015',
        }}
      >
        <p
          style={{
            color: '#00ffe0',
            fontFamily: 'monospace',
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: '0.06em',
          }}
        >
          Loading Casino...
        </p>
      </div>
    ),
  },
);

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function CasinoPage() {
  const router = useRouter();

  const handleBack = useCallback(() => {
    // Reset cursor in case the player was hovering a slot hotspot
    if (typeof document !== 'undefined') document.body.style.cursor = 'default';
    router.push('/game');
  }, [router]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0a0015',
        overflow: 'hidden',
      }}
    >
      {/* 3D Casino Interior Canvas — full viewport */}
      <div style={{ position: 'absolute', inset: 0 }}>
        <CasinoCanvas />
      </div>

      {/* Back to World — top-left, always above canvas */}
      <button
        onClick={handleBack}
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 18px',
          background: 'rgba(10, 0, 21, 0.82)',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(0, 255, 224, 0.35)',
          borderRadius: 10,
          color: '#00ffe0',
          fontWeight: 700,
          fontSize: 14,
          fontFamily: 'monospace',
          cursor: 'pointer',
          letterSpacing: '0.04em',
          transition: 'border-color 0.2s, background 0.2s',
        }}
        onMouseEnter={(e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.style.borderColor = 'rgba(0, 255, 224, 0.75)';
          btn.style.background   = 'rgba(0, 255, 224, 0.08)';
        }}
        onMouseLeave={(e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.style.borderColor = 'rgba(0, 255, 224, 0.35)';
          btn.style.background   = 'rgba(10, 0, 21, 0.82)';
        }}
      >
        Back to World
      </button>

      {/* Interior branding — bottom-center */}
      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 30,
          pointerEvents: 'none',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            background: 'rgba(10, 0, 21, 0.75)',
            backdropFilter: 'blur(4px)',
            border: '1px solid rgba(255, 0, 204, 0.25)',
            borderRadius: 8,
            padding: '6px 20px',
          }}
        >
          <span style={{ color: '#ff00cc', fontWeight: 700, fontSize: 13, fontFamily: 'monospace' }}>
            Predictive Gaming Cove
          </span>
          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, marginLeft: 8 }}>
            Click a slot machine to play
          </span>
        </div>
      </div>
    </div>
  );
}
