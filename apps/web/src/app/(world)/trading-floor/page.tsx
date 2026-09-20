'use client';

/**
 * Trading Floor interior — /trading-floor route
 *
 * DOM/HUD layer only. The `(world)` layout owns the persistent render slot and
 * the shared Canvas; the 3D room lives in
 * `lib/three/trading-floor/trading-floor-interior.tsx`.
 *
 * Founder order 2026-09-19: the Trading Floor becomes a place you WALK INTO,
 * like the cove, with a monitor you walk up to. The panel itself is unchanged —
 * this page mounts the SAME `ExchangeModal` the sidebar row opens, so the
 * in-world monitor and the menu share one component and one data path.
 */

import { useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import TradingFloorMobileControls from '@/components/trading-floor/TradingFloorMobileControls';
import { useAvatar } from '@/hooks/use-avatar';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { MAP_HEIGHT, MAP_WIDTH } from '@/lib/pixi/tilemap-data';
import {
  TRADING_FLOOR_EXIT_WORLD_X,
  TRADING_FLOOR_EXIT_WORLD_Z,
} from '@/lib/three/character-positions';
import { onTradingFloorExitRequest } from '@/lib/three/trading-floor/trading-floor-exit-intent';
import { requestWorldStageNavigation } from '@/components/three/world-stage/stage-navigation';
import { avatarPositionRef, useGameStore } from '@/stores/game';
import { useNpcStore } from '@/stores/npc';

const ExchangeModal = dynamic(
  () => import('@/components/game/exchange-modal'),
  { ssr: false },
);

/**
 * Where the avatar lands on exit, in game-px. The WORLD point is owned by
 * `character-positions.ts` and pinned by trading-floor-exit-spawn.test.ts:
 * clear of the door's entry-prompt band AND of the resident's talk radius, so
 * stepping out never re-prompts the door you just came through — the exact
 * trap the cove's hand-set exit fell into (founder-reported 2026-09-18).
 */
const TRADING_FLOOR_EXIT_PX = {
  x: MAP_WIDTH / 2 + TRADING_FLOOR_EXIT_WORLD_X,
  y: MAP_HEIGHT / 2 + TRADING_FLOOR_EXIT_WORLD_Z,
};

export default function TradingFloorPage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const { data: avatar } = useAvatar();

  // Mirror /game and /cove: push the authenticated avatar into the game store
  // on every mount so a direct nav here never renders the default model.
  useEffect(() => {
    if (!avatar) return;
    useGameStore
      .getState()
      .setAvatarAppearance(
        avatar.species,
        avatar.color,
        undefined,
        avatar.modelKey,
      );
  }, [avatar]);

  const handleBack = useCallback(() => {
    if (typeof document !== 'undefined') document.body.style.cursor = 'default';
    // Close the panel on the way out; leaving it open would drop the player
    // back on /game behind a full-screen modal.
    useGameStore.getState().closeExchange();
    // Runs on EVERY exit path — fade midpoint, expiry, and refusal. The cove
    // only placed the avatar at the midpoint, so an expired navigation returned
    // the player to /game at whatever position it last held.
    const placeAtExit = () => {
      avatarPositionRef.x = TRADING_FLOOR_EXIT_PX.x;
      avatarPositionRef.y = TRADING_FLOOR_EXIT_PX.y;
      useGameStore
        .getState()
        .setAvatarPosition(TRADING_FLOOR_EXIT_PX.x, TRADING_FLOOR_EXIT_PX.y);
      // NPC mode (guests): the possessed body owns the position and would drag
      // the avatar back to the door on the next frame.
      useNpcStore
        .getState()
        .placePlayerNpc(TRADING_FLOOR_EXIT_PX.x, TRADING_FLOOR_EXIT_PX.y);
    };
    const requested = requestWorldStageNavigation({
      to: '/game',
      onMidway: placeAtExit,
      onExpired: () => {
        if (
          typeof window !== 'undefined' &&
          window.location.pathname === '/trading-floor'
        ) {
          placeAtExit();
          router.push('/game');
        }
      },
    });
    if (!requested) {
      placeAtExit();
      router.push('/game');
    }
  }, [router]);

  // The in-world door hotspot publishes an intent; this page performs it.
  useEffect(() => onTradingFloorExitRequest(handleBack), [handleBack]);

  return (
    <div
      className="game-container"
      style={{
        background: 'transparent',
        overflow: 'hidden',
        color: '#bff4ff',
        fontFamily: 'monospace',
      }}
    >
      <button
        type="button"
        onClick={handleBack}
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 50,
          minHeight: 44,
          padding: '10px 18px',
          border: '1px solid rgba(90,226,255,0.5)',
          borderRadius: 10,
          background: 'rgba(6,18,30,0.86)',
          color: '#bff4ff',
          font: '700 14px monospace',
          letterSpacing: '0.04em',
          cursor: 'pointer',
        }}
      >
        Back to World
      </button>

      {/* The Trading Floor panel — the SAME modal the sidebar opens. */}
      <ExchangeModal />

      <TradingFloorMobileControls />

      {/* Desktop hint strip. Hidden on touch so it never sits over the
          joystick zones, which meet at bottom-centre. */}
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
              background: 'rgba(6,18,30,0.75)',
              border: '1px solid rgba(90,226,255,0.25)',
              borderRadius: 8,
              padding: '6px 20px',
            }}
          >
            <span style={{ color: '#5ae2ff', fontWeight: 700, fontSize: 13 }}>
              Trading Floor
            </span>
            <span
              style={{
                color: 'rgba(255,255,255,0.4)',
                fontSize: 11,
                marginLeft: 8,
              }}
            >
              WASD to walk · E at the monitor to manage trades
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
