'use client';

import { useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import SceneTransition, { useSceneTransition } from '@/components/transitions/SceneTransition';
import { avatarPositionRef, useGameStore } from '@/stores/game';
import { useAvatar } from '@/hooks/use-avatar';
import KelpRealmMobileControls from '@/components/kelp/KelpRealmMobileControls';
import { MAP_HEIGHT, MAP_WIDTH } from '@/lib/pixi/tilemap-data';
import { KELP_FOREST_EXIT_WORLD } from '@/lib/three/kelp-forest-location';

const KELP_EXIT_PX = Object.freeze({
  x: MAP_WIDTH / 2 + KELP_FOREST_EXIT_WORLD.x,
  y: MAP_HEIGHT / 2 + KELP_FOREST_EXIT_WORLD.z,
});

const KelpRealmCanvas = dynamic(() => import('@/components/three/KelpRealmCanvas'), {
  ssr: false,
  loading: () => <div style={{ position: 'absolute', inset: 0, background: '#031b20' }} />,
});

export default function KelpPage() {
  const { triggerTransition } = useSceneTransition();
  const { data: avatar } = useAvatar();
  useEffect(() => {
    if (!avatar) return;
    useGameStore.getState().setAvatarAppearance(avatar.species, avatar.color, undefined, avatar.modelKey);
  }, [avatar]);
  const handleBack = useCallback(() => {
    triggerTransition({
      to: '/game',
      onMidway: () => {
        avatarPositionRef.x = KELP_EXIT_PX.x;
        avatarPositionRef.y = KELP_EXIT_PX.y;
        useGameStore.getState().setAvatarPosition(KELP_EXIT_PX.x, KELP_EXIT_PX.y);
      },
    });
  }, [triggerTransition]);

  return (
    <main
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#031b20', color: '#c7fff4', fontFamily: 'monospace' }}
    >
      <div style={{ position: 'absolute', inset: 0 }}><KelpRealmCanvas /></div>
      <SceneTransition fadeInOnMount />
      <button
        type="button"
        onClick={handleBack}
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 50,
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
      <KelpRealmMobileControls />
    </main>
  );
}
