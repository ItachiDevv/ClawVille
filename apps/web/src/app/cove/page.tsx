'use client';

/**
 * Cove Interior — /cove route
 *
 * Route-isolated interior scene for the Predictive Gaming Cove.
 * Canvas key={'cove-interior'} ensures a clean WebGPU context teardown
 * when the user navigates away (back to /game or elsewhere).
 *
 * Scope — Concern 6.0.2:
 *   - Loads cove-interior.glb (gameready, 4.2MB, Draco-compressed)
 *   - Auto-falls back to cove-interior-fallback.glb if FPS < 40 or ?fallback=1
 *   - Click hotspots over slot machines → placeholder console.info handler
 *   - "Back to World" exit button (top-left, absolute over Canvas) → /game
 *
 * Walk-in flow — Concern 6.0.3:
 *   - SceneTransition with fadeInOnMount=true: page fades in from black after
 *     the route push that happened at the midpoint of the walk-in fade-out.
 *   - "Back to World" button uses triggerTransition({ to: '/game' }) so there
 *     is a matching 500ms fade-out before the route push back to the world,
 *     and the /game page avatar spawns at the cove door position (outside).
 *
 * Out of scope:
 *   - 2D slot screen UI (Concern 6.0.4)
 *   - Backend / RNG / wager program (Concern 6.1+)
 */

import { useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import SceneTransition, { useSceneTransition } from '@/components/transitions/SceneTransition';
import SlotScreenModal from '@/components/cove/SlotScreenModal';
import BlackjackModal from '@/components/cove/blackjack/BlackjackModal';
import HoldemModal from '@/components/cove/holdem/HoldemModal';
import CoveMobileControls from '@/components/cove/CoveMobileControls';
import { useAvatar } from '@/hooks/use-avatar';
import { useGameStore } from '@/stores/game';

/**
 * CoveCanvas — dynamically imported with ssr:false so Three.js /
 * WebGPU never runs in the Next.js SSR environment.
 * Follows the same pattern as Arena3DCanvas on /arena.
 */
const CoveCanvas = dynamic(
  () => import('@/components/three/CoveCanvas'),
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
          Loading Cove...
        </p>
      </div>
    ),
  },
);

// ---------------------------------------------------------------------------
// Cove door position in game-px — avatar spawns here on exit so it feels
// like stepping back out through the same door they entered.
//
// Cove zone: slot 9 W → cx=50 tiles, cy=180 tiles.
// World formula: worldX = cx×32 − 5760 = 50×32 − 5760 = −4160 wu.
// Exit = 400 wu east (toward town-center at origin) → −3760 wu.
// game-px x = −3760 + 5760 = 2000.   game-px y = 5760 (center row, unchanged).
// ---------------------------------------------------------------------------
const COVE_EXIT_PX = { x: 2000, y: 5760 };

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function CovePage() {
  const { triggerTransition } = useSceneTransition();

  // Phase 6.1.20 — sync the user's authenticated avatar into the gameStore
  // every time this page mounts. Mirrors the same effect on /game (line 346)
  // so direct nav to /cove or a stale gameStore.avatarModelKey never makes
  // the cove render the wrong avatar. Without this, the cove was falling
  // back to DEFAULT_AGENT_MODEL_KEY ('milady_official_1') for logged-in
  // users whose selected avatar was anything else.
  const { data: avatar } = useAvatar();
  useEffect(() => {
    if (avatar) {
      useGameStore.getState().setAvatarAppearance(
        avatar.species,
        avatar.color,
        undefined,
        avatar.modelKey,
      );
    }
  }, [avatar]);

  const handleBack = useCallback(() => {
    // Reset cursor in case the player was hovering a slot hotspot
    if (typeof document !== 'undefined') document.body.style.cursor = 'default';
    // Fade-out → restore avatar at cove door → push /game → fade-in handled
    // by the /game page. Avatar position is set at midway so the world scene
    // mounts with the avatar already at the door, not at the default spawn.
    triggerTransition({
      to: '/game',
      onMidway: () => {
        // Reposition avatar to outside the cove door in game-px space.
        // avatarPositionRef is updated directly (zero React overhead) and the
        // zustand reactive slice is updated via setAvatarPosition so the 2D
        // minimap and any other subscribers see the new position immediately.
        if (typeof window !== 'undefined') {
          try {
            // Dynamic import to avoid SSR issues
            const { avatarPositionRef } = require('@/stores/game') as typeof import('@/stores/game');
            const { useGameStore } = require('@/stores/game') as typeof import('@/stores/game');
            avatarPositionRef.x = COVE_EXIT_PX.x;
            avatarPositionRef.y = COVE_EXIT_PX.y;
            useGameStore.getState().setAvatarPosition(COVE_EXIT_PX.x, COVE_EXIT_PX.y);
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
      {/* 3D Cove Interior Canvas — full viewport */}
      <div style={{ position: 'absolute', inset: 0 }}>
        <CoveCanvas />
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

      {/* Provably-fair verifier link — top-right, mirrors the Back button style. */}
      <Link
        href="/cove/verify"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
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
          textDecoration: 'none',
          letterSpacing: '0.04em',
          transition: 'border-color 0.2s, background 0.2s',
        }}
      >
        🔐 Verify
      </Link>

      {/* 2D Slot Screen Modal — DOM overlay, renders on top of 3D canvas.
          z-index 9990 ensures it layers above the Canvas (z-index ~0) but below
          browser UI. The 3D interior stays mounted and rendering underneath. */}
      <SlotScreenModal />

      {/* Phase 6.4.0 — Blackjack table modal (display shell, fun-money only).
          Same z-index as slot modal so only one game modal is open at a time.
          Real engine + per-card decisions land in Phase 6.4.1. */}
      <BlackjackModal />

      {/* Phase 6.5.0 — Texas Hold'em table modal (6-seat visual shell,
          display-only ClawTokens). Same z-index policy as the other game
          modals. Real pokerpocket engine + bot personalities + ClawToken
          ledger integration land in Phase 6.5.1. */}
      <HoldemModal />

      {/* iPad / phone touch controls — auto-hidden on desktop via useIsMobile.
          Critical fix 2026-05-27: cove had zero touch input; iPad users
          could see the scene but not move. */}
      <CoveMobileControls />

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
            Slots · Blackjack · Hold&apos;em
          </span>
        </div>
      </div>
    </div>
  );
}
