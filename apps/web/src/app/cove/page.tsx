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

import { useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import SceneTransition, { useSceneTransition } from '@/components/transitions/SceneTransition';
import SlotScreenModal from '@/components/cove/SlotScreenModal';
import BlackjackModal from '@/components/cove/blackjack/BlackjackModal';
import HoldemModal from '@/components/cove/holdem/HoldemModal';
import BaccaratModal from '@/components/cove/baccarat/BaccaratModal';
import CoveMobileControls from '@/components/cove/CoveMobileControls';
import SupportLauncher from '@/components/support/SupportLauncher';
import { useAvatar } from '@/hooks/use-avatar';
import { useGameStore } from '@/stores/game';
import { useCoveStore } from '@/stores/cove';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { MAP_WIDTH, MAP_HEIGHT } from '@/lib/pixi/tilemap-data';

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
// The cove exit sits at WORLD (−3760, 0) — invariant across world grows.
// Derived from the map center so a future grow re-centers automatically:
//   game-px x = MAP_WIDTH/2 − 3760,  game-px y = MAP_HEIGHT/2 (center row).
// Phase 0 land (2026-06-15): center 5760→9216 ⇒ exit (2000,5760)→(5456,9216).
//   Cove zone (slot 9 W) world center = −4160 wu; exit = 400 wu east → −3760 wu.
// ---------------------------------------------------------------------------
const COVE_EXIT_PX = { x: MAP_WIDTH / 2 - 3760, y: MAP_HEIGHT / 2 };

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function CovePage() {
  const { triggerTransition } = useSceneTransition();
  const isMobile = useIsMobile();

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

  // ── Table deep-link: /cove?table=blackjack|holdem|baccarat ─────────────────
  // Opens that table's modal directly on load. Shareable links for players,
  // and the deterministic entry point browser tests need — the modals are
  // otherwise reachable only by walking the avatar to a 3D hotspot, which
  // automation can't do reliably. The opener arg is only the INITIAL HUD
  // balance (each modal re-derives the real balance from its own API
  // responses), so firing before the avatar query settles is harmless.
  const tableDeepLinkFiredRef = useRef(false);
  useEffect(() => {
    if (tableDeepLinkFiredRef.current) return;
    tableDeepLinkFiredRef.current = true;
    const table = new URLSearchParams(window.location.search).get('table');
    if (!table) return;
    const balance = avatar?.clawTokens ?? 0;
    const cove = useCoveStore.getState();
    if (table === 'holdem') cove.openHoldemTable(balance);
    else if (table === 'blackjack') cove.openBlackjackTable(balance);
    else if (table === 'baccarat') cove.openBaccaratTable(balance);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      {/* Support — floating top-right (clear of Back-to-World top-left + the
          bottom joystick zones). DOM overlay, never inside the WebGPU canvas. */}
      <SupportLauncher variant="floating" context={{ page: 'cove' }} defaultCategory="gameplay" />

      {/* Top-right actions — betting history + provably-fair verifier. */}
      {(() => {
        const pill = {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '10px 16px',
          background: 'rgba(10, 0, 21, 0.82)',
          backdropFilter: 'blur(6px)',
          border: '1px solid rgba(0, 255, 224, 0.35)',
          borderRadius: 10,
          color: '#00ffe0',
          fontWeight: 700,
          fontSize: 13,
          fontFamily: 'monospace',
          textDecoration: 'none',
          letterSpacing: '0.04em',
          whiteSpace: 'nowrap' as const,
        };
        return (
          <div
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              zIndex: 50,
              display: 'flex',
              gap: 8,
            }}
          >
            <Link href="/cove/history" target="_blank" rel="noopener noreferrer" style={pill}>
              📜 History
            </Link>
            <Link href="/cove/verify" target="_blank" rel="noopener noreferrer" style={pill}>
              🔐 Verify
            </Link>
          </div>
        );
      })()}

      {/* 2D Slot Screen Modal — DOM overlay, renders on top of 3D canvas.
          z-index 9990 ensures it layers above the Canvas (z-index ~0) but below
          browser UI. The 3D interior stays mounted and rendering underneath. */}
      <SlotScreenModal />

      {/* Phase 6.4.0 — Blackjack table modal (display shell, fun-money only).
          Same z-index as slot modal so only one game modal is open at a time.
          Real engine + per-card decisions land in Phase 6.4.1. */}
      <BlackjackModal />

      {/* Phase 6.5.1 — Texas Hold'em table modal (REAL No-Limit engine,
          server-authoritative, ClawToken stack custody, 5 deterministic bots).
          Same z-index policy as the other game modals. Connected-agent
          WebSocket protocol + real-money SOL/USDC land in Phase 6.5.2 / 6.5.4. */}
      <HoldemModal />

      {/* Phase 6.6.1 — Baccarat (Punto Banco) table modal (REAL engine,
          server-authoritative, ClawToken fun-money tier, 8-deck commit-reveal
          shoe). Same z-index policy as the other game modals so only one game
          modal is open at a time. SOL/USDC + connected-agent protocol land in
          a later phase (currency seam returns 501 today). */}
      <BaccaratModal />

      {/* iPad / phone touch controls — auto-hidden on desktop via useIsMobile.
          Critical fix 2026-05-27: cove had zero touch input; iPad users
          could see the scene but not move. */}
      <CoveMobileControls />

      {/* Interior branding — bottom-center. Hidden on mobile so it doesn't
          sit visually over the CoveMobileControls joystick zones (each zone
          is 50vw × 240px from bottom, meeting at center where this banner
          lives). Desktop only — decoration, not load-bearing. */}
      {!isMobile && (
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
              Slots · Blackjack · Hold&apos;em · Baccarat
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
