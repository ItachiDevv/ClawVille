'use client';

import {
  useCallback,
  useEffect,
} from 'react';
import { useRouter } from 'next/navigation';
import KelpRealmMobileControls from '@/components/kelp/KelpRealmMobileControls';
import { KelpRealmClaimHud } from '@/components/kelp/KelpRealmClaimHud';
import { useAvatar } from '@/hooks/use-avatar';
import { MAP_HEIGHT, MAP_WIDTH } from '@/lib/pixi/tilemap-data';
import { KELP_FOREST_EXIT_WORLD } from '@/lib/three/kelp-forest-location';
import {
  requestWorldStageNavigation,
} from '@/components/three/world-stage/stage-navigation';
import { avatarPositionRef, useGameStore } from '@/stores/game';

const KELP_EXIT_PX = Object.freeze({
  x: MAP_WIDTH / 2 + KELP_FOREST_EXIT_WORLD.x,
  y: MAP_HEIGHT / 2 + KELP_FOREST_EXIT_WORLD.z,
});

export default function KelpPage() {
  const router = useRouter();
  const { data: avatar } = useAvatar();

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
    const teleport = () => {
      avatarPositionRef.x = KELP_EXIT_PX.x;
      avatarPositionRef.y = KELP_EXIT_PX.y;
      useGameStore
        .getState()
        .setAvatarPosition(KELP_EXIT_PX.x, KELP_EXIT_PX.y);
    };
    const requested = requestWorldStageNavigation({
      to: '/game',
      onMidway: teleport,
      onExpired: () => {
        if (
          typeof window !== 'undefined' &&
          window.location.pathname === '/kelp'
        ) {
          teleport();
          router.push('/game');
        }
      },
    });
    if (!requested) {
      teleport();
      router.push('/game');
    }
  }, [router]);

  return (
    <div
      className="game-container"
      style={{
        background: 'transparent',
        overflow: 'hidden',
        color: '#c7fff4',
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
          border: '1px solid rgba(72,255,222,0.5)',
          borderRadius: 10,
          background: 'rgba(1,18,17,0.82)',
          color: '#70ffe2',
          font: '700 14px monospace',
          cursor: 'pointer',
        }}
      >
        Back to the Reef
      </button>
      <KelpRealmClaimHud />
      <KelpRealmMobileControls />
    </div>
  );
}
