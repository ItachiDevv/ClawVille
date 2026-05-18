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
 * Walk-in flow — Concern 6.0.3:
 *   - SceneTransition with fadeInOnMount=true: page fades in from black after
 *     the route push that happened at the midpoint of the walk-in fade-out.
 *   - "Back to World" button uses triggerTransition({ to: '/game' }) so there
 *     is a matching 500ms fade-out before the route push back to the world,
 *     and the /game page avatar spawns at the casino door position (outside).
 *
 * Out of scope:
 *   - 2D slot screen UI (Concern 6.0.4)
 *   - Backend / RNG / wager program (Concern 6.1+)
 */

import { useCallback } from 'react';
import dynamic from 'next/dynamic';
import SceneTransition, { useSceneTransition } from '@/components/transitions/SceneTransition';

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
// Casino door position in game-px — avatar spawns here on exit so it feels
// like stepping back out through the same door they entered.
// Casino zone: cx=20 tiles, cy=180 tiles. Door ~300 game-px east of building center.
// ---------------------------------------------------------------------------
const CASINO_EXIT_PX = { x: 940, y: 5760 };

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function CasinoPage() {
  const { triggerTransition } = useSceneTransition();

  const handleBack = useCallback(() => {
    // Reset cursor in case the player was hovering a slot hotspot
    if (typeof document !== 'undefined') document.body.style.cursor = 'default';
    // Fade-out → restore avatar at casino door → push /game → fade-in handled
    // by the /game page. Avatar position is set at midway so the world scene
    // mounts with the avatar already at the door, not at the default spawn.
    triggerTransition({
      to: '/game',
      onMidway: () => {
        // Reposition avatar to outside the casino door in game-px space.
        // avatarPositionRef is updated directly (zero React overhead) and the
        // zustand reactive slice is updated via setAvatarPosition so the 2D
        // minimap and any other subscribers see the new position immediately.
        if (typeof window !== 'undefined') {
          try {
            // Dynamic import to avoid SSR issues
            const { avatarPositionRef } = require('@/stores/game') as typeof import('@/stores/game');
            const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
            avatarPositionRef.x = CASINO_EXIT_PX.x;
            avatarPositionRef.y = CASINO_EXIT_PX.y;
            useGameStore.getState().setAvatarPosition(CASINO_EXIT_PX.x, CASINO_EXIT_PX.y);
          } catch {
            // Silently degrade — avatar will be at default spawn position
          }
        }
      },
    });
  }, [triggerTransition]);

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

      {/* SceneTransition overlay — fades in from black on mount (walk-in arrival),
          also handles fade-out for "Back to World" button via triggerTransition(). */}
      <SceneTransition fadeInOnMount />

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
